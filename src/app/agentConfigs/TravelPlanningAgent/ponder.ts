// SERVER-ONLY Ponder engine: the reasoning half of Ping/Ponder.
//
// This used to run in the browser as a RealtimeAgent tool, which is why none of
// its state writes ever landed (it called the server-only state manager from a
// context where every method short-circuits). Running it here means its tool
// calls mutate the real store, so background plan population actually works.
//
// Two modes:
//   'sync'  -- the sequential baseline. Ping blocks until this returns prose.
//   'async' -- the parallel pipeline. Fired and forgotten; Ponder's job is to
//              fill plan state while Ping keeps talking to the user.

import OpenAI from 'openai';

import {
  accommodationOptionsDB,
  attractionsDB,
  durationRecommendationsDB,
  eventsDB,
  foodRecommendationsDB,
  popularCountriesDB,
  transportOptionsDB,
} from './LookupData';
import * as store from './stateStore';
import {
  deriveState,
  PLAN_CATEGORIES,
  PLAN_MIN_ITEMS,
  type PlanCategory,
} from './stateTypes';
import { record } from '@/app/lib/metrics';

export const PONDER_MODEL = process.env.PONDER_MODEL || 'gpt-4.1';

/**
 * Simulated network latency for the stubbed `webSearch` tool.
 *
 * The lookup DBs answer instantly, which would make Ponder unrealistically
 * cheap and understate the latency the parallel pipeline hides. A real
 * deployment would call a live search API here; this models that cost so the
 * comparison is meaningful. Results are always tagged `simulated: true`.
 */
const SIMULATED_SEARCH_LATENCY_MS = Number(
  process.env.PONDER_SIMULATED_TOOL_LATENCY_MS ?? 500,
);

/** Hard stop on the reasoning loop so a confused model cannot spin forever. */
const MAX_TOOL_ITERATIONS = 8;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SHARED_DOMAIN_RULES = `
==== Domain Rules ====
- You are a travel planning expert working for TravelPlanner.
- Always call a lookup tool before stating facts about destinations, attractions,
  costs or events. Never rely on your own knowledge for those.
- Record everything you learn into state: updateSlot for intent slots,
  addPlanItem for plan categories. Tag machine-generated values as "proposed";
  only mark "confirmed" once the user has explicitly accepted them.
- MULTILINGUAL: detect the user's language (English/Japanese) and write in it.
  For Japanese use polite form (keigo where natural).
- Do not discuss politics, religion, medical, legal or financial advice.
`;

const SYNC_INSTRUCTIONS = `You are the Ponder agent: an expert travel planning supervisor guiding a junior
voice agent (Ping) that is talking to the user right now.

Your output is read VERBATIM by Ping, out loud, so:
- Keep it to two or three sentences. Prose only, never bulleted lists.
- Mention at most a couple of specific items and summarize the rest.

Workflow for every call:
1. readState to see what is already known.
2. Fill gaps with lookup tools, then write results into state.
3. Produce the single next thing Ping should say.
${SHARED_DOMAIN_RULES}`;

