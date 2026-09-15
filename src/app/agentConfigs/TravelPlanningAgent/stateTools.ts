import { tool } from '@openai/agents/realtime';

import {
  resolveBreadcrumb,
  resolveHistory,
  resolveScenario,
  resolveSessionId,
} from './clientSession';
import type { PlanCategory } from './stateTypes';

// These tools run in the browser, inside the realtime voice agent (Ping).
// They no longer maintain their own copy of state: every call goes to
// /api/state, which is the single server-side source of truth shared with
// Ponder. That is what makes Ponder's background writes visible to Ping.

async function callState(
  action: string,
  sessionId: string,
  data?: unknown,
  extra?: Record<string, unknown>,
) {
  const response = await fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action, data, ...extra }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`state ${action} failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function fetchState(sessionId: string, since?: number) {
  const params = new URLSearchParams({ sessionId });
  if (since !== undefined) params.set('since', String(since));

  const response = await fetch(`/api/state?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`state read failed (${response.status})`);
  }
  return response.json();
}

/**
 * Timestamp of the last time each session was told about new plan items, so
 * background findings are reported exactly once, whichever tool surfaces them.
 */
const lastPlanCheck = new Map<string, number>();

/** Read the watermark and move it to now, in one step. */
function takeSince(sessionId: string): number {
  const since = lastPlanCheck.get(sessionId) ?? 0;
  lastPlanCheck.set(sessionId, Date.now());
  return since;
}

/** Scenarios whose turns should trigger background research automatically. */
function isParallelScenario(scenario: string): boolean {
  return scenario === 'fastTravelPlanning';
}

export const readState = tool({
  name: 'readState',
  description:
    'Read the current travel planning state: which intent slots are filled, what is in the plan, and the current phase. Call this before deciding what to say.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, details) => {
    const sessionId = resolveSessionId(details);
    try {
      const data = await fetchState(sessionId);
      return {
        state: data.state,
        phase: data.phase,
        intentStatus: data.intentStatus,
        emptySlots: data.emptySlots,
        isComplete: data.isComplete,
        planGaps: data.planGaps,
        planItemCount: data.planItemCount,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to read state' };
    }
  },
});

export const updateSlot = tool({
  name: 'updateSlot',
  description:
    'Record something the user told you into an intent slot, and get back any new plan details background research has produced. Use status "confirmed" for facts the user stated themselves.',
  parameters: {
    type: 'object',
    properties: {
      slotName: {
        type: 'string',
        description: 'One of: destination, when, duration, budget, people, other',
      },
      value: { type: 'string', description: 'The value to store' },
      status: {
        type: 'string',
        enum: ['proposed', 'confirmed'],
        description: 'confirmed when the user said it, proposed when you are suggesting it',
      },
    },
    required: ['slotName', 'value', 'status'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { slotName, value, status } = input as {
      slotName: string;
      value: string;
      status: 'proposed' | 'confirmed';
    };
    const sessionId = resolveSessionId(details);
    const scenario = resolveScenario(details);
    const breadcrumb = resolveBreadcrumb(details);
    const parallel = isParallelScenario(scenario);

    try {
      // In the parallel pipeline this single call records the slot, starts
      // background research, and returns pending findings -- so the agent can
      // speak after one round trip instead of three.
      const result = await callState(
        'updateSlot',
        sessionId,
        {
          slotName,
          value,
          status,
          source: 'ping',
          ...(parallel ? { autoResearch: true, since: takeSince(sessionId) } : {}),
        },
        parallel ? { scenario, history: resolveHistory(details) } : undefined,
      );

      breadcrumb?.(`[state] ${slotName} = ${value}`, result);

      const updates = result.planUpdatesSince?.updates ?? {};
      const updateCount = result.planUpdatesSince?.count ?? 0;

      return {
        success: true,
        emptySlots: result.emptySlots,
        isComplete: result.isComplete,
        phase: result.phase,
        ...(parallel
          ? {
              newPlanDetails: updates,
              newPlanDetailCount: updateCount,
              instruction:
                'Respond to the user now. Weave any newPlanDetails in naturally. Do not wait for anything and do not mention research.',
            }
          : {}),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to update slot' };
    }
  },
});

export const addPlanItem = tool({
  name: 'addPlanItem',
  description:
    'Add one item to the travel plan. Use status "confirmed" once the user has explicitly accepted it.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['cities', 'attractions', 'food', 'itinerary', 'accommodation', 'events', 'other'],
        description: 'Which part of the plan this belongs to',
      },
      value: { type: 'string', description: 'Short description of the item' },
      status: {
        type: 'string',
        enum: ['proposed', 'confirmed'],
        description: 'confirmed once the user accepts it',
      },
    },
    required: ['category', 'value', 'status'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { category, value, status } = input as {
      category: PlanCategory;
      value: string;
      status: 'proposed' | 'confirmed';
    };
    const sessionId = resolveSessionId(details);

    try {
      const result = await callState('addPlanItem', sessionId, {
        category,
        value,
        status,
        source: 'ping',
      });
      return { success: true, planItemCount: result.planItemCount };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to add plan item' };
    }
  },
});

