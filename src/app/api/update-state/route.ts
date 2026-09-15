import { NextRequest, NextResponse } from 'next/server';

import * as store from '@/app/agentConfigs/TravelPlanningAgent/stateStore';
import { clearSession } from '@/app/agentConfigs/TravelPlanningAgent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/update-state
 *
 * Legacy mutation endpoint, kept so older clients keep working. It now writes
 * through the same single store as everything else. New code should use
 * POST /api/state.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, action, data } = body ?? {};

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
    }

    const source = data?.source === 'ponder' ? 'ponder' : 'ping';

    switch (action) {
      case 'updateSlot':
        await store.updateSlot(
          sessionId,
          data.slotName,
          data.value,
          data.status ?? 'confirmed',
          source,
        );
        break;

      case 'addPlanItem':
        await store.addPlanItem(
          sessionId,
          data.category,
          data.value,
          data.status ?? 'proposed',
          source,
        );
        break;

      case 'updateMeta':
        await store.updateMeta(sessionId, data?.conversation_phase, data?.intent_status);
        break;

      case 'logConversation':
        store.logChange(sessionId, `conversation:${data?.type ?? 'entry'}`, {
          content: data?.content,
          metadata: data?.metadata,
        });
        break;

      case 'resetState':
        clearSession(sessionId);
        await store.resetState(sessionId);
        break;

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/update-state] POST failed', error);
    const message = error instanceof Error ? error.message : 'Failed to update state';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
