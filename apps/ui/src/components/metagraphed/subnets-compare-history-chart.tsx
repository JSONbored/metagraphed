import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import {
  SUBNET_HISTORY_METRICS,
  SUBNET_HISTORY_WINDOWS,
  buildOverlayGeometry,
  type SubnetHistoryMetricKey,
  type SubnetHistoryWindow,
} from "@/lib/metagraphed/subnet-history-metrics";
import { COMPARE_BODY_CLASS } from "@/lib/metagraphed/compare-drawer-layout";

// viewBox units. The SVG scales to its container via preserveAspectRatio="none",
// with non-scaling strokes so lines stay hairline-thin at any width.
const VIEW_W = 600;
const VIEW_H = 160;

/**
 * Multi-subnet history overlay for the compare drawer (#6885). Fetches
 * /subnets/{netuid}/history once per selected subnet and draws them on ONE set
 * of shared axes — the time-series counterpart to CompareGrid's instant-metrics
 * table.
 *
 * The metric list and window list come from lib/metagraphed/subnet-history-metrics,
 * the same source SubnetHistoryChart uses for a single subnet, so the picker
 * offers exactly what the per-subnet chart already exposes. Selection (and its
 * cap) stays owned by useCompareSelection — this component only reads the
 * netuids it is handed.
 */
export function SubnetsCompareHistoryChart({ netuids }: { netuids: number[] }) {
  const [win, setWin] = useState<SubnetHistoryWindow>("90d");
  const [metricKey, setMetricKey] = useState<SubnetHistoryMetricKey>("stake");

  const metric =
    SUBNET_HISTORY_METRICS.find((m) => m.key === metricKey) ?? SUBNET_HISTORY_METRICS[0]!;

  const results = useQueries({
    queries: netuids.map((netuid) => ({ ...subnetHistoryQuery(netuid, win), retry: 0 })),
  });

  const isPending = results.some((r) => r.isPending);
  const isError = results.some((r) => r.isError);

  // Cheap enough to derive on every render (the API caps a window at a few
  // hundred daily points, times at most useCompareSelection's 4 subnets), so
  // this stays a plain derivation rather than a memo keyed on unstable arrays.
  const geo = buildOverlayGeometry(
    netuids.map((netuid, i) => ({ netuid, points: results[i]?.data?.data?.points ?? [] })),
    metric.field,
    VIEW_W,
    VIEW_H,
  );

  const format = (v: number | null) =>
    v == null ? "—" : metric.format ? metric.format(v) : formatNumber(v);

  // Each group stays a single non-wrapping row and scrolls horizontally if it
  // still cannot fit: a segmented control that wraps orphans its last option
  // inside the shared border and reads as broken. The two groups stack at <sm
  // (both are full-width rows) and sit on one line from sm up.
  const groupClass =
    "inline-flex max-w-full shrink-0 overflow-x-auto rounded-md border border-border bg-surface/40 p-0.5";
  const buttonClass = (active: boolean) =>
    classNames(
      "shrink-0 whitespace-nowrap rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
      active ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
    );

  const controls = (
    <div className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div role="tablist" aria-label="Overlay metric" className={groupClass}>
        {SUBNET_HISTORY_METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === metric.key}
            onClick={() => setMetricKey(m.key)}
            className={buttonClass(m.key === metric.key)}
          >
            {m.shortLabel}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label="History window" className={groupClass}>
        {SUBNET_HISTORY_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            role="tab"
            aria-selected={w === win}
            onClick={() => setWin(w)}
            className={buttonClass(w === win)}
          >
            {w}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={COMPARE_BODY_CLASS}>
      {controls}
      <div className="px-3 pb-3">
        {isPending ? (
          <div className="h-28 w-full animate-pulse sm:h-40 rounded-lg bg-border/40" />
        ) : isError ? (
          <div className="py-6 text-center">
            <p className="font-mono text-[11px] text-ink-muted">Could not load history.</p>
            <button
              type="button"
              onClick={() => results.forEach((r) => void r.refetch())}
              className="mt-2 inline-flex h-7 items-center rounded-full border border-border bg-paper px-3 font-mono text-[10px] uppercase tracking-widest text-ink-strong transition-colors hover:border-accent/60 hover:text-accent"
            >
              Retry
            </button>
          </div>
        ) : !geo ? (
          <p className="py-6 text-center font-mono text-[11px] text-ink-muted">
            No on-chain history for the selected subnets in this window.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-stretch gap-2 rounded-lg border border-border bg-card p-3">
              <svg
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                preserveAspectRatio="none"
                className="h-28 w-full min-w-0 flex-1 sm:h-40"
                role="img"
                aria-label={`${metric.label} over ${win} for ${netuids
                  .map((n) => `SN${n}`)
                  .join(", ")}`}
              >
                {geo.series.map((s) =>
                  s.path ? (
                    <path
                      key={s.netuid}
                      d={s.path}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null,
                )}
              </svg>
              {/* Shared y domain, so the series are directly comparable. Sits
                  beside the plot rather than over it — overlaid, these labels
                  collided with the lines they annotate. */}
              <div className="flex shrink-0 flex-col justify-between text-right font-mono text-[10px] text-ink-muted">
                <span>{format(geo.max)}</span>
                <span>{format(geo.min)}</span>
              </div>
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
              <span>{geo.dates[0]}</span>
              <span>{geo.dates[geo.dates.length - 1]}</span>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
              {geo.series.map((s) => (
                <li key={s.netuid} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="font-mono text-[11px] text-ink-strong">SN{s.netuid}</span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                    {format(s.last)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
