"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';

// Live latency comparison between the sequential and parallel pipelines.
//
// Colors are slots 1 and 2 of the reference categorical palette (blue/orange),
// which are certified all-pairs in both modes and clear the 3:1 contrast floor
// on a light surface. Identity is never carried by color alone: every bar is
// direct-labeled, a legend is present, and a table view is available.

const SERIES = {
  sequential: { color: '#2a78d6', label: 'Sequential' },
  parallel: { color: '#eb6834', label: 'Parallel' },
} as const;

const TEXT_PRIMARY = '#0b0b0b';
const TEXT_SECONDARY = '#52514e';
const TEXT_MUTED = '#8a8880';
const AXIS = '#e5e5e2';

interface Stats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

interface PipelineBucket {
  turnCompletion: Stats | null;
  turnLatency: Stats | null;
  ponderRun: Stats | null;
  ponderKickoff: Stats | null;
  planItemsAdded: number;
  turns: number;
}

interface Summary {
  sessionId: string;
  byPipeline: Record<'sequential' | 'parallel' | 'unknown', PipelineBucket>;
  comparison: {
    sequentialMeanMs: number;
    parallelMeanMs: number;
    absoluteSavingMs: number;
    speedup: number;
    percentFaster: number;
  } | null;
}

interface LatencyPanelProps {
  sessionId?: string;
  /** Current scenario, so the panel can say which arm is being fed right now. */
  scenario?: string;
  className?: string;
  pollMs?: number;
}

type Pipeline = 'sequential' | 'parallel';

