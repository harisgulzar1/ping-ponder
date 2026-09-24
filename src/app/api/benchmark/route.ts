import { NextRequest, NextResponse } from 'next/server';

import { runPonder, type PonderHistoryItem } from '@/app/agentConfigs/TravelPlanningAgent/ponder';
import {
  clearSession,
  startPonderJob,
  waitForIdle,
} from '@/app/agentConfigs/TravelPlanningAgent/jobs';
import * as store from '@/app/agentConfigs/TravelPlanningAgent/stateStore';
import { computeStats, record } from '@/app/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full two-arm run makes a dozen-plus model calls.
export const maxDuration = 300;

/**
 * Scripted A/B harness for the sequential-vs-parallel latency claim.
 *
 * A live voice demo cannot be a measurement: you can't speak the same sentences
 * twice with the same timing. This replays one fixed script through both
 * orchestrations and reports per-turn numbers you can chart.
 *
 * What is measured for real (real model calls, real tool loops):
 *   blockingMs -- how long the pipeline makes the user wait *in addition to*
 *                 Ping's own response time.
 *                 Sequential: the entire Ponder run, because Ping cannot speak
 *                 until Ponder returns the words for it to say.
 *                 Parallel:   only the kickoff, because Ping answers from state
 *                 while Ponder works.
 *
 * What is modelled, not measured:
 *   pingResponseMs -- the realtime voice model's own time-to-first-audio. It is
 *                 identical in both arms and cannot be driven from the server,
 *                 so it is added as a labelled constant to produce a total.
 *                 Override via `pingResponseMs` in the request body; measure
 *                 your real value from the live turn_latency metric.
 */

const DEFAULT_SCRIPT: string[] = [
  'I want to plan a trip to France',
  'Sometime in the summer',
  'About ten days',
  'My budget is around three thousand dollars',
  "It's just me travelling alone",
  'What do you suggest I actually do there?',
];

/** Documented default for Ping's own latency; override per request. */
const DEFAULT_PING_RESPONSE_MS = 700;

interface TurnResult {
  turn: number;
  userMessage: string;
  blockingMs: number;
  totalUserFacingMs: number;
  planItemCount: number;
  note: string;
}

interface ArmResult {
  pipeline: 'sequential' | 'parallel';
  scenario: string;
  turns: TurnResult[];
  blockingStats: ReturnType<typeof computeStats>;
  totalStats: ReturnType<typeof computeStats>;
  /** Sum of blocking time across the script -- the cumulative cost to the user. */
  totalBlockingMs: number;
  /** Wall clock for the whole arm, including background work. */
  wallClockMs: number;
  /** Background time still running after the last turn (parallel only). */
  drainMs: number;
  finalPlanItemCount: number;
  finalPhase: string;
  planComplete: boolean;
}

function buildHistory(script: string[], upto: number): PonderHistoryItem[] {
  const history: PonderHistoryItem[] = [];
  for (let i = 0; i < upto; i += 1) {
    history.push({ role: 'user', content: script[i] });
    history.push({ role: 'assistant', content: '(acknowledged and asked a follow-up)' });
  }
  return history;
}

