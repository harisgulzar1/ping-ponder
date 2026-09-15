import { NextRequest, NextResponse } from 'next/server';

import * as store from '@/app/agentConfigs/TravelPlanningAgent/stateStore';
import { deriveState } from '@/app/agentConfigs/TravelPlanningAgent/stateTypes';
import {
  peekSessionJobs,
  clearSession,
  startPonderJob,
} from '@/app/agentConfigs/TravelPlanningAgent/jobs';
import { record } from '@/app/lib/metrics';

// The state store uses `fs`, so this must not run on the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/state?sessionId=X[&since=<epoch ms>]
 *
 * Single read endpoint for the whole app: full state, derived summary, and
 * background job status. `since` additionally returns plan items added at or
 * after that timestamp, which is how the voice agent picks up Ponder's work.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || 'default';
    const sinceParam = searchParams.get('since');

    const state = await store.readState(sessionId);
    const derived = deriveState(state);

    const body: Record<string, unknown> = {
      sessionId,
      state,
      ...derived,
      // Non-consuming: this endpoint is polled once a second by the UI.
      jobs: peekSessionJobs(sessionId),
    };

    if (sinceParam) {
      const since = Number(sinceParam);
      if (Number.isFinite(since)) {
        body.planUpdatesSince = await store.planItemsSince(sessionId, since);
      }
    }

    return NextResponse.json(body);
  } catch (error) {
    console.error('[api/state] GET failed', error);
    return NextResponse.json({ error: 'Failed to read state' }, { status: 500 });
  }
}

/**
 * POST /api/state
 * Body: { sessionId, action, data }
 *
 * Actions: updateSlot | addPlanItem | addPlanItems | updateMeta | resetState | logChange
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) ?? {};
    const { sessionId, action, data } = body;

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const source = data?.source === 'ponder' ? 'ponder' : 'ping';

    switch (action) {
      case 'updateSlot': {
        const startedAt = Date.now();
        const state = await store.updateSlot(
          sessionId,
          data.slotName,
          data.value,
          data.status ?? 'confirmed',
          source,
        );

        const payload: Record<string, unknown> = { success: true, ...deriveState(state) };

        // Hand back anything background research produced since the caller last
        // looked, so a conversational turn costs one round trip instead of two.
        if (typeof data?.since === 'number' && Number.isFinite(data.since)) {
          payload.planUpdatesSince = await store.planItemsSince(sessionId, data.since);
        }

        // Parallel pipeline: new information immediately triggers research.
        // Doing it here rather than as its own tool call saves the voice agent
        // a whole extra model turn plus round trip before it can speak.
        if (data?.autoResearch) {
          const scenario = typeof body.scenario === 'string' ? body.scenario : 'fastTravelPlanning';
          const kickoff = startPonderJob({
            sessionId,
            scenario,
            mode: 'async',
            history: Array.isArray(body.history) ? body.history : [],
            relevantContext: `${data.slotName} = ${data.value}`,
          });
          payload.research = { started: kickoff.started, coalesced: kickoff.coalesced };

          record({
            sessionId,
            scenario,
            kind: 'ponder_kickoff',
            ms: Date.now() - startedAt,
            detail: { via: 'updateSlot', coalesced: kickoff.coalesced },
          });
        }

        return NextResponse.json(payload);
      }

      case 'addPlanItem': {
        const state = await store.addPlanItem(
          sessionId,
          data.category,
          data.value,
          data.status ?? 'proposed',
          source,
        );
        return NextResponse.json({ success: true, ...deriveState(state) });
      }

      case 'addPlanItems': {
        // Bulk variant so the voice agent can confirm a whole plan in one call.
        const items: Array<{ category: string; value: string; status?: 'proposed' | 'confirmed' }> =
          Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
          await store.addPlanItem(
            sessionId,
            item.category,
            item.value,
            item.status ?? 'proposed',
            source,
          );
        }
        const state = await store.readState(sessionId);
        return NextResponse.json({ success: true, added: items.length, ...deriveState(state) });
      }

      case 'updateMeta': {
        const state = await store.updateMeta(
          sessionId,
          data?.conversation_phase,
          data?.intent_status,
        );
        return NextResponse.json({ success: true, ...deriveState(state) });
      }

      case 'resetState': {
        clearSession(sessionId);
        const state = await store.resetState(sessionId);
        return NextResponse.json({ success: true, ...deriveState(state) });
      }

      case 'logChange': {
        store.logChange(sessionId, String(data?.change ?? 'note'), data?.details);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('[api/state] POST failed', error);
    const message = error instanceof Error ? error.message : 'Failed to update state';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
