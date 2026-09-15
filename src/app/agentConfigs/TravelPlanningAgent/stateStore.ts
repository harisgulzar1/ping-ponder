// SERVER-ONLY single source of truth for travel planning state.
//
// Do not import this from a client component or a client-side agent tool --
// it uses `fs`. Client code should go through /api/state instead.
//
// Why this exists: the previous build had two competing stores (a localStorage
// ClientStateManager and a file-backed ServerStateManager). The supervisor ran
// in the browser but wrote through the *server* manager, whose every method is
// a no-op when `window` is defined, so all of Ponder's background writes were
// silently discarded. Everything now funnels through this one module, which
// only ever runs on the server.

import fs from 'fs';
import path from 'path';

import {
  createDefaultState,
  deriveState,
  isIntentSlotName,
  isPlanCategory,
  normalizeState,
  PLAN_CATEGORIES,
  type ConversationPhase,
  type DerivedState,
  type IntentStatus,
  type ItemStatus,
  type PlanCategory,
  type SlotStatus,
  type TravelState,
  type ValueSource,
} from './stateTypes';

const LOG_DIR = path.join(process.cwd(), 'conversation_logs');

/** In-memory source of truth. Disk is a mirror for inspection + restart safety. */
const sessions = new Map<string, TravelState>();

/** Per-session promise chain, so read-modify-write sequences cannot interleave. */
const locks = new Map<string, Promise<unknown>>();

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (error) {
    console.error('[stateStore] could not create log dir', error);
  }
}

function statePath(sessionId: string): string {
  return path.join(LOG_DIR, `session_${sessionId}_state.json`);
}

function changesPath(sessionId: string): string {
  return path.join(LOG_DIR, `session_${sessionId}_changes.log`);
}

/**
 * Serialize work per session. Later callers queue behind earlier ones whether
 * or not those succeeded, so one failed mutation cannot wedge the session.
 */
function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow rejections on the stored chain so it stays usable as a barrier.
  locks.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function loadFromDisk(sessionId: string): TravelState {
  try {
    const file = statePath(sessionId);
    if (fs.existsSync(file)) {
      return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch (error) {
    console.error(`[stateStore] could not read state for ${sessionId}`, error);
  }
  // NOTE: deliberately no fallback to the shared State.json snapshot. That
  // fallback used to leak one session's plan into every other session.
  return createDefaultState();
}

function getOrLoad(sessionId: string): TravelState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = loadFromDisk(sessionId);
    sessions.set(sessionId, state);
  }
  return state;
}

function persist(sessionId: string, state: TravelState): void {
  ensureLogDir();
  try {
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2));
  } catch (error) {
    console.error(`[stateStore] could not persist state for ${sessionId}`, error);
  }
  // Everything written here stays under conversation_logs/, deliberately
  // outside src/. The old build mirrored state into
  // src/app/agentConfigs/TravelPlanningAgent/State.json on every mutation,
  // which the Next.js dev watcher sees -- that triggers a fast-refresh in the
  // middle of a live voice conversation and tears down the session.
}

export function logChange(sessionId: string, change: string, details?: unknown): void {
  ensureLogDir();
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId,
    change,
    details,
  };
  try {
    fs.appendFileSync(changesPath(sessionId), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error(`[stateStore] could not append change log for ${sessionId}`, error);
  }
}

/** Snapshot read. Returns a deep copy so callers cannot mutate the store. */
export async function readState(sessionId: string): Promise<TravelState> {
  return withLock(sessionId, async () => {
    const state = getOrLoad(sessionId);
    return JSON.parse(JSON.stringify(state)) as TravelState;
  });
}

export async function readDerived(
  sessionId: string,
): Promise<{ state: TravelState; derived: DerivedState }> {
  const state = await readState(sessionId);
  return { state, derived: deriveState(state) };
}

/**
 * Apply a mutation under the session lock. `mutator` receives the live object
 * and may modify it in place; version/updatedAt bookkeeping and persistence
 * are handled here.
 */
