// Shared state types for the Ping/Ponder travel planning pipeline.
//
// This module is deliberately dependency-free (no `fs`, no SDK imports) so it
// can be imported from client components, client-side agent tools and server
// routes alike. The server-only store lives in ./stateStore.

export type SlotStatus = 'empty' | 'proposed' | 'confirmed';
export type ItemStatus = 'proposed' | 'confirmed';

/** Who wrote a value. Used by the UI to show what Ponder produced in the background. */
export type ValueSource = 'ping' | 'ponder' | 'system';

export type IntentSlotName =
  | 'destination'
  | 'when'
  | 'duration'
  | 'budget'
  | 'people'
  | 'other';

export type PlanCategory =
  | 'cities'
  | 'attractions'
  | 'food'
  | 'itinerary'
  | 'accommodation'
  | 'events'
  | 'other';

export type ConversationPhase =
  | 'intent_clarification'
  | 'plan_sharing'
  | 'refinement'
  | 'final';

export type IntentStatus =
  | 'unclear'
  | 'partially_clear'
  | 'clear'
  | 'refined'
  | 'locked';

export interface StateSlot {
  value: string;
  status: SlotStatus;
  source: ValueSource;
  updatedAt: number;
}

export interface StateItem {
  value: string;
  status: ItemStatus;
  source: ValueSource;
  addedAt: number;
}

export interface TravelState {
  intent_clarification: Record<IntentSlotName, StateSlot>;
  plan_sharing: Record<PlanCategory, StateItem[]>;
  meta: {
    conversation_phase: ConversationPhase;
    intent_status: IntentStatus;
    /** Bumped on every mutation so clients can cheaply detect background progress. */
    version: number;
    updatedAt: number;
  };
}

export const INTENT_SLOT_NAMES: IntentSlotName[] = [
  'destination',
  'when',
  'duration',
  'budget',
  'people',
  'other',
];

export const PLAN_CATEGORIES: PlanCategory[] = [
  'cities',
  'attractions',
  'food',
  'itinerary',
  'accommodation',
  'events',
  'other',
];

/**
 * Slots that must be filled before intent is considered complete.
 *
 * `other` is intentionally excluded: it is a free-form catch-all that most
 * conversations never populate, so including it meant `isIntentComplete()`
 * could never return true and the phase transition never fired on its own.
 */
export const REQUIRED_INTENT_SLOTS: IntentSlotName[] = [
  'destination',
  'when',
  'duration',
  'budget',
  'people',
];

/** Minimum item count per plan category before the plan counts as "fully populated". */
export const PLAN_MIN_ITEMS: Record<PlanCategory, number> = {
  cities: 1,
  attractions: 3,
  food: 2,
  itinerary: 1,
  accommodation: 2,
  events: 1,
  other: 0,
};

export function isIntentSlotName(name: string): name is IntentSlotName {
  return (INTENT_SLOT_NAMES as string[]).includes(name);
}

export function isPlanCategory(name: string): name is PlanCategory {
  return (PLAN_CATEGORIES as string[]).includes(name);
}

export function createDefaultState(now: number = Date.now()): TravelState {
  const emptySlot = (): StateSlot => ({
    value: '',
    status: 'empty',
    source: 'system',
    updatedAt: now,
  });

  return {
    intent_clarification: {
      destination: emptySlot(),
      when: emptySlot(),
      duration: emptySlot(),
      budget: emptySlot(),
      people: emptySlot(),
      other: emptySlot(),
    },
    plan_sharing: {
      cities: [],
      attractions: [],
      food: [],
      itinerary: [],
      accommodation: [],
      events: [],
      other: [],
    },
    meta: {
      conversation_phase: 'intent_clarification',
      intent_status: 'unclear',
      version: 0,
      updatedAt: now,
    },
  };
}

/**
 * Coerce an arbitrary parsed JSON blob into a well-formed TravelState.
 * Used when loading state written by an older build of this app.
 */
export function normalizeState(raw: unknown, now: number = Date.now()): TravelState {
  const base = createDefaultState(now);
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Record<string, any>;

  const intent = input.intent_clarification;
  if (intent && typeof intent === 'object') {
    for (const name of INTENT_SLOT_NAMES) {
      const slot = intent[name];
      if (!slot || typeof slot !== 'object') continue;
      base.intent_clarification[name] = {
        value: typeof slot.value === 'string' ? slot.value : '',
        status:
          slot.status === 'proposed' || slot.status === 'confirmed'
            ? slot.status
            : 'empty',
        source: slot.source === 'ping' || slot.source === 'ponder' ? slot.source : 'system',
        updatedAt: typeof slot.updatedAt === 'number' ? slot.updatedAt : now,
      };
    }
  }

  const plan = input.plan_sharing;
  if (plan && typeof plan === 'object') {
    for (const category of PLAN_CATEGORIES) {
      const items = plan[category];
      if (!Array.isArray(items)) continue;
      base.plan_sharing[category] = items
        .filter((item) => item && typeof item === 'object' && typeof item.value === 'string')
        .map((item) => ({
          value: item.value as string,
          status: item.status === 'confirmed' ? 'confirmed' : 'proposed',
          source:
            item.source === 'ping' || item.source === 'ponder' ? item.source : 'system',
          addedAt: typeof item.addedAt === 'number' ? item.addedAt : now,
        }));
    }
  }

  const meta = input.meta;
  if (meta && typeof meta === 'object') {
    const phases: ConversationPhase[] = [
      'intent_clarification',
      'plan_sharing',
      'refinement',
      'final',
    ];
    const statuses: IntentStatus[] = [
      'unclear',
      'partially_clear',
      'clear',
      'refined',
      'locked',
    ];
    if (phases.includes(meta.conversation_phase)) {
      base.meta.conversation_phase = meta.conversation_phase;
    }
    if (statuses.includes(meta.intent_status)) {
      base.meta.intent_status = meta.intent_status;
    }
    if (typeof meta.version === 'number') base.meta.version = meta.version;
    if (typeof meta.updatedAt === 'number') base.meta.updatedAt = meta.updatedAt;
  }

  return base;
}

export interface DerivedState {
  phase: ConversationPhase;
  intentStatus: IntentStatus;
  emptySlots: IntentSlotName[];
  isComplete: boolean;
  /** Categories still short of PLAN_MIN_ITEMS. */
  planGaps: PlanCategory[];
  planItemCount: number;
  isPlanComplete: boolean;
  version: number;
  updatedAt: number;
}

export function deriveState(state: TravelState): DerivedState {
  const emptySlots = INTENT_SLOT_NAMES.filter(
    (name) => state.intent_clarification[name].status === 'empty',
  );

  const isComplete = REQUIRED_INTENT_SLOTS.every(
    (name) => state.intent_clarification[name].status !== 'empty',
  );

  const planGaps = PLAN_CATEGORIES.filter(
    (category) => state.plan_sharing[category].length < PLAN_MIN_ITEMS[category],
  );

  const planItemCount = PLAN_CATEGORIES.reduce(
    (total, category) => total + state.plan_sharing[category].length,
    0,
  );

  return {
    phase: state.meta.conversation_phase,
    intentStatus: state.meta.intent_status,
    emptySlots,
    isComplete,
    planGaps,
    planItemCount,
    isPlanComplete: planGaps.length === 0,
    version: state.meta.version,
    updatedAt: state.meta.updatedAt,
  };
}
