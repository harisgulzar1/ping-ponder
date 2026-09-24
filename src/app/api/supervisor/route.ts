import { NextRequest, NextResponse } from 'next/server';

import {
  runPonder,
  type PonderHistoryItem,
  type PonderMode,
} from '@/app/agentConfigs/TravelPlanningAgent/ponder';
import { consumeSessionJobs, isBusy, startPonderJob } from '@/app/agentConfigs/TravelPlanningAgent/jobs';
import { record } from '@/app/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/supervisor
 * Body: { sessionId, scenario, mode: 'sync' | 'async' | 'bulk', history, relevantContext }
 *
 * mode 'sync'  -- one short blocking answer for a single turn.
 * mode 'async' -- parallel pipeline. Starts a background job and returns in a
 *                 few milliseconds. Ping answers from state instead of waiting.
 * mode 'bulk'  -- sequential baseline. Builds the ENTIRE plan in one blocking
 *                 run once all slots are collected. This is the single long
 *                 silence the parallel pipeline exists to eliminate.
 */
export async function POST(request: NextRequest) {
  const receivedAt = Date.now();

  try {
    const body = await request.json();
    const sessionId: string = body?.sessionId || 'default';
    const scenario: string = body?.scenario || 'travelPlanning';
    const requested = body?.mode;
    const mode: PonderMode =
      requested === 'async' || requested === 'bulk' ? requested : 'sync';
    const relevantContext: string = body?.relevantContext ?? '';

    const history: PonderHistoryItem[] = Array.isArray(body?.history)
      ? body.history
          .filter((item: any) => item && typeof item.content === 'string')
          .map((item: any) => ({
            role: typeof item.role === 'string' ? item.role : 'user',
            content: item.content,
          }))
      : [];

    if (mode === 'async') {
      const { started, jobId, coalesced } = startPonderJob({
        sessionId,
        scenario,
        mode: 'async',
        history,
        relevantContext,
      });

      const kickoffMs = Date.now() - receivedAt;
      record({
        sessionId,
        scenario,
        kind: 'ponder_kickoff',
        ms: kickoffMs,
        detail: { jobId, coalesced },
      });

      return NextResponse.json({
        mode: 'async',
        accepted: true,
        started,
        coalesced,
        jobId,
        kickoffMs,
        note: coalesced
          ? 'A reasoning run was already in flight for this session; request folded into it.'
          : 'Reasoning started in the background.',
      });
    }

    const result = await runPonder({
      sessionId,
      scenario,
      mode,
      history,
      relevantContext,
    });

    return NextResponse.json({
      mode,
      nextResponse: result.text,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
      planItemsAdded: result.planItemsAdded,
      stateVersion: result.stateVersion,
      error: result.error,
    });
  } catch (error) {
    console.error('[api/supervisor] POST failed', error);
    return NextResponse.json({ error: 'Supervisor request failed' }, { status: 500 });
  }
}

/**
 * GET /api/supervisor?sessionId=X
 * Background job status. Completions are reported once, then marked seen.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || 'default';

    return NextResponse.json({
      sessionId,
      busy: isBusy(sessionId),
      ...consumeSessionJobs(sessionId),
    });
  } catch (error) {
    console.error('[api/supervisor] GET failed', error);
    return NextResponse.json({ error: 'Failed to read job status' }, { status: 500 });
  }
}