const fmtMs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '--' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const LatencyPanel: React.FC<LatencyPanelProps> = ({
  sessionId,
  scenario,
  className = '',
  pollMs = 2000,
}) => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Pipeline | null>(null);
  const inFlightRef = useRef(false);

  const fetchSummary = useCallback(async () => {
    if (!sessionId || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch(`/api/metrics?sessionId=${encodeURIComponent(sessionId)}`);
      if (response.ok) setSummary(await response.json());
    } catch {
      // Metrics are diagnostic; a failed poll is not worth surfacing.
    } finally {
      inFlightRef.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void fetchSummary();
    const interval = setInterval(fetchSummary, pollMs);
    return () => clearInterval(interval);
  }, [sessionId, pollMs, fetchSummary]);

  const runBenchmark = async () => {
    setBenchRunning(true);
    setBenchResult(null);
    try {
      // Feed the measured live latency in, so the modelled Ping constant is
      // this machine's real number rather than the documented default.
      const livePing =
        summary?.byPipeline.parallel.turnLatency?.p50 ??
        summary?.byPipeline.sequential.turnLatency?.p50 ??
        undefined;

      const response = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          ...(livePing ? { pingResponseMs: livePing } : {}),
        }),
      });
      const data = await response.json();

      if (!response.ok || data.error) {
        setBenchResult(`Benchmark failed: ${data.error ?? response.status}`);
      } else if (data.comparison) {
        const c = data.comparison;
        setBenchResult(
          `Scripted run: sequential ${fmtMs(c.meanUserFacingSequentialMs)} vs parallel ` +
            `${fmtMs(c.meanUserFacingParallelMs)} per turn -- ${c.speedup}x faster, ` +
            `${fmtMs(c.absoluteSavingPerTurnMs)} saved per turn. Plan items: ` +
            `${c.planItemsSequential} sequential / ${c.planItemsParallel} parallel.`,
        );
      } else {
        setBenchResult('Benchmark completed but produced no comparison.');
      }
      void fetchSummary();
    } catch (error) {
      setBenchResult(
        `Benchmark failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      setBenchRunning(false);
    }
  };

  const resetMetrics = async () => {
    if (!sessionId) return;
    await fetch(`/api/metrics?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    setSummary(null);
    setBenchResult(null);
    void fetchSummary();
  };

  const sequential = summary?.byPipeline.sequential;
  const parallel = summary?.byPipeline.parallel;
  const comparison = summary?.comparison ?? null;

  const bars: Array<{ pipeline: Pipeline; value: number; n: number }> = [];
  if (sequential?.turnCompletion)
    bars.push({
      pipeline: 'sequential',
      value: sequential.turnCompletion.mean,
      n: sequential.turns,
    });
  if (parallel?.turnCompletion)
    bars.push({ pipeline: 'parallel', value: parallel.turnCompletion.mean, n: parallel.turns });

  const axisMax = Math.max(1, ...bars.map((b) => b.value)) * 1.15;
  const activePipeline: Pipeline | null =
    scenario === 'fastTravelPlanning'
      ? 'parallel'
      : scenario === 'travelPlanning'
        ? 'sequential'
        : null;

  return (
    <div
      className={`p-3 bg-white rounded-lg border shadow-sm ${className}`}
      style={{ color: TEXT_PRIMARY }}
    >
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-medium" style={{ color: TEXT_SECONDARY }}>
          Time to answer
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={runBenchmark}
            disabled={benchRunning}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            title="Replay one fixed script through both pipelines and measure each"
          >
            {benchRunning ? 'Running A/B...' : 'Run scripted A/B'}
          </button>
          <button
            onClick={resetMetrics}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Hero figure: the one number this panel exists to show. */}
      {comparison ? (
        <div className="mb-4">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold tabular-nums" style={{ fontSize: 48, lineHeight: 1 }}>
              {comparison.speedup}&times;
            </span>
            <span className="text-sm" style={{ color: TEXT_SECONDARY }}>
              faster to answer
            </span>
          </div>
          <p className="text-xs mt-1" style={{ color: TEXT_SECONDARY }}>
            {fmtMs(comparison.absoluteSavingMs)} less waiting per turn (
            {comparison.percentFaster}% reduction), parallel vs sequential.
          </p>
        </div>
      ) : (
        <p className="text-xs mb-4" style={{ color: TEXT_MUTED }}>
          Run both scenarios (or the scripted A/B) to get a comparison. Latency is
          recorded automatically as you talk.
        </p>
      )}

      {/* Magnitude comparison. Two series, direct-labeled, legend below. */}
      {bars.length > 0 && (
        <div className="mb-3">
          <p className="text-xs mb-2" style={{ color: TEXT_SECONDARY }}>
            Mean time from end of your sentence to a finished answer
          </p>
          <div className="flex flex-col gap-[2px]">
            {bars.map((bar) => {
              const pct = Math.max(2, (bar.value / axisMax) * 100);
              const series = SERIES[bar.pipeline];
              return (
                <div
                  key={bar.pipeline}
                  className="relative flex items-center gap-2 group"
                  onMouseEnter={() => setHovered(bar.pipeline)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span
                    className="text-xs w-20 shrink-0 text-right"
                    style={{ color: TEXT_SECONDARY }}
                  >
                    {series.label}
                  </span>
                  <div className="flex-1 flex items-center gap-2 min-w-0">
                    <div
                      className="h-4 shrink-0"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: series.color,
                        borderRadius: '0 4px 4px 0',
                      }}
                    />
                    <span className="text-xs tabular-nums whitespace-nowrap" style={{ color: TEXT_PRIMARY }}>
                      {fmtMs(bar.value)}
                    </span>
                  </div>

                  {hovered === bar.pipeline && (
                    <div
                      className="absolute left-24 -top-1 z-10 px-2 py-1 rounded shadow-lg text-[11px] bg-white border"
                      style={{ color: TEXT_PRIMARY }}
                    >
                      <div className="font-medium">{series.label} pipeline</div>
                      <div style={{ color: TEXT_SECONDARY }}>
                        mean {fmtMs(bar.value)} &middot; p50{' '}
                        {fmtMs(summary?.byPipeline[bar.pipeline].turnCompletion?.p50)}{' '}
                        &middot; p95{' '}
                        {fmtMs(summary?.byPipeline[bar.pipeline].turnCompletion?.p95)}
                      </div>
                      <div style={{ color: TEXT_SECONDARY }}>{bar.n} turns measured</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-1 ml-[88px] border-t" style={{ borderColor: AXIS }} />
          <div className="ml-[88px] flex justify-between text-[10px]" style={{ color: TEXT_MUTED }}>
            <span>0</span>
            <span>{fmtMs(axisMax)}</span>
          </div>
        </div>
      )}

      {/* Legend -- always present for two or more series. */}
      {bars.length > 1 && (
        <div className="flex items-center gap-3 mb-3 text-[11px]" style={{ color: TEXT_SECONDARY }}>
          {(Object.keys(SERIES) as Pipeline[]).map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ backgroundColor: SERIES[key].color }}
              />
              {SERIES[key].label}
              {activePipeline === key && <span style={{ color: TEXT_MUTED }}>(active)</span>}
            </span>
          ))}
        </div>
      )}

      {/* KPI row: per-pipeline detail, including the work parallel hides. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        {(['sequential', 'parallel'] as Pipeline[]).map((key) => {
          const bucket = summary?.byPipeline[key];
          const series = SERIES[key];
          return (
            <div key={key} className="border rounded-lg p-2" style={{ borderColor: AXIS }}>
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className="h-2 w-2 rounded-sm shrink-0"
                  style={{ backgroundColor: series.color }}
                />
                <span className="text-xs font-medium">{series.label}</span>
                {activePipeline === key && (
                  <span className="text-[10px]" style={{ color: TEXT_MUTED }}>
                    active
                  </span>
                )}
              </div>
              <dl className="text-[11px] grid grid-cols-2 gap-x-2 gap-y-0.5">
                <dt style={{ color: TEXT_SECONDARY }}>turns</dt>
                <dd className="tabular-nums text-right">{bucket?.turns ?? 0}</dd>
                <dt style={{ color: TEXT_SECONDARY }}>answer p50</dt>
                <dd className="tabular-nums text-right">{fmtMs(bucket?.turnCompletion?.p50)}</dd>
                <dt style={{ color: TEXT_SECONDARY }}>answer p95</dt>
                <dd className="tabular-nums text-right">{fmtMs(bucket?.turnCompletion?.p95)}</dd>
                <dt
                  style={{ color: TEXT_SECONDARY }}
                  title="Time to first audio. Fast in both arms: the sequential agent opens with a filler phrase. Tracked to confirm the parallel pipeline does not regress it."
                >
                  first audio
                </dt>
                <dd className="tabular-nums text-right">{fmtMs(bucket?.turnLatency?.p50)}</dd>
                <dt style={{ color: TEXT_SECONDARY }} title="Ponder reasoning time">
                  reasoning
                </dt>
                <dd className="tabular-nums text-right">{fmtMs(bucket?.ponderRun?.mean)}</dd>
                <dt style={{ color: TEXT_SECONDARY }} title="Time Ping was blocked handing off">
                  handoff
                </dt>
                <dd className="tabular-nums text-right">
                  {fmtMs(bucket?.ponderKickoff?.mean)}
                </dd>
                <dt style={{ color: TEXT_SECONDARY }}>plan items</dt>
                <dd className="tabular-nums text-right">{bucket?.planItemsAdded ?? 0}</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {parallel?.ponderRun && parallel.ponderRun.mean > 0 && (
        <p className="text-[11px] mb-2" style={{ color: TEXT_SECONDARY }}>
          The parallel pipeline hid {fmtMs(parallel.ponderRun.mean)} of reasoning per
          run behind a {fmtMs(parallel.ponderKickoff?.mean ?? 0)} handoff.
        </p>
      )}

      <button
        onClick={() => setShowTable((value) => !value)}
        className="text-[11px] underline"
        style={{ color: TEXT_SECONDARY }}
      >
        {showTable ? 'Hide table' : 'Show table'}
      </button>

      {showTable && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <caption className="text-left mb-1" style={{ color: TEXT_SECONDARY }}>
              Time to answer by pipeline (ms)
            </caption>
            <thead>
              <tr style={{ color: TEXT_SECONDARY }}>
                <th className="text-left font-medium py-1">Pipeline</th>
                <th className="text-right font-medium py-1">n</th>
                <th className="text-right font-medium py-1">mean</th>
                <th className="text-right font-medium py-1">p50</th>
                <th className="text-right font-medium py-1">p95</th>
                <th className="text-right font-medium py-1">min</th>
                <th className="text-right font-medium py-1">max</th>
              </tr>
            </thead>
            <tbody>
              {(['sequential', 'parallel'] as Pipeline[]).map((key) => {
                const stats = summary?.byPipeline[key].turnCompletion;
                return (
                  <tr key={key} className="border-t" style={{ borderColor: AXIS }}>
                    <td className="py-1">{SERIES[key].label}</td>
                    <td className="text-right tabular-nums">{stats?.count ?? 0}</td>
                    <td className="text-right tabular-nums">{stats ? stats.mean : '--'}</td>
                    <td className="text-right tabular-nums">{stats ? stats.p50 : '--'}</td>
                    <td className="text-right tabular-nums">{stats ? stats.p95 : '--'}</td>
                    <td className="text-right tabular-nums">{stats ? stats.min : '--'}</td>
                    <td className="text-right tabular-nums">{stats ? stats.max : '--'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {benchResult && (
        <p className="mt-2 text-[11px] p-2 rounded bg-gray-50" style={{ color: TEXT_SECONDARY }}>
          {benchResult}
        </p>
      )}
    </div>
  );
};

export default LatencyPanel;
