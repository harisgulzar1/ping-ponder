// SERVER-ONLY background job registry for async Ponder runs.
//
// This is what makes the parallel pipeline parallel: /api/supervisor in async
// mode starts a job here and returns immediately, so Ping is never blocked on
// Ponder's reasoning latency.
//
// In-memory and single-process, which is fine for a demo on one dev server.
// A multi-instance deployment would swap this for a real queue.

import { runPonder, type PonderRequest, type PonderResult } from './ponder';

export type JobStatus = 'running' | 'done' | 'error';

export interface PonderJob {
  id: string;
  sessionId: string;
  scenario: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: PonderResult;
  error?: string;
  /** Set once a caller has been told about this job's completion. */
  acknowledged: boolean;
}

const jobs = new Map<string, PonderJob>();

/** At most one in-flight job per session -- concurrent runs would fight over state. */
const inFlight = new Map<string, string>();

/** Completed-but-unacknowledged jobs, newest last, per session. */
const completed = new Map<string, PonderJob[]>();

const MAX_COMPLETED_PER_SESSION = 20;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ponder_${Date.now().toString(36)}_${counter}`;
}

export interface StartResult {
  started: boolean;
  jobId: string;
  /** True when a job was already running and this request was coalesced into it. */
  coalesced: boolean;
}

/**
 * Kick off a Ponder run without awaiting it.
 *
 * Returns synchronously (modulo a microtask) so the caller's latency is just
 * the HTTP round trip, not the reasoning run.
 */
export function startPonderJob(request: PonderRequest): StartResult {
  const existingId = inFlight.get(request.sessionId);
  if (existingId) {
    // Already thinking about this session. Coalescing rather than queueing
    // keeps the newest user context from piling up behind stale runs.
    return { started: false, jobId: existingId, coalesced: true };
  }

  const id = nextId();
  const job: PonderJob = {
    id,
    sessionId: request.sessionId,
    scenario: request.scenario,
    status: 'running',
    startedAt: Date.now(),
    acknowledged: false,
  };

  jobs.set(id, job);
  inFlight.set(request.sessionId, id);

  // Deliberately not awaited.
  void runPonder(request)
    .then((result) => {
      job.status = 'done';
      job.result = result;
      if (result.error) {
        job.status = 'error';
        job.error = result.error;
      }
    })
    .catch((error: unknown) => {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - job.startedAt;

      // Only release the slot if it is still ours. clearSession() can orphan a
      // running job and a new one may already hold the slot; an unconditional
      // delete here would untrack that newer job.
      if (inFlight.get(request.sessionId) === id) {
        inFlight.delete(request.sessionId);
      }

      const bucket = completed.get(request.sessionId) ?? [];
      bucket.push(job);
      if (bucket.length > MAX_COMPLETED_PER_SESSION) {
        // Drop the oldest from the id index too, or it grows without bound.
        const evicted = bucket.splice(0, bucket.length - MAX_COMPLETED_PER_SESSION);
        for (const old of evicted) jobs.delete(old.id);
      }
      completed.set(request.sessionId, bucket);
    });

  return { started: true, jobId: id, coalesced: false };
}

export function isBusy(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

export interface SessionJobSnapshot {
  running: boolean;
  runningJobId: string | null;
  runningForMs: number | null;
  /** Jobs that finished since the last call to this function. */
  finishedSinceLastCheck: Array<{
    jobId: string;
    status: JobStatus;
    durationMs: number;
    planItemsAdded: number;
    text: string;
  }>;
}

function snapshot(sessionId: string, consume: boolean): SessionJobSnapshot {
  const runningJobId = inFlight.get(sessionId) ?? null;
  const runningJob = runningJobId ? jobs.get(runningJobId) : undefined;

  const bucket = completed.get(sessionId) ?? [];
  const fresh = bucket.filter((job) => !job.acknowledged);
  if (consume) {
    for (const job of fresh) job.acknowledged = true;
  }

  return {
    running: runningJobId !== null,
    runningJobId,
    runningForMs: runningJob ? Date.now() - runningJob.startedAt : null,
    finishedSinceLastCheck: fresh.map((job) => ({
      jobId: job.id,
      status: job.status,
      durationMs: job.durationMs ?? 0,
      planItemsAdded: job.result?.planItemsAdded ?? 0,
      text: job.result?.text ?? '',
    })),
  };
}

/**
 * Read-only view. Safe for the 1s UI poller: it does not mark completions seen,
 * so it cannot swallow a completion that a real consumer still needs.
 */
export function peekSessionJobs(sessionId: string): SessionJobSnapshot {
  return snapshot(sessionId, false);
}

/**
 * Report job state and mark finished jobs acknowledged, so a consumer sees each
 * completion exactly once.
 */
export function consumeSessionJobs(sessionId: string): SessionJobSnapshot {
  return snapshot(sessionId, true);
}

/** Wait for any in-flight job for this session. Used by the benchmark harness. */
export async function waitForIdle(sessionId: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.has(sessionId)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export function clearSession(sessionId: string): void {
  // An in-flight promise cannot be cancelled, but it can be orphaned so a reset
  // session starts clean and the next kickoff is not treated as coalesced.
  inFlight.delete(sessionId);

  for (const job of completed.get(sessionId) ?? []) {
    jobs.delete(job.id);
  }
  completed.delete(sessionId);
}