async function runSequentialArm(
  sessionId: string,
  script: string[],
  pingResponseMs: number,
  metricsSessionId: string,
): Promise<ArmResult> {
  const scenario = 'travelPlanning';
  clearSession(sessionId);
  await store.resetState(sessionId);

  const startedAt = Date.now();
  const turns: TurnResult[] = [];

  // Stage 1 -- collection. The baseline does no planning at all while it
  // gathers requirements, so these turns are cheap: the user waits only for
  // Ping to speak.
  for (let i = 0; i < script.length; i += 1) {
    const turnStart = Date.now();

    const slotForTurn = inferSlot(script[i]);
    if (slotForTurn) {
      await store.updateSlot(sessionId, slotForTurn.name, slotForTurn.value, 'confirmed', 'ping');
    }

    const blockingMs = Date.now() - turnStart;
    const { derived } = await store.readDerived(sessionId);

    turns.push({
      turn: i + 1,
      userMessage: script[i],
      blockingMs,
      totalUserFacingMs: pingResponseMs + blockingMs,
      planItemCount: derived.planItemCount,
      note: 'collecting requirements -- no planning yet',
    });

    record({
      // Metrics go to the caller's session so the live panel picks them up.
      // State stays under the isolated per-arm session id.
      sessionId: metricsSessionId,
      scenario,
      kind: 'benchmark_turn',
      ms: pingResponseMs + blockingMs,
      detail: { turn: i + 1, blockingMs, pingResponseMs, arm: 'sequential', stage: 'collect' },
    });
  }

  // Stage 2 -- the handoff. Everything is planned at once, in one blocking
  // run, while the user sits in silence. This single turn is the baseline's
  // entire cost, and it is what the parallel pipeline removes.
  const handoffStart = Date.now();
  const result = await runPonder({
    sessionId,
    metricsSessionId,
    scenario,
    mode: 'bulk',
    history: buildHistory(script, script.length),
    relevantContext: script.join('; '),
  });
  const handoffMs = Date.now() - handoffStart;

  {
    const { derived } = await store.readDerived(sessionId);
    turns.push({
      turn: script.length + 1,
      userMessage: '(all requirements collected -- handing off to the planner)',
      blockingMs: handoffMs,
      totalUserFacingMs: pingResponseMs + handoffMs,
      planItemCount: derived.planItemCount,
      note: result.error
        ? `ponder error: ${result.error}`
        : `bulk plan build, ${result.toolCalls.length} tool calls`,
    });

    record({
      sessionId: metricsSessionId,
      scenario,
      kind: 'benchmark_turn',
      ms: pingResponseMs + handoffMs,
      detail: {
        turn: script.length + 1,
        blockingMs: handoffMs,
        pingResponseMs,
        arm: 'sequential',
        stage: 'handoff',
      },
    });
  }

  const { derived } = await store.readDerived(sessionId);
  const blocking = turns.map((t) => t.blockingMs);

  return {
    pipeline: 'sequential',
    scenario,
    turns,
    blockingStats: computeStats(blocking),
    totalStats: computeStats(turns.map((t) => t.totalUserFacingMs)),
    totalBlockingMs: blocking.reduce((a, b) => a + b, 0),
    wallClockMs: Date.now() - startedAt,
    drainMs: 0,
    finalPlanItemCount: derived.planItemCount,
    finalPhase: derived.phase,
    planComplete: derived.isPlanComplete,
  };
}

