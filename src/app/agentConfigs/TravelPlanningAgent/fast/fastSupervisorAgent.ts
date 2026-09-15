import { tool } from '@openai/agents/realtime';

import {
  resolveBreadcrumb,
  resolveHistory,
  resolveScenario,
  resolveSessionId,
} from '../clientSession';

// PARALLEL PIPELINE.
//
// The whole point of this file is what it does *not* do: it never waits for
// Ponder. It posts the turn's context to the server, which starts a background
// reasoning job and returns immediately, so the only latency Ping pays is one
// local HTTP round trip (single-digit milliseconds).
//
// Ponder's results reach the conversation later, through shared state, via the
// checkPlanUpdates tool. Ping keeps the user busy in the meantime.
//
// The previous version of this file was labelled "fast" but awaited the full
// reasoning run exactly like the sequential arm did -- the only difference was
// a prompt telling the agent not to call it. It also wrote state through a
// server-only module while running in the browser, so nothing it produced was
// ever saved.

export const kickOffBackgroundResearch = tool({
  name: 'kickOffBackgroundResearch',
  description:
    'Hand the current conversation to the background research agent. Returns immediately -- it does NOT wait for results. Call this right after recording what the user said, then continue the conversation yourself without pausing. Results arrive later via checkPlanUpdates.',
  parameters: {
    type: 'object',
    properties: {
      relevantContextFromLastUserMessage: {
        type: 'string',
        description:
          'Key information from the most recent user message, so the researcher knows what changed.',
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
          mode: 'async',
          history,
          relevantContext: relevantContextFromLastUserMessage,
        }),
      });

      const kickoffMs = Date.now() - startedAt;

      if (!response.ok) {
        // A failed handoff must still not stall the conversation.
        breadcrumb?.('[ponder:async] kickoff failed', { status: response.status });
        return {
          started: false,
          instruction:
            'Background research could not start. Keep talking to the user using what is already in state.',
        };
      }

      const data = await response.json();

      breadcrumb?.(`[ponder:async] handed off in ${kickoffMs}ms (not blocking)`, {
        jobId: data.jobId,
        coalesced: data.coalesced,
      });

      return {
        started: true,
        coalesced: Boolean(data.coalesced),
        kickoffMs,
        instruction:
          'Research is running in the background. Respond to the user NOW from current state -- do not wait, and do not mention that anything is loading.',
      };
    } catch (error) {
      breadcrumb?.('[ponder:async] kickoff threw', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        started: false,
        instruction:
          'Background research could not start. Keep talking to the user using what is already in state.',
      };
    }
  },
});

/**
 * Escape hatch, kept deliberately unattractive in the prompt.
 *
 * There are moments (the user directly asks a factual question that state
 * cannot answer) where blocking is the right call. Exposing it keeps the
 * parallel agent honest rather than forcing it to bluff.
 */
export const askResearcherAndWait = tool({
  name: 'askResearcherAndWait',
  description:
    'Ask the research agent a question and WAIT for the answer. This makes the user wait several seconds, so use it only when the user asked something specific that state cannot answer and stalling would be worse.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The specific question to research.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { question } = input as { question: string };

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
          relevantContext: question,
        }),
      });

      if (!response.ok) {
        return { answer: '', error: 'Research request failed.' };
      }

      const data = await response.json();
      breadcrumb?.(`[ponder:sync-fallback] blocked Ping for ${Date.now() - startedAt}ms`, {
        question,
      });

      return { answer: (data.nextResponse as string) ?? '' };
    } catch (error) {
      return {
        answer: '',
        error: error instanceof Error ? error.message : 'Research request failed.',
      };
    }
  },
});

export default kickOffBackgroundResearch;
