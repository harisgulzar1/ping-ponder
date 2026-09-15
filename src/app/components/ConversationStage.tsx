"use client";

import React, { useEffect, useRef, useState } from 'react';

import {
  INTENT_SLOT_NAMES,
  PLAN_CATEGORIES,
  type PlanCategory,
  type TravelState,
} from '@/app/agentConfigs/TravelPlanningAgent/stateTypes';

interface ConversationStageProps {
  sessionId?: string;
  className?: string;
  /** Poll interval. 1s keeps background plan growth visible in near real time. */
  pollMs?: number;
}

interface JobSnapshot {
  running: boolean;
  runningForMs: number | null;
  finishedSinceLastCheck: Array<{
    jobId: string;
    status: string;
    durationMs: number;
    planItemsAdded: number;
  }>;
}

interface StageInfo {
  state: TravelState;
  phase: string;
  intentStatus: string;
  emptySlots: string[];
  isComplete: boolean;
  planGaps: PlanCategory[];
  planItemCount: number;
  isPlanComplete: boolean;
  jobs: JobSnapshot;
}

/** How long a newly added plan item stays highlighted. */
const NEW_ITEM_WINDOW_MS = 10_000;

const PHASE_LABELS: Record<string, string> = {
  intent_clarification: 'Intent Clarification',
  plan_sharing: 'Plan Sharing',
  refinement: 'Refinement',
  final: 'Final',
};

const PHASE_COLORS: Record<string, string> = {
  intent_clarification: 'bg-blue-100 text-blue-800 border-blue-200',
  plan_sharing: 'bg-green-100 text-green-800 border-green-200',
  refinement: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  final: 'bg-purple-100 text-purple-800 border-purple-200',
};

const INTENT_STATUS_COLORS: Record<string, string> = {
  unclear: 'bg-red-100 text-red-800',
  partially_clear: 'bg-yellow-100 text-yellow-800',
  clear: 'bg-green-100 text-green-800',
  refined: 'bg-blue-100 text-blue-800',
  locked: 'bg-purple-100 text-purple-800',
};

const SLOT_COLORS: Record<string, string> = {
  empty: 'bg-gray-50 text-gray-700 border-gray-200',
  proposed: 'bg-yellow-50 text-yellow-900 border-yellow-200',
  confirmed: 'bg-green-50 text-green-900 border-green-200',
};