const ASYNC_INSTRUCTIONS = `You are the Ponder agent running as a BACKGROUND worker. Ping is already
talking to the user without waiting for you -- you are not on the critical path
and your prose will probably never be spoken.

Your job is to make state as complete as possible, as fast as possible:
1. readState first.
2. Call lookup tools to fill every thin plan category: cities, attractions,
   food, itinerary, accommodation, events.
3. Write each finding with addPlanItem(status="proposed"). Aim for at least
   3 attractions, 2 food, 2 accommodation, 1 city, 1 itinerary, 1 event.
4. If the lookup DB has nothing for this destination, use webSearch.
5. When all required intent slots are filled, call updatePhase to move to
   plan_sharing.

Finish with one short sentence summarizing what you added. Do not address the
user directly and do not ask questions -- Ping owns the conversation.
${SHARED_DOMAIN_RULES}`;

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI Responses API function format)
// ---------------------------------------------------------------------------

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'function' as const,
    name,
    // `strict: false` is explicit and load-bearing: several of these tools have
    // genuinely optional parameters, and strict mode requires `required` to
    // list every key in `properties`.
    strict: false,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export const ponderTools = [
  fn('readState', 'Read the full current travel planning state.', {}),
  fn('getEmptySlots', 'List intent slots that are still empty.', {}),
  fn('getPlanGaps', 'List plan categories that still need more items.', {}),
  fn(
    'updateSlot',
    'Write a value into an intent clarification slot.',
    {
      slotName: str('One of: destination, when, duration, budget, people, other'),
      value: str('The value to store'),
      status: {
        type: 'string',
        enum: ['proposed', 'confirmed'],
        description: 'proposed for your own suggestions, confirmed for user-stated facts',
      },
    },
    ['slotName', 'value', 'status'],
  ),
  fn(
    'addPlanItem',
    'Add one item to a plan category. Call once per item.',
    {
      category: {
        type: 'string',
        enum: PLAN_CATEGORIES,
        description: 'Which plan category to add to',
      },
      value: str('Short human-readable item, e.g. "Eiffel Tower"'),
      status: {
        type: 'string',
        enum: ['proposed', 'confirmed'],
        description: 'proposed unless the user already accepted it',
      },
    },
    ['category', 'value', 'status'],
  ),
  fn(
    'updatePhase',
    'Move the conversation to a new phase and/or intent status.',
    {
      conversation_phase: {
        type: 'string',
        enum: ['intent_clarification', 'plan_sharing', 'refinement', 'final'],
        description: 'The phase to move to',
      },
      intent_status: {
        type: 'string',
        enum: ['unclear', 'partially_clear', 'clear', 'refined', 'locked'],
        description: 'How well understood the user intent is',
      },
    },
  ),
  fn(
    'popularCountries',
    'Popular countries filtered by region, season and budget tier.',
    {
      region: str('e.g. Europe, Asia, Americas, Africa, Oceania'),
      season: str('e.g. Summer, Winter, Spring, Autumn'),
      budgetTier: str('low, medium or high'),
    },
  ),
  fn(
    'durationRecommendation',
    'Recommended trip length for a number of countries.',
    {
      numberOfCountries: num('How many countries the trip covers'),
      season: str('Season of travel'),
      tripType: str('leisure, adventure or cultural'),
    },
    ['numberOfCountries'],
  ),
  fn(
    'attractions',
    'Attractions for a country, optionally narrowed by city and season.',
    { country: str('Country name'), city: str('City name'), season: str('Season') },
    ['country'],
  ),
  fn(
    'foodRecommendations',
    'Cuisine and dish recommendations for a country.',
    { country: str('Country name'), city: str('City name') },
    ['country'],
  ),
  fn(
    'transportOptions',
    'Transport options between two cities.',
    { origin: str('Origin city'), destination: str('Destination city') },
    ['origin', 'destination'],
  ),
  fn(
    'accommodationOptions',
    'Accommodation options for a city.',
    { city: str('City name'), hotelTier: str('budget, mid-range or luxury') },
    ['city'],
  ),
  fn(
    'eventsAndFestivals',
    'Events and festivals for a city, optionally in a specific month.',
    { city: str('City name'), month: num('Month 1-12') },
    ['city'],
  ),
  fn(
    'budgetEstimator',
    'Estimate total trip cost from destinations and duration.',
    {
      destinations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Destination cities or countries',
      },
      duration: num('Trip length in days'),
      season: str('Season of travel'),
    },
    ['destinations', 'duration'],
  ),
  fn(
    'webSearch',
    'Fallback search for when the lookup database has no data for a destination.',
    {
      query: str('Search query'),
      searchType: {
        type: 'string',
        enum: ['attractions', 'food', 'accommodation', 'events', 'transport', 'general'],
        description: 'Kind of information wanted',
      },
    },
    ['query', 'searchType'],
  ),
];

