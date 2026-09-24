import { tool } from '@openai/agents/realtime';

import {
  resolveBreadcrumb,
  resolveHistory,
  resolveScenario,
  resolveSessionId,
} from './clientSession';

// SEQUENTIAL BASELINE: collect everything, then hand off once.
//
// This arm deliberately does NO planning during the conversation. Ping gathers
// the slots -- destination, dates, duration, budget, party size -- and only when
// they are all in does it hand the whole conversation to the planning agent and
// wait. That handoff has to do every lookup for every category in one go, so it
// is a single long silence rather than latency spread thinly across turns.
//
// That concentration is the point. It is how a naive two-agent split actually
// behaves, and it is what the parallel pipeline is measured against: the same
// total reasoning, either dumped on the user at the end or hidden inside the
// time they were already spending talking.

export const generateFullPlan = tool({
  name: 'generateFullPlan',
  description:
    'Hand the entire conversation to the planning agent to build the complete travel plan in one go. BLOCKS until the whole plan is built -- every category, every lookup -- so it takes a long time. Call it exactly once, only after every required slot is confirmed. Returns the words to read to the user.',
  parameters: {
    type: 'object',
    properties: {
      confirmedRequirements: {
        type: 'string',
        description:
          'A short summary of everything the user has confirmed: destination, timing, duration, budget and party size.',
      },
    },
    required: ['confirmedRequirements'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { confirmedRequirements } = input as { confirmedRequirements: string };

    const sessionId = resolveSessionId(details);
    const scenario = resolveScenario(details);
    const breadcrumb = resolveBreadcrumb(details);
    const history = resolveHistory(details);

    const startedAt = Date.now();

    try {
      const response = await fetch('/api/supervisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          scenario,
          mode: 'bulk',
          history,
          relevantContext: confirmedRequirements,
        }),
      });

      if (!response.ok) {
        return {
          nextResponse:
            "I'm having trouble putting the plan together right now. Could we try that again in a moment?",
        };
      }

      const data = await response.json();
      const waitedMs = Date.now() - startedAt;

      breadcrumb?.(`[ponder:bulk] blocked Ping for ${waitedMs}ms building the whole plan`, {
        ponderDurationMs: data.durationMs,
        toolCalls: data.toolCalls,
        planItemsAdded: data.planItemsAdded,
      });

      if (!data.nextResponse) {
        return {
          nextResponse:
            "I've put some ideas together. Would you like me to walk you through them?",
        };
      }

      return { nextResponse: data.nextResponse as string };
    } catch (error) {
      breadcrumb?.('[ponder:bulk] request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        nextResponse:
          'Sorry, I hit a snag building the plan. Shall I try that once more?',
      };
    }
  },
});

export default generateFullPlan;