export const updatePhase = tool({
  name: 'updatePhase',
  description: 'Move the conversation to a new phase, or update how clear the user intent is.',
  parameters: {
    type: 'object',
    properties: {
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
    required: [],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { conversation_phase, intent_status } = input as {
      conversation_phase?: string;
      intent_status?: string;
    };
    const sessionId = resolveSessionId(details);

    try {
      const result = await callState('updateMeta', sessionId, {
        conversation_phase,
        intent_status,
      });
      return { success: true, phase: result.phase, intentStatus: result.intentStatus };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to update phase' };
    }
  },
});

export const getEmptySlots = tool({
  name: 'getEmptySlots',
  description: 'List which intent slots are still empty, so you know what to ask about next.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, details) => {
    const sessionId = resolveSessionId(details);
    try {
      const data = await fetchState(sessionId);
      return { emptySlots: data.emptySlots, isComplete: data.isComplete };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to get empty slots' };
    }
  },
});

export const checkIntentComplete = tool({
  name: 'checkIntentComplete',
  description: 'Check whether all required intent slots have been filled.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, details) => {
    const sessionId = resolveSessionId(details);
    try {
      const data = await fetchState(sessionId);
      return { isComplete: data.isComplete, emptySlots: data.emptySlots };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to check intent' };
    }
  },
});

export const getCurrentPhase = tool({
  name: 'getCurrentPhase',
  description: 'Get the current conversation phase and intent status.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, details) => {
    const sessionId = resolveSessionId(details);
    try {
      const data = await fetchState(sessionId);
      return { phase: data.phase, intentStatus: data.intentStatus };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to get phase' };
    }
  },
});

/**
 * The delivery mechanism for the parallel pipeline.
 *
 * Ponder runs in the background and writes into shared state. This is how Ping
 * discovers that work and folds it into the conversation, without ever having
 * blocked on it. Each call reports only items added since the previous call.
 */
export const checkPlanUpdates = tool({
  name: 'checkPlanUpdates',
  description:
    'Check whether background research has produced new plan details since you last looked. Call this at the start of each of your turns; if it returns items, weave them into what you say next.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, details) => {
    const sessionId = resolveSessionId(details);
    const breadcrumb = resolveBreadcrumb(details);

    try {
      const data = await fetchState(sessionId, takeSince(sessionId));

      const updates = data.planUpdatesSince?.updates ?? {};
      const count = data.planUpdatesSince?.count ?? 0;
      const stillWorking = Boolean(data.jobs?.running);

      if (count > 0) {
        breadcrumb?.(`[ponder] ${count} new plan item(s) ready`, updates);
      }

      return {
        hasUpdates: count > 0,
        count,
        updates,
        backgroundResearchStillRunning: stillWorking,
        phase: data.phase,
        planGaps: data.planGaps,
        planItemCount: data.planItemCount,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to check plan updates' };
    }
  },
});

export const getAllStateTools = [
  readState,
  updateSlot,
  addPlanItem,
  updatePhase,
  getEmptySlots,
  checkIntentComplete,
  getCurrentPhase,
  checkPlanUpdates,
];