// ---------------------------------------------------------------------------
// Lookup implementations
// ---------------------------------------------------------------------------

const eq = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

function lookupPopularCountries(args: any) {
  let results = popularCountriesDB;
  if (args.region) results = results.filter((c) => eq(c.region, args.region));
  if (args.season) results = results.filter((c) => c.seasonSuitability.includes(args.season));
  if (args.budgetTier) {
    const ceilings: Record<string, number> = { low: 100, medium: 200, high: Infinity };
    const ceiling = ceilings[String(args.budgetTier).toLowerCase()];
    if (ceiling !== undefined) {
      results = results.filter((c) => (c.avgDailyCostUSD ?? 0) <= ceiling);
    }
  }
  return results.slice(0, 5);
}

function lookupDuration(args: any) {
  const wanted = Number(args.numberOfCountries) || 1;
  const exact = durationRecommendationsDB.filter((d) => d.numberOfCountries === wanted);
  const pool = exact.length > 0 ? exact : durationRecommendationsDB;
  if (args.tripType) {
    const typed = pool.filter((d) => eq(d.tripType, args.tripType));
    if (typed.length > 0) return typed.slice(0, 3);
  }
  return pool.slice(0, 3);
}

function lookupAttractions(args: any) {
  let results = attractionsDB;
  if (args.country) results = results.filter((a) => eq(a.country, args.country));
  if (args.city) results = results.filter((a) => eq(a.city, args.city));
  if (args.season) {
    results = results.filter(
      (a) => a.seasonalSuitability.includes(args.season) || a.seasonalSuitability.includes('All'),
    );
  }
  return results.slice(0, 6);
}

function lookupFood(args: any) {
  let results = foodRecommendationsDB;
  if (args.country) results = results.filter((f) => eq(f.country, args.country));
  if (args.city) results = results.filter((f) => !f.city || eq(f.city, args.city));
  return results.slice(0, 4);
}

function lookupTransport(args: any) {
  let results = transportOptionsDB;
  if (args.origin) results = results.filter((t) => eq(t.origin, args.origin));
  if (args.destination) results = results.filter((t) => eq(t.destination, args.destination));
  return results.slice(0, 4);
}

function lookupAccommodation(args: any) {
  let results = accommodationOptionsDB;
  if (args.city) results = results.filter((a) => eq(a.city, args.city));
  if (args.hotelTier) results = results.filter((a) => eq(a.hotelTier, args.hotelTier));
  return results.slice(0, 4);
}

function lookupEvents(args: any) {
  let results = eventsDB;
  if (args.city) results = results.filter((e) => eq(e.city, args.city));
  if (args.month) results = results.filter((e) => e.month === Number(args.month));
  return results.slice(0, 4);
}

