import { useCallback, useEffect, useRef, useState } from 'react';

// Measures how long the user waits, from two angles. Both can only be taken in
// the browser -- they span WebRTC transport events -- so they are captured here
// and posted to /api/metrics alongside the server-measured Ponder timings.
//
//   firstAudioMs  end of user speech -> first assistant audio frame.
//   completionMs  end of user speech -> assistant done talking for this turn.
//
// completionMs is the headline number. firstAudioMs is fast in BOTH pipelines
// because the sequential agent opens with a filler phrase ("let me check that
// for you") and only then blocks on Ponder -- so measuring first audio alone
// would hide the entire effect. Time-to-answer is what the user actually feels.

/** Transport events that mean "the user has stopped talking; the clock starts". */
const TURN_START_EVENTS = new Set([
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
]);

/** Transport events that mean "the first audio is on its way out". */
const FIRST_OUTPUT_EVENTS = new Set([
  'response.audio.delta',
  'response.output_audio.delta',
  'response.output_audio.started',
]);

/** Transport events that mean "a response finished". Not necessarily the turn. */
const RESPONSE_DONE_EVENTS = new Set(['response.done']);

/**
 * Transport events that mean "more assistant output is coming", which cancels a
 * pending turn-close.
 *
 * This matters because one conversational turn can span SEVERAL responses. A
 * blocking tool call splits the turn in two: response 1 is the filler phrase
 * plus the function_call, then the tool runs, then response 2 carries the real
 * answer. Closing the clock on the first `response.done` would time only the
 * filler and report the sequential pipeline as fast -- exactly backwards.
 */
const RESPONSE_CONTINUES_EVENTS = new Set([
  'response.created',
  'response.output_item.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
]);

/**
 * Safety net for a turn that never completes -- a tool that throws, or a
 * dropped connection. The sample is discarded rather than recorded, because a
 * wrong number is worse than a missing one.
 */
const TURN_ABANDON_MS = 150_000;

export interface TurnSample {
  /** End of user speech -> assistant done talking. The headline number. */
  completionMs: number;
  /** End of user speech -> first assistant audio. Null if no audio was emitted. */
  firstAudioMs: number | null;
  /** How many responses the turn spanned. >1 means a blocking tool call. */
  responses: number;
  at: number;
  trigger: 'voice' | 'text';
}

export interface UseTurnLatencyOptions {
  sessionId: string;
  scenario: string;
  /** Ignore implausible samples (barge-in artefacts, stale clocks). */
  maxPlausibleMs?: number;
}