async function mutate(
  sessionId: string,
  label: string,
  details: unknown,
  mutator: (state: TravelState) => void | boolean,
): Promise<TravelState> {
  return withLock(sessionId, async () => {
    const state = getOrLoad(sessionId);
    const changed = mutator(state);
    // A mutator may return false to signal "nothing actually changed".
    if (changed === false) {
      return JSON.parse(JSON.stringify(state)) as TravelState;
    }
    state.meta.version += 1;
    state.meta.updatedAt = Date.now();
    sessions.set(sessionId, state);
    persist(sessionId, state);
    logChange(sessionId, label, details);
    return JSON.parse(JSON.stringify(state)) as TravelState;
  });
}

export async function updateSlot(
  sessionId: string,
  slotName: string,
  value: string,
  status: SlotStatus,
  source: ValueSource = 'ping',
): Promise<TravelState> {
  if (!isIntentSlotName(slotName)) {
    throw new Error(`Unknown intent slot: ${slotName}`);
  }
  return mutate(
    sessionId,
    `Updated slot: ${slotName}`,
    { value, status, source },
    (state) => {
      state.intent_clarification[slotName] = {
        value,
        status,
        source,
        updatedAt: Date.now(),
      };
    },
  );
}

export async function addPlanItem(
  sessionId: string,
  category: string,
  value: string,
  status: ItemStatus = 'proposed',
  source: ValueSource = 'ponder',
): Promise<TravelState> {
  if (!isPlanCategory(category)) {
    throw new Error(`Unknown plan category: ${category}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Plan item value must be non-empty');
  }
  return mutate(
    sessionId,
    `Added plan item: ${category}`,
    { value: trimmed, status, source },
    (state) => {
      const items = state.plan_sharing[category];
      const existing = items.find(
        (item) => item.value.toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing) {
        // Only an upgrade to `confirmed` is a real change; re-proposing is a no-op.
        if (existing.status === status) return false;
        existing.status = status;
        return true;
      }
      items.push({ value: trimmed, status, source, addedAt: Date.now() });
      return true;
    },
  );
}

export async function updateMeta(
  sessionId: string,
  conversationPhase?: ConversationPhase,
  intentStatus?: IntentStatus,
): Promise<TravelState> {
  return mutate(
    sessionId,
    'Updated phase/status',
    { conversation_phase: conversationPhase, intent_status: intentStatus },
    (state) => {
      let changed = false;
      if (conversationPhase && state.meta.conversation_phase !== conversationPhase) {
        state.meta.conversation_phase = conversationPhase;
        changed = true;
      }
      if (intentStatus && state.meta.intent_status !== intentStatus) {
        state.meta.intent_status = intentStatus;
        changed = true;
      }
      return changed;
    },
  );
}

export async function resetState(sessionId: string): Promise<TravelState> {
  return withLock(sessionId, async () => {
    const fresh = createDefaultState();
    sessions.set(sessionId, fresh);
    persist(sessionId, fresh);
    logChange(sessionId, 'State reset to default');
    return JSON.parse(JSON.stringify(fresh)) as TravelState;
  });
}

/**
 * Plan items added at or after `since`, grouped by category. This is how the
 * voice agent discovers what Ponder produced while it was talking to the user.
 */
export async function planItemsSince(
  sessionId: string,
  since: number,
): Promise<{ updates: Partial<Record<PlanCategory, string[]>>; count: number }> {
  const state = await readState(sessionId);
  const updates: Partial<Record<PlanCategory, string[]>> = {};
  let count = 0;

  for (const category of PLAN_CATEGORIES) {
    const fresh = state.plan_sharing[category]
      .filter((item) => item.addedAt >= since)
      .map((item) => item.value);
    if (fresh.length > 0) {
      updates[category] = fresh;
      count += fresh.length;
    }
  }

  return { updates, count };
}
