// Client-side helpers for resolving who/what a tool call belongs to.
//
// The previous build read `details.context.sessionId` and silently fell back to
// the literal string 'default' whenever that lookup missed -- which it did,
// because the body passed to the reasoning call never carried a `context` key
// at all. Every supervisor write therefore landed in a 'default' bucket while
// the UI polled a UUID-keyed one.
//
// These helpers try the plausible SDK context shapes and then fall back to
// localStorage, which App.tsx always populates. That makes session identity
// independent of the SDK's internal context wrapping.

import { getStoredItem } from '@/app/lib/safeStorage';

export const SESSION_STORAGE_KEY = 'travelSessionId';

export type ScenarioKey = 'travelPlanning' | 'fastTravelPlanning' | string;

function readFromContext(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== 'object') return undefined;

  const outer = (details as Record<string, any>).context;
  // The SDK may hand us the user context directly, or a RunContext wrapping it.
  const candidates = [outer, outer?.context];

  for (const candidate of candidates) {
    const value = candidate?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function resolveSessionId(details?: unknown): string {
  const fromContext = readFromContext(details, 'sessionId');
  if (fromContext) return fromContext;

  // Blocked storage must not throw here: this runs inside every agent tool
  // call, and a raised exception would fail the tool rather than the lookup.
  const stored = getStoredItem(SESSION_STORAGE_KEY);
  if (stored) return stored;

  return 'default';
}

export function resolveScenario(details?: unknown): ScenarioKey {
  const fromContext = readFromContext(details, 'scenario');
  if (fromContext) return fromContext;

  if (typeof window !== 'undefined') {
    const param = new URLSearchParams(window.location.search).get('agentConfig');
    if (param) return param;
  }

  return 'travelPlanning';
}

export type Breadcrumb = (title: string, data?: unknown) => void;

export function resolveBreadcrumb(details?: unknown): Breadcrumb | undefined {
  if (!details || typeof details !== 'object') return undefined;

  const outer = (details as Record<string, any>).context;
  const candidates = [outer, outer?.context];

  for (const candidate of candidates) {
    const fn = candidate?.addTranscriptBreadcrumb;
    if (typeof fn === 'function') return fn as Breadcrumb;
  }
  return undefined;
}

/**
 * The live transcript, used as Ponder's view of the conversation.
 * Returns simple {role, content} pairs; the server does not need SDK types.
 */
export function resolveHistory(details?: unknown): Array<{ role: string; content: string }> {
  if (!details || typeof details !== 'object') return [];

  const outer = (details as Record<string, any>).context;
  const candidates = [outer, outer?.context];

  for (const candidate of candidates) {
    const history = candidate?.history;
    if (!Array.isArray(history)) continue;

    return history
      .filter((item: any) => item?.type === 'message')
      .map((item: any) => {
        const content = Array.isArray(item.content)
          ? item.content
              .map((part: any) => part?.text ?? part?.transcript ?? '')
              .filter(Boolean)
              .join(' ')
          : typeof item.content === 'string'
            ? item.content
            : '';
        return { role: item.role ?? 'user', content: content.trim() };
      })
      .filter((item: { content: string }) => item.content.length > 0);
  }

  return [];
}