export function useTurnLatency({
  sessionId,
  scenario,
  maxPlausibleMs = 120_000,
}: UseTurnLatencyOptions) {
  const turnStartRef = useRef<number | null>(null);
  const firstAudioRef = useRef<number | null>(null);
  const lastDoneAtRef = useRef<number | null>(null);
  const responseCountRef = useRef(0);
  const triggerRef = useRef<'voice' | 'text'>('voice');
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [samples, setSamples] = useState<TurnSample[]>([]);
  const [latest, setLatest] = useState<TurnSample | null>(null);

  const post = useCallback(
    (kind: 'turn_latency' | 'turn_completion', ms: number, detail: Record<string, unknown>) => {
      // Fire-and-forget: metrics must never add latency to the thing they measure.
      void fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, scenario, kind, ms, detail }),
      }).catch(() => {
        // Losing a metric is preferable to disturbing the session.
      });
    },
    [sessionId, scenario],
  );

  const cancelSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /** Discard the in-progress turn without recording anything. */
  const abandonTurn = useCallback(() => {
    cancelSettle();
    turnStartRef.current = null;
    lastDoneAtRef.current = null;
  }, [cancelSettle]);

  /** Close out the turn using the last `response.done` we saw. */
  const finalizeTurn = useCallback(() => {
    cancelSettle();

    const start = turnStartRef.current;
    const doneAt = lastDoneAtRef.current;
    turnStartRef.current = null;
    lastDoneAtRef.current = null;

    if (start === null || doneAt === null) return;

    const completionMs = doneAt - start;
    const responses = responseCountRef.current;
    const firstAudioMs = firstAudioRef.current;

    if (completionMs < 0 || completionMs > maxPlausibleMs) return;

    post('turn_completion', completionMs, {
      trigger: triggerRef.current,
      responses,
      firstAudioMs,
    });

    const sample: TurnSample = {
      completionMs,
      firstAudioMs,
      responses,
      at: Date.now(),
      trigger: triggerRef.current,
    };
    setLatest(sample);
    setSamples((previous) => [...previous.slice(-49), sample]);
  }, [cancelSettle, maxPlausibleMs, post]);

  const beginTurn = useCallback(
    (trigger: 'voice' | 'text') => {
      // A new turn starting means the previous one is definitely over.
      if (turnStartRef.current !== null && lastDoneAtRef.current !== null) {
        finalizeTurn();
      }
      cancelSettle();
      turnStartRef.current = Date.now();
      firstAudioRef.current = null;
      lastDoneAtRef.current = null;
      responseCountRef.current = 0;
      triggerRef.current = trigger;
    },
    [cancelSettle, finalizeTurn],
  );

  /** Call when the user sends a typed message, which has no speech_stopped event. */
  const markTextTurnStart = useCallback(() => beginTurn('text'), [beginTurn]);

  const handleTransportEvent = useCallback(
    (event: {
      type?: string;
      response?: { status?: string; output?: Array<{ type?: string }> };
    }) => {
      const type = event?.type;
      if (!type) return;

      if (TURN_START_EVENTS.has(type)) {
        beginTurn('voice');
        return;
      }

      if (turnStartRef.current === null) return; // Not timing a turn right now.

      if (RESPONSE_CONTINUES_EVENTS.has(type)) {
        // More output on the way, so this turn is not finished after all.
        cancelSettle();
        if (type === 'response.created') responseCountRef.current += 1;
        return;
      }

      if (FIRST_OUTPUT_EVENTS.has(type)) {
        cancelSettle();
        if (firstAudioRef.current !== null) return; // Only the first frame counts.
        const ms = Date.now() - turnStartRef.current;
        firstAudioRef.current = ms;
        if (ms >= 0 && ms <= maxPlausibleMs) {
          post('turn_latency', ms, { trigger: triggerRef.current });
        }
        return;
      }

      if (RESPONSE_DONE_EVENTS.has(type)) {
        // A cancelled response is not an answer. `interrupt()` on a new user
        // turn cancels whatever was playing, and that cancellation's
        // `response.done` lands just after the clock starts -- which would
        // otherwise be recorded as a near-zero time-to-answer.
        if (event.response?.status === 'cancelled') return;

        cancelSettle();

        // The finished response tells us whether the turn is actually over. If
        // it contains a function_call, the tool has yet to run and a follow-up
        // response will carry the real answer -- so keep the clock running.
        // This is the whole sequential-pipeline wait, and it is longer than any
        // timeout we could safely guess at.
        const pendingToolCall = (event.response?.output ?? []).some(
          (item) => item?.type === 'function_call',
        );

        if (pendingToolCall) {
          // Leave lastDoneAt unset: this is not a point the turn could end at,
          // so if the user barges in now the sample is discarded rather than
          // being recorded as the filler phrase's duration.
          settleTimerRef.current = setTimeout(abandonTurn, TURN_ABANDON_MS);
          return;
        }

        lastDoneAtRef.current = Date.now();
        finalizeTurn();
      }
    },
    [abandonTurn, beginTurn, cancelSettle, finalizeTurn, maxPlausibleMs, post],
  );

  const reset = useCallback(() => {
    cancelSettle();
    turnStartRef.current = null;
    firstAudioRef.current = null;
    lastDoneAtRef.current = null;
    responseCountRef.current = 0;
    setSamples([]);
    setLatest(null);
  }, [cancelSettle]);

  useEffect(() => cancelSettle, [cancelSettle]);

  return { handleTransportEvent, markTextTurnStart, latest, samples, reset };
}

export default useTurnLatency;
