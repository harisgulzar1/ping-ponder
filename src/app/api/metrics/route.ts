import { NextRequest, NextResponse } from 'next/server';

import { clear, record, summarize, type MetricKind } from '@/app/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_KINDS: MetricKind[] = [
  'turn_latency',
  'turn_completion',
  'ponder_run',
  'ponder_kickoff',
  'plan_items_added',
  'benchmark_turn',
];

/**
 * POST /api/metrics
 * Body: { sessionId, scenario, kind, ms, detail? }
 *
 * Used by the browser to report the headline number -- time from the user
 * finishing their sentence to the first byte of assistant audio. That can only
 * be measured client-side, so it is posted here to sit alongside the
 * server-measured Ponder timings.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, scenario, kind, ms, detail } = body ?? {};

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!ALLOWED_KINDS.includes(kind)) {
      return NextResponse.json({ error: `Invalid kind: ${kind}` }, { status: 400 });
    }
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return NextResponse.json({ error: 'ms must be a non-negative number' }, { status: 400 });
    }

    const event = record({
      sessionId,
      scenario: typeof scenario === 'string' ? scenario : 'unknown',
      kind,
      ms,
      detail: detail && typeof detail === 'object' ? detail : undefined,
    });

    return NextResponse.json({ success: true, event });
  } catch (error) {
    console.error('[api/metrics] POST failed', error);
    return NextResponse.json({ error: 'Failed to record metric' }, { status: 500 });
  }
}

/** GET /api/metrics?sessionId=X -- per-pipeline stats plus the head-to-head comparison. */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || 'default';
    const includeEvents = searchParams.get('events') === 'true';

    const summary = summarize(sessionId);
    if (!includeEvents) {
      return NextResponse.json({ ...summary, events: undefined, eventCount: summary.events.length });
    }
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[api/metrics] GET failed', error);
    return NextResponse.json({ error: 'Failed to read metrics' }, { status: 500 });
  }
}

/** DELETE /api/metrics?sessionId=X -- reset before a clean measurement run. */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || 'default';
    clear(sessionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/metrics] DELETE failed', error);
    return NextResponse.json({ error: 'Failed to clear metrics' }, { status: 500 });
  }
}
