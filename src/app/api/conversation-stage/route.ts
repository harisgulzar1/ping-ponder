import { NextRequest, NextResponse } from 'next/server';

import * as store from '@/app/agentConfigs/TravelPlanningAgent/stateStore';
import { deriveState } from '@/app/agentConfigs/TravelPlanningAgent/stateTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversation-stage?sessionId=X
 *
 * Kept for backwards compatibility with the original response shape.
 * New code should use /api/state, which also returns plan gaps and job status.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || 'default';

    const state = await store.readState(sessionId);
    const derived = deriveState(state);

    return NextResponse.json({
      phase: derived.phase,
      intentStatus: derived.intentStatus,
      emptySlots: derived.emptySlots,
      isComplete: derived.isComplete,
      state,
    });
  } catch (error) {
    console.error('[api/conversation-stage] GET failed', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversation stage' },
      { status: 500 },
    );
  }
}