function estimateBudget(args: any) {
  const destinations: string[] = Array.isArray(args.destinations) ? args.destinations : [];
  const duration = Math.max(1, Number(args.duration) || 1);

  // Daily rate: average the known country cost for each named destination,
  // falling back to the DB-wide average when we have no match.
  const dbAverage =
    popularCountriesDB.reduce((total, c) => total + (c.avgDailyCostUSD ?? 0), 0) /
    Math.max(1, popularCountriesDB.length);

  const rates = destinations.map((name) => {
    const match = popularCountriesDB.find(
      (c) => eq(c.country, name) || String(name).toLowerCase().includes(c.country.toLowerCase()),
    );
    return match?.avgDailyCostUSD ?? dbAverage;
  });

  const dailyRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : dbAverage;
  const seasonMultiplier = /summer|peak/i.test(String(args.season ?? '')) ? 1.2 : 1;
  const estimate = Math.round(dailyRate * duration * seasonMultiplier);

  return {
    destinations,
    duration,
    estimatedDailyUSD: Math.round(dailyRate * seasonMultiplier),
    estimatedTotalUSD: estimate,
    note: 'Lodging, food and local transport. Excludes international flights.',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stubbed search. Returns plausible, clearly-labelled placeholders after a
 * simulated network delay. Replace with a real search API for production use.
 */
async function webSearch(query: string, searchType: string) {
  await sleep(SIMULATED_SEARCH_LATENCY_MS);

  const subject = query.replace(/\b(top|best|in|for|and|the)\b/gi, '').trim() || 'this destination';
  const templates: Record<string, string[]> = {
    attractions: ['Historic old town', 'Main national museum', 'Central viewpoint walk'],
    food: ['Signature regional dish', 'Central food market', 'Traditional family restaurant'],
    accommodation: ['Well-reviewed central hotel', 'Budget guesthouse near transit'],
    events: ['Seasonal local festival'],
    transport: ['Regional rail connection', 'Airport transfer by express train'],
    general: ['Best months to visit', 'Local transit basics'],
  };

  const base = templates[searchType] ?? templates.general;
  return {
    simulated: true,
    query,
    searchType,
    results: base.map((item) => `${item} (${subject})`),
  };
}

// ---------------------------------------------------------------------------
// Background plan population
// ---------------------------------------------------------------------------

/**
 * Deterministically fill thin plan categories from the lookup DBs.
 *
 * Runs before the model in async mode so the parallel pipeline makes visible
 * progress even if the model decides to be lazy. Idempotent: addPlanItem
 * de-duplicates by value.
 */
export async function autoPopulatePlan(sessionId: string): Promise<number> {
  const state = await store.readState(sessionId);
  const destination = state.intent_clarification.destination.value.trim();
  if (!destination) return 0;

  const derived = deriveState(state);
  if (derived.planGaps.length === 0) return 0;

  const season = state.intent_clarification.when.value || undefined;
  const gaps = new Set<PlanCategory>(derived.planGaps);
  const countBefore = derived.planItemCount;

  const add = async (category: PlanCategory, value: string) => {
    try {
      await store.addPlanItem(sessionId, category, value, 'proposed', 'ponder');
    } catch (error) {
      console.error(`[ponder] autoPopulate failed for ${category}`, error);
    }
  };

  // Attractions and cities come straight out of the DB when we know the country.
  const dbAttractions = lookupAttractions({ country: destination, season });
  if (gaps.has('attractions')) {
    for (const attraction of dbAttractions.slice(0, PLAN_MIN_ITEMS.attractions)) {
      await add('attractions', attraction.name);
    }
  }
  if (gaps.has('cities')) {
    const cities = Array.from(new Set(dbAttractions.map((a) => a.city))).slice(0, 2);
    for (const city of cities.length > 0 ? cities : [destination]) {
      await add('cities', city);
    }
  }
  if (gaps.has('food')) {
    for (const food of lookupFood({ country: destination }).slice(0, PLAN_MIN_ITEMS.food)) {
      await add('food', `${food.cuisineType}: ${food.dishExamples.slice(0, 2).join(', ')}`);
    }
  }

  // Accommodation and events are keyed by city, so use whatever cities we have.
  const knownCities = (await store.readState(sessionId)).plan_sharing.cities.map((c) => c.value);
  const cityForLookup = knownCities[0] ?? destination;

  if (gaps.has('accommodation')) {
    const options = lookupAccommodation({ city: cityForLookup });
    for (const option of options.slice(0, PLAN_MIN_ITEMS.accommodation)) {
      await add('accommodation', `${option.hotelTier} in ${option.city} (~$${option.avgCostUSD}/night)`);
    }
    if (options.length === 0) {
      const search = await webSearch(`hotels in ${cityForLookup}`, 'accommodation');
      for (const result of search.results.slice(0, PLAN_MIN_ITEMS.accommodation)) {
        await add('accommodation', result);
      }
    }
  }

  if (gaps.has('events')) {
    const events = lookupEvents({ city: cityForLookup });
    if (events.length > 0) {
      for (const event of events.slice(0, PLAN_MIN_ITEMS.events)) {
        await add('events', `${event.name} (${event.city}, month ${event.month})`);
      }
    } else {
      const search = await webSearch(`festivals in ${cityForLookup} ${season ?? ''}`, 'events');
      for (const result of search.results.slice(0, PLAN_MIN_ITEMS.events)) {
        await add('events', result);
      }
    }
  }

  if (gaps.has('itinerary')) {
    const duration = state.intent_clarification.duration.value || 'multi-day';
    await add('itinerary', `${duration} in ${destination}, based around ${cityForLookup}`);
  }

  // Count once at the end rather than probing the store per item: addPlanItem
  // de-duplicates, so the net delta is the only number that means anything.
  const countAfter = deriveState(await store.readState(sessionId)).planItemCount;
  return Math.max(0, countAfter - countBefore);
}

/**
 * Advance the phase once intent is complete. Previously the model had to
 * remember to do this by hand, so it usually fired at the wrong time or not
 * at all.
 */
export async function maybeAdvancePhase(sessionId: string): Promise<void> {
  const { state, derived } = await store.readDerived(sessionId);
  if (derived.phase !== 'intent_clarification') return;

  if (derived.isComplete) {
    await store.updateMeta(sessionId, 'plan_sharing', 'clear');
    return;
  }

  const filled = Object.values(state.intent_clarification).filter(
    (slot) => slot.status !== 'empty',
  ).length;
  if (filled > 0 && derived.intentStatus === 'unclear') {
    await store.updateMeta(sessionId, undefined, 'partially_clear');
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function executeTool(sessionId: string, name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'readState':
      return { state: await store.readState(sessionId) };
    case 'getEmptySlots': {
      const { derived } = await store.readDerived(sessionId);
      return { emptySlots: derived.emptySlots, isComplete: derived.isComplete };
    }
    case 'getPlanGaps': {
      const { derived } = await store.readDerived(sessionId);
      return { planGaps: derived.planGaps, planItemCount: derived.planItemCount };
    }
    case 'updateSlot': {
      await store.updateSlot(sessionId, args.slotName, args.value, args.status, 'ponder');
      await maybeAdvancePhase(sessionId);
      return { success: true };
    }
    case 'addPlanItem': {
      await store.addPlanItem(sessionId, args.category, args.value, args.status, 'ponder');
      return { success: true };
    }
    case 'updatePhase': {
      await store.updateMeta(sessionId, args.conversation_phase, args.intent_status);
      return { success: true };
    }
    case 'popularCountries':
      return lookupPopularCountries(args);
    case 'durationRecommendation':
      return lookupDuration(args);
    case 'attractions':
      return lookupAttractions(args);
    case 'foodRecommendations':
      return lookupFood(args);
    case 'transportOptions':
      return lookupTransport(args);
    case 'accommodationOptions':
      return lookupAccommodation(args);
    case 'eventsAndFestivals':
      return lookupEvents(args);
    case 'budgetEstimator':
      return estimateBudget(args);
    case 'webSearch':
      return webSearch(args.query, args.searchType);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface PonderHistoryItem {
  role: string;
  content: string;
}

export interface PonderRequest {
  sessionId: string;
  scenario: string;
  mode: 'sync' | 'async';
  history?: PonderHistoryItem[];
  relevantContext?: string;
  /**
   * Where to file metrics, if that differs from where state lives. The
   * benchmark runs each arm in an isolated state session but wants all the
   * numbers in the caller's session so the live panel can show them.
   */
  metricsSessionId?: string;
}

export interface PonderResult {
  text: string;
  durationMs: number;
  toolCalls: string[];
  planItemsAdded: number;
  stateVersion: number;
  error?: string;
}

function extractText(output: any[]): string {
  return output
    .filter((item) => item?.type === 'message')
    .map((message: any) =>
      (message.content ?? [])
        .filter((part: any) => part?.type === 'output_text')
        .map((part: any) => part.text)
        .join(''),
    )
    .join('\n')
    .trim();
}

export async function runPonder(request: PonderRequest): Promise<PonderResult> {
  const { sessionId, scenario, mode } = request;
  const metricsSessionId = request.metricsSessionId ?? sessionId;
  const startedAt = Date.now();
  const toolCalls: string[] = [];

  const beforeCount = deriveState(await store.readState(sessionId)).planItemCount;

  // In async mode, do the deterministic fill first so the parallel pipeline
  // shows progress even if the model contributes nothing useful.
  if (mode === 'async') {
    try {
      await autoPopulatePlan(sessionId);
      await maybeAdvancePhase(sessionId);
    } catch (error) {
      console.error('[ponder] autoPopulatePlan failed', error);
    }
  }

  const transcript = (request.history ?? [])
    .map((item) => `${item.role}: ${item.content}`)
    .join('\n');

  const input: any[] = [
    {
      type: 'message',
      role: 'system',
      content: mode === 'sync' ? SYNC_INSTRUCTIONS : ASYNC_INSTRUCTIONS,
    },
    {
      type: 'message',
      role: 'user',
      content: [
        '==== Conversation so far ====',
        transcript || '(no transcript yet)',
        '',
        '==== Newest user context ====',
        request.relevantContext || '(none)',
        '',
        '==== Current state ====',
        JSON.stringify(await store.readState(sessionId), null, 2),
      ].join('\n'),
    },
  ];

  let text = '';
  let failure: string | undefined;

  try {
    let response: any = await openai().responses.create({
      model: PONDER_MODEL,
      input,
      tools: ponderTools as any,
      parallel_tool_calls: false,
      stream: false,
    } as any);

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const output: any[] = response?.output ?? [];
      const calls = output.filter((item) => item?.type === 'function_call');

      if (calls.length === 0) {
        text = extractText(output);
        break;
      }

      for (const call of calls) {
        let args: any = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }

        toolCalls.push(call.name);
        let result: unknown;
        try {
          result = await executeTool(sessionId, call.name, args);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }

        input.push(
          {
            type: 'function_call',
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments,
          },
          {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result),
          },
        );
      }

      response = await openai().responses.create({
        model: PONDER_MODEL,
        input,
        tools: ponderTools as any,
        parallel_tool_calls: false,
        stream: false,
      } as any);

      // Loop exhausted without the model settling on a final message.
      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        text = extractText(response?.output ?? []);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error('[ponder] run failed', error);
  }

  // A final sweep: the model may have filled slots that unlock more DB lookups.
  try {
    await autoPopulatePlan(sessionId);
    await maybeAdvancePhase(sessionId);
  } catch (error) {
    console.error('[ponder] final autoPopulatePlan failed', error);
  }

  const afterState = await store.readState(sessionId);
  const planItemsAdded = deriveState(afterState).planItemCount - beforeCount;
  const durationMs = Date.now() - startedAt;

  record({
    sessionId: metricsSessionId,
    scenario,
    kind: 'ponder_run',
    ms: durationMs,
    detail: { mode, toolCalls: toolCalls.length, planItemsAdded, error: failure },
  });

  if (planItemsAdded > 0) {
    record({
      sessionId: metricsSessionId,
      scenario,
      kind: 'plan_items_added',
      ms: durationMs,
      detail: { count: planItemsAdded, mode },
    });
  }

  return {
    text: text || (failure ? '' : 'Updated the plan in the background.'),
    durationMs,
    toolCalls,
    planItemsAdded,
    stateVersion: afterState.meta.version,
    error: failure,
  };
}
