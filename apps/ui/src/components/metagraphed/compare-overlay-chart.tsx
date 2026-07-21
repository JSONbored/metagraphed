import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import {
  buildOverlaySeries,
  OVERLAY_METRICS,
  type OverlayMetric,
} from "@/lib/metagraphed/compare-overlay-series";
import { MultiSeriesLineChart } from "@/components/metagraphed/charts/multi-series-line-chart";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

// Lowercase windows, mirroring subnet-history-chart.tsx / the /history API.
type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

// Categorical series palette (--chart-1..6, styles.css). The compare selection
// caps at 4 (useCompareSelection MAX), so four colours suffice.
const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/**
 * #6885: overlay every selected subnet's daily /history for one metric on a
 * single shared-axis chart — the aggregate-comparison the metrics-grid tab
 * (CompareGrid) can't show. Fans out one subnetHistoryQuery per selected netuid
 * (the same per-subnet endpoint the detail page already uses), aligns them via
 * buildOverlaySeries, and draws one line per subnet. A cold selection (no
 * history yet) renders an empty state, never a broken chart.
 */
export function CompareOverlayChart({ netuids }: { netuids: number[] }) {
  const [win, setWin] = useState<Win>("90d");
  const [metric, setMetric] = useState<OverlayMetric>("stake");

  const results = useQueries({
    queries: netuids.map((netuid) => subnetHistoryQuery(netuid, win)),
  });

  const isLoading = results.some((result) => result.isLoading);
  const allError = results.length > 0 && results.every((result) => result.isError);
  const firstError = results.find((result) => result.isError)?.error;

  const histories = netuids.map((netuid, index) => ({
    netuid,
    points: (results[index]?.data?.data?.points ?? []) as SubnetHistoryPoint[],
  }));

  const metricDef = OVERLAY_METRICS.find((m) => m.key === metric) ?? OVERLAY_METRICS[0];
  const chart = buildOverlaySeries(histories, metric, SERIES_COLORS);
  const fmt = metricDef.tao ? formatTao : formatNumber;

  const metricSelector = (
    <div
      role="tablist"
      aria-label="Overlay metric"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {OVERLAY_METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={m.key === metric}
          onClick={() => setMetric(m.key)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            m.key === metric ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  const windowSelector = (
    <div
      role="tablist"
      aria-label="History window"
      className="inline-flex rounded-md border border-border bg-surface/40 p-0.5"
    >
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={w === win}
          onClick={() => setWin(w)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            w === win ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {metricSelector}
        {windowSelector}
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : allError ? (
        <ErrorState error={firstError} context="subnet history overlay" />
      ) : chart.empty ? (
        <EmptyState
          title="No on-chain history"
          description="Daily snapshots will appear here once enough chain history has accumulated for the selected subnets."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          {/* Legend: one swatch + subnet + latest value per line. */}
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {chart.series.map((line) => (
              <span
                key={line.netuid}
                className="inline-flex items-center gap-1.5 font-mono text-[11px]"
              >
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: line.color }}
                />
                <span className="text-ink-strong">SN{line.netuid}</span>
                <span className="tabular-nums text-ink-muted">
                  {line.lastValue != null ? fmt(line.lastValue) : "—"}
                </span>
              </span>
            ))}
          </div>

          <div className="relative">
            {/* Shared-axis max/min readouts (metric scale). */}
            <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between font-mono text-[10px] tabular-nums text-ink-muted">
              <span>{fmt(chart.max)}</span>
              <span>{fmt(chart.min)}</span>
            </div>
            <div className="pl-14">
              <MultiSeriesLineChart
                series={chart.series}
                dateCount={chart.dates.length}
                min={chart.min}
                max={chart.max}
                ariaLabel={`${metricDef.label} over the ${win} window for ${chart.series
                  .map((s) => `SN${s.netuid}`)
                  .join(", ")}`}
              />
            </div>
          </div>

          {chart.dates.length > 0 ? (
            <div className="mt-1.5 flex justify-between pl-14 font-mono text-[10px] tabular-nums text-ink-muted">
              <span>{chart.dates[0]}</span>
              <span>{chart.dates[chart.dates.length - 1]}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
