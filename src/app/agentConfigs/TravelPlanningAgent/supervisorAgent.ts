import { tool } from '@openai/agents/realtime';

import {
  resolveBreadcrumb,
  resolveHistory,
  resolveScenario,
  resolveSessionId,
} from './clientSession';

// SEQUENTIAL BASELINE.
//
// Ping hands the turn to Ponder and waits. The entire reasoning run -- model
// call, tool loop, state writes -- happens before Ping can say anything
// substantive, so Ponder's latency lands directly on the user.
//
// This is the arm the parallel pipeline is measured against. The reasoning
// itself now lives server-side in ./ponder.ts; this file is just the client
// stub that blocks on it.

export const getNextResponseFromSupervisor = tool({
  name: 'getNextResponseFromSupervisor',
  description:
    'Ask the supervisor agent what to say next. Returns the exact words to read to the user. Blocks until the supervisor has finished reasoning.',
  parameters: {
    type: 'object',
    properties: {
      relevantContextFromLastUserMessage: {
        type: 'string',
        description:
          'Key information from the most recent user message. The supervisor may not see that message otherwise. Empty string is fine if it added nothing.',
      },
    },
    required: ['relevantContextFromLastUserMessage'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { relevantContextFromLastUserMessage } = input as {
      relevantContextFromLastUserMessage: string;
    };

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
          mode: 'sync',
          history,
          relevantContext: relevantContextFromLastUserMessage,
        }),
      });

      if (!response.ok) {
        return {
          nextResponse:
            "I'm having trouble looking that up right now. Could you say that again?",
        };
      }

      const data = await response.json();
      const waitedMs = Date.now() - startedAt;

      breadcrumb?.(`[ponder:sync] blocked Ping for ${waitedMs}ms`, {
        ponderDurationMs: data.durationMs,
        toolCalls: data.toolCalls,
        planItemsAdded: data.planItemsAdded,
      });

      if (!data.nextResponse) {
        return {
          nextResponse:
            "I didn't quite get that sorted. Could you tell me a bit more about what you're after?",
        };
      }

      return { nextResponse: data.nextResponse as string };
    } catch (error) {
      breadcrumb?.('[ponder:sync] request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        nextResponse: "Sorry, I hit a snag looking that up. What else can I help you with?",
      };
    }
  },
});

export default getNextResponseFromSupervisor;