const ConversationStage: React.FC<ConversationStageProps> = ({
  sessionId,
  className = '',
  pollMs = 1000,
}) => {
  const [stageInfo, setStageInfo] = useState<StageInfo | null>(null);
  // Only show the spinner on the very first fetch. The previous version set a
  // loading flag on every poll and early-returned, so the panel blanked out
  // once per cycle and never settled.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    const fetchStageInfo = async () => {
      // Skip if the previous poll is still outstanding.
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      try {
        const response = await fetch(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
        if (!response.ok) throw new Error(`state read failed (${response.status})`);
        const data = await response.json();
        if (cancelled) return;
        setStageInfo(data as StageInfo);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load state');
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setHasLoaded(true);
      }
    };

    void fetchStageInfo();
    const interval = setInterval(fetchStageInfo, pollMs);
    // Separate ticker so "new" highlights expire even when state is static.
    const ticker = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(ticker);
    };
  }, [sessionId, pollMs]);

  if (!hasLoaded) {
    return (
      <div className={`p-3 bg-gray-50 rounded-lg border ${className}`}>
        <div className="flex items-center space-x-2">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
          <span className="text-sm text-gray-600">Loading conversation stage...</span>
        </div>
      </div>
    );
  }

  if (!stageInfo) {
    return (
      <div className={`p-3 bg-white rounded-lg border ${className}`}>
        <span className="text-sm text-red-700">{error ?? 'No state available.'}</span>
      </div>
    );
  }

  const { state, jobs } = stageInfo;

  return (
    <div className={`p-3 bg-white rounded-lg border shadow-sm ${className}`}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-700">Conversation Stage</h3>
          {jobs?.running && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-100 text-indigo-800 border border-indigo-200">
              <span className="animate-pulse h-1.5 w-1.5 rounded-full bg-indigo-600" />
              Ponder thinking
              {jobs.runningForMs !== null && ` ${(jobs.runningForMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium border ${
              PHASE_COLORS[stageInfo.phase] ?? 'bg-gray-100 text-gray-800 border-gray-200'
            }`}
          >
            {PHASE_LABELS[stageInfo.phase] ?? stageInfo.phase}
          </span>
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              INTENT_STATUS_COLORS[stageInfo.intentStatus] ?? 'bg-gray-100 text-gray-800'
            }`}
          >
            {stageInfo.intentStatus.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {stageInfo.emptySlots.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-gray-600 mb-1">Still need:</p>
          <div className="flex flex-wrap gap-1">
            {stageInfo.emptySlots.map((slot) => (
              <span
                key={slot}
                className="px-2 py-1 bg-orange-100 text-orange-800 text-xs rounded"
              >
                {slot}
              </span>
            ))}
          </div>
        </div>
      )}

      {stageInfo.isComplete && (
        <div className="mb-3">
          <span className="text-xs text-green-700 font-medium">
            &#10003; All required information collected
          </span>
        </div>
      )}

      {/* Intent slots */}
      <div className="mb-4">
        <p className="text-xs text-gray-600 mb-2">Intent details</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {INTENT_SLOT_NAMES.map((slotName) => {
            const slot = state.intent_clarification[slotName];
            return (
              <div
                key={slotName}
                className={`border rounded-lg p-2 flex flex-col gap-1 ${
                  SLOT_COLORS[slot.status] ?? SLOT_COLORS.empty
                }`}
              >
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="uppercase tracking-wide">{slotName}</span>
                  <span className="px-2 py-0.5 rounded-full border text-[11px]">
                    {slot.status}
                  </span>
                </div>
                <div className="text-sm text-gray-900 break-words">
                  {slot.value || <span className="text-gray-500">Not provided yet</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Plan -- this is what Ponder fills in the background. Previously the UI
          never rendered it at all, so the parallel pipeline's work was invisible. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-gray-600">
            Travel plan
            <span className="ml-1 text-gray-400">
              ({stageInfo.planItemCount} item{stageInfo.planItemCount === 1 ? '' : 's'})
            </span>
          </p>
          {stageInfo.isPlanComplete ? (
            <span className="text-[11px] text-green-700 font-medium">plan complete</span>
          ) : (
            <span className="text-[11px] text-gray-500">
              {stageInfo.planGaps.length} categor
              {stageInfo.planGaps.length === 1 ? 'y' : 'ies'} still thin
            </span>
          )}
        </div>

        {stageInfo.planItemCount === 0 ? (
          <p className="text-xs text-gray-500 italic">
            Nothing yet. Items appear here as research completes.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PLAN_CATEGORIES.filter(
              (category) => state.plan_sharing[category].length > 0,
            ).map((category) => (
              <div key={category} className="border rounded-lg p-2 bg-gray-50 border-gray-200">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-600 mb-1">
                  {category}
                </div>
                <ul className="flex flex-col gap-1">
                  {state.plan_sharing[category].map((item) => {
                    const isNew = now - item.addedAt < NEW_ITEM_WINDOW_MS;
                    return (
                      <li
                        key={`${category}-${item.value}`}
                        className={`text-sm flex items-start gap-1.5 rounded px-1 py-0.5 transition-colors ${
                          isNew ? 'bg-indigo-50' : ''
                        }`}
                      >
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                            item.status === 'confirmed' ? 'bg-green-600' : 'bg-yellow-500'
                          }`}
                          title={item.status}
                        />
                        <span className="text-gray-900 break-words">{item.value}</span>
                        {item.source === 'ponder' && (
                          <span
                            className="text-[10px] text-indigo-700 shrink-0 mt-0.5"
                            title="Added by the background reasoning agent"
                          >
                            ponder
                          </span>
                        )}
                        {isNew && (
                          <span className="text-[10px] font-medium text-indigo-700 shrink-0 mt-0.5">
                            new
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </div>
  );
};

export default ConversationStage;
