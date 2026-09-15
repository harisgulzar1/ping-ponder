// SERVER-ONLY latency metrics store for the Ping/Ponder comparison.
//
// The whole point of the project is a latency claim, so the numbers behind it
// need to be recorded rather than eyeballed. Events are appended as JSONL to
// conversation_logs/session_<id>_metrics.jsonl and kept in memory for the
// live UI panel.

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'conversation_logs');

/** Keep memory bounded for long demo sessions. */
const MAX_EVENTS_PER_SESSION = 500;

export type MetricKind =
  /**
   * User stopped speaking -> first byte of assistant audio.
   *
   * Deliberately NOT the headline number. The sequential baseline opens with a
   * filler phrase ("let me check that for you") before it blocks on Ponder, so
   * this metric is fast in both pipelines and hides the effect being measured.
   * It is recorded to show that the parallel pipeline does not regress it.
   */
  | 'turn_latency'
  /**
   * User stopped speaking -> assistant's turn complete (`response.done`).
   *
   * THE headline number: how long until the user actually has their answer and
   * can speak again. In the sequential pipeline this contains the whole Ponder
   * run; in the parallel one it does not.
   */
  | 'turn_completion'
  /** Wall-clock of a full Ponder reasoning run (model + tool loop). */
  | 'ponder_run'
  /** How long the voice agent was blocked handing work to Ponder. */
  | 'ponder_kickoff'
  /** Ponder finished and wrote N plan items into state. */
  | 'plan_items_added'
  /** A scripted benchmark turn. */
  | 'benchmark_turn';

export type Pipeline = 'sequential' | 'parallel' | 'unknown';

export interface MetricEvent {
  sessionId: string;
  scenario: string;
  pipeline: Pipeline;
  kind: MetricKind;
  ms: number;
  at: number;
  detail?: Record<string, unknown>;
}

const events = new Map<string, MetricEvent[]>();

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (error) {
    console.error('[metrics] could not create log dir', error);
  }
}

function metricsPath(sessionId: string): string {
  return path.join(LOG_DIR, `session_${sessionId}_metrics.jsonl`);
}

/** Map a scenario key to the pipeline architecture it exercises. */
export function pipelineForScenario(scenario: string): Pipeline {
  if (scenario === 'fastTravelPlanning') return 'parallel';
  if (scenario === 'travelPlanning') return 'sequential';
  return 'unknown';
}

export function record(event: Omit<MetricEvent, 'at' | 'pipeline'> & { at?: number; pipeline?: Pipeline }): MetricEvent {
  const full: MetricEvent = {
    ...event,
    at: event.at ?? Date.now(),
    pipeline: event.pipeline ?? pipelineForScenario(event.scenario),
  };

  const bucket = events.get(full.sessionId) ?? [];
  bucket.push(full);
  if (bucket.length > MAX_EVENTS_PER_SESSION) {
    bucket.splice(0, bucket.length - MAX_EVENTS_PER_SESSION);
  }
  events.set(full.sessionId, bucket);

  ensureLogDir();
  try {
    fs.appendFileSync(metricsPath(full.sessionId), `${JSON.stringify(full)}\n`);
  } catch (error) {
    console.error('[metrics] could not append metric', error);
  }

  return full;
}

export interface Stats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function computeStats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile: index of the smallest value at or above the rank.
  const quantile = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    mean: Math.round(sum / sorted.length),
    p50: Math.round(quantile(0.5)),
    p95: Math.round(quantile(0.95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

export interface MetricsSummary {
  sessionId: string;
  byPipeline: Record<
    Pipeline,
    {
      /** Time to answer complete -- the headline metric. */
      turnCompletion: Stats | null;
      /** Time to first audio -- fast in both arms; tracked to show no regression. */
      turnLatency: Stats | null;
      ponderRun: Stats | null;
      ponderKickoff: Stats | null;
      planItemsAdded: number;
      turns: number;
    }
  >;
  /** parallel vs sequential on the headline metric, when both are present. */
  comparison: {
    sequentialMeanMs: number;
    parallelMeanMs: number;
    absoluteSavingMs: number;
    speedup: number;
    percentFaster: number;
  } | null;
  events: MetricEvent[];
}

function emptyBucket() {
  return {
    turnCompletion: null as Stats | null,
    turnLatency: null as Stats | null,
    ponderRun: null as Stats | null,
    ponderKickoff: null as Stats | null,
    planItemsAdded: 0,
    turns: 0,
  };
}

export function summarize(sessionId: string): MetricsSummary {
  const bucket = events.get(sessionId) ?? loadFromDisk(sessionId);

  const byPipeline: MetricsSummary['byPipeline'] = {
    sequential: emptyBucket(),
    parallel: emptyBucket(),
    unknown: emptyBucket(),
  };

  for (const pipeline of ['sequential', 'parallel', 'unknown'] as Pipeline[]) {
    const scoped = bucket.filter((event) => event.pipeline === pipeline);
    const pick = (kind: MetricKind) =>
      scoped.filter((event) => event.kind === kind).map((event) => event.ms);

    // Scripted benchmark turns measure time-to-answer, same as turn_completion.
    const completionValues = [...pick('turn_completion'), ...pick('benchmark_turn')];

    byPipeline[pipeline] = {
      turnCompletion: computeStats(completionValues),
      turnLatency: computeStats(pick('turn_latency')),
      ponderRun: computeStats(pick('ponder_run')),
      ponderKickoff: computeStats(pick('ponder_kickoff')),
      planItemsAdded: scoped
        .filter((event) => event.kind === 'plan_items_added')
        .reduce((total, event) => total + Number(event.detail?.count ?? 0), 0),
      turns: completionValues.length,
    };
  }

  const sequentialMean = byPipeline.sequential.turnCompletion?.mean;
  const parallelMean = byPipeline.parallel.turnCompletion?.mean;

  let comparison: MetricsSummary['comparison'] = null;
  if (sequentialMean && parallelMean && parallelMean > 0) {
    comparison = {
      sequentialMeanMs: sequentialMean,
      parallelMeanMs: parallelMean,
      absoluteSavingMs: sequentialMean - parallelMean,
      speedup: Number((sequentialMean / parallelMean).toFixed(2)),
      percentFaster: Number(
        (((sequentialMean - parallelMean) / sequentialMean) * 100).toFixed(1),
      ),
    };
  }

  return { sessionId, byPipeline, comparison, events: bucket };
}

/** Rehydrate after a dev-server restart so a demo session is not lost. */
function loadFromDisk(sessionId: string): MetricEvent[] {
  try {
    const file = metricsPath(sessionId);
    if (!fs.existsSync(file)) return [];
    const parsed = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as MetricEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is MetricEvent => event !== null);
    const trimmed = parsed.slice(-MAX_EVENTS_PER_SESSION);
    events.set(sessionId, trimmed);
    return trimmed;
  } catch (error) {
    console.error('[metrics] could not load metrics from disk', error);
    return [];
  }
}

export function clear(sessionId: string): void {
  events.delete(sessionId);
  try {
    const file = metricsPath(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    console.error('[metrics] could not clear metrics', error);
  }
}