async function runParallelArm(
  sessionId: string,
  script: string[],
  pingResponseMs: number,
  metricsSessionId: string,
): Promise<ArmResult> {
  const scenario = 'fastTravelPlanning';
  clearSession(sessionId);
  await store.resetState(sessionId);

  const startedAt = Date.now();
  const turns: TurnResult[] = [];

  for (let i = 0; i < script.length; i += 1) {
    const turnStart = Date.now();

    // Ping writes what the user just said into state, then hands off to Ponder
    // without waiting. Both of those are what the user actually waits for.
    const slotForTurn = inferSlot(script[i]);
    if (slotForTurn) {
      await store.updateSlot(sessionId, slotForTurn.name, slotForTurn.value, 'confirmed', 'ping');
    }

    const kickoff = startPonderJob({
      sessionId,
      metricsSessionId,
      scenario,
      mode: 'async',
      history: buildHistory(script, i),
      relevantContext: script[i],
    });

    const blockingMs = Date.now() - turnStart;
    const { derived } = await store.readDerived(sessionId);

    turns.push({
      turn: i + 1,
      userMessage: script[i],
      blockingMs,
      totalUserFacingMs: pingResponseMs + blockingMs,
      planItemCount: derived.planItemCount,
      note: kickoff.coalesced
        ? 'folded into in-flight reasoning run'
        : `background job ${kickoff.jobId}`,
    });

    record({
      // Metrics go to the caller's session so the live panel picks them up.
      // State stays under the isolated per-arm session id.
      sessionId: metricsSessionId,
      scenario,
      kind: 'benchmark_turn',
      ms: pingResponseMs + blockingMs,
      detail: { turn: i + 1, blockingMs, pingResponseMs, arm: 'parallel' },
    });

    // Model the user thinking and speaking their next sentence. This is the
    // dead time the parallel pipeline exploits and the sequential one wastes.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  // Let any trailing background work finish so plan completeness is comparable.
  const drainStart = Date.now();
  await waitForIdle(sessionId, 120_000);
  const drainMs = Date.now() - drainStart;

  const { derived } = await store.readDerived(sessionId);
  const blocking = turns.map((t) => t.blockingMs);

  return {
    pipeline: 'parallel',
    scenario,
    turns,
    blockingStats: computeStats(blocking),
    totalStats: computeStats(turns.map((t) => t.totalUserFacingMs)),
    totalBlockingMs: blocking.reduce((a, b) => a + b, 0),
    wallClockMs: Date.now() - startedAt,
    drainMs,
    finalPlanItemCount: derived.planItemCount,
    finalPhase: derived.phase,
    planComplete: derived.isPlanComplete,
  };
}

/** Crude slot extraction for the scripted turns -- stands in for Ping's own tool call. */
function inferSlot(message: string): { name: string; value: string } | null {
  const text = message.toLowerCase();
  if (/trip to|travel to|go to|visit/.test(text)) {
    const match = message.match(/(?:trip to|travel to|go to|visit)\s+([A-Za-z\s]+)/i);
    if (match) return { name: 'destination', value: match[1].trim() };
  }
  if (/summer|winter|spring|autumn|fall|month|january|june|july|august|december/.test(text)) {
    return { name: 'when', value: message };
  }
  if (/\b(day|days|week|weeks|night|nights)\b/.test(text)) {
    return { name: 'duration', value: message };
  }
  if (/budget|dollar|euro|yen|\$/.test(text)) {
    return { name: 'budget', value: message };
  }
  if (/\b(alone|just me|people|person|couple|family|friends)\b/.test(text)) {
    return { name: 'people', value: message };
  }
  return null;
}

/**
 * POST /api/benchmark
 * Body: { script?: string[], pingResponseMs?: number, arms?: ('sequential'|'parallel')[],
 *         sessionPrefix?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const script: string[] =
      Array.isArray(body?.script) && body.script.length > 0
        ? body.script.filter((line: unknown) => typeof line === 'string')
        : DEFAULT_SCRIPT;

    const pingResponseMs =
      typeof body?.pingResponseMs === 'number' && body.pingResponseMs >= 0
        ? body.pingResponseMs
        : DEFAULT_PING_RESPONSE_MS;

    const requestedArms: string[] = Array.isArray(body?.arms)
      ? body.arms
      : ['sequential', 'parallel'];

    const prefix = String(body?.sessionPrefix ?? `bench_${Date.now().toString(36)}`);

    // Each arm runs against its own isolated state session, but their metrics
    // are filed under the caller's session id -- otherwise the numbers land in
    // a bucket nothing ever reads and the UI panel stays empty.
    const metricsSessionId =
      typeof body?.sessionId === 'string' && body.sessionId.length > 0
        ? body.sessionId
        : prefix;

    // Arms run one after another, in isolated sessions, so they neither share
    // state nor contend for API capacity in a way that would skew timings.
    const results: ArmResult[] = [];
    if (requestedArms.includes('sequential')) {
      results.push(
        await runSequentialArm(`${prefix}_seq`, script, pingResponseMs, metricsSessionId),
      );
    }
    if (requestedArms.includes('parallel')) {
      results.push(
        await runParallelArm(`${prefix}_par`, script, pingResponseMs, metricsSessionId),
      );
    }

    const sequential = results.find((r) => r.pipeline === 'sequential');
    const parallel = results.find((r) => r.pipeline === 'parallel');

    let comparison = null;
    if (sequential && parallel) {
      const seqMean = sequential.totalStats?.mean ?? 0;
      const parMean = parallel.totalStats?.mean ?? 0;
      comparison = {
        meanUserFacingSequentialMs: seqMean,
        meanUserFacingParallelMs: parMean,
        absoluteSavingPerTurnMs: seqMean - parMean,
        speedup: parMean > 0 ? Number((seqMean / parMean).toFixed(2)) : null,
        percentFaster:
          seqMean > 0 ? Number((((seqMean - parMean) / seqMean) * 100).toFixed(1)) : null,
        cumulativeBlockingSequentialMs: sequential.totalBlockingMs,
        cumulativeBlockingParallelMs: parallel.totalBlockingMs,
        planItemsSequential: sequential.finalPlanItemCount,
        planItemsParallel: parallel.finalPlanItemCount,
        verdict:
          parMean > 0 && seqMean > parMean
            ? 'Parallel pipeline lowers user-faced latency.'
            : 'No latency advantage measured in this run.',
      };
    }

    return NextResponse.json({
      script,
      metricsSessionId,
      pingResponseMs,
      pingResponseMsIsAssumption: true,
      methodology:
        'blockingMs is measured live per turn. pingResponseMs is a constant added to both arms ' +
        'to model the realtime voice model, which is identical in both and cannot be driven ' +
        'server-side. Measure your real value from the live turn_latency metric and pass it in.',
      arms: results,
      comparison,
    });
  } catch (error) {
    console.error('[api/benchmark] POST failed', error);
    const message = error instanceof Error ? error.message : 'Benchmark failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
