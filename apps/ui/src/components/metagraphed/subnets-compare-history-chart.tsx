import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { classNames } from "@/lib/metagraphed/format";
import {
  OVERLAY_METRICS,
  OVERLAY_METRIC_LABEL,
  buildOverlayModel,
  formatOverlayValue,
  overlayColor,
  overlayTotalPoints,
  type OverlayMetric,
  type OverlayModel,
} from "@/lib/metagraphed/overlay-history";

// Mirrors the window selector on SubnetHistoryChart / NeuronHistoryChart so
// the picker feels the same in either place.
type Win = "7d" | "30d" | "90d" | "1y" | "all";
const WINDOWS: Win[] = ["7d", "30d", "90d", "1y", "all"];

// Fixed SVG viewBox; `preserveAspectRatio="none"` lets the container width
// drive the actual pixel size, matching how Sparkline scales.
const CHART_W = 640;
const CHART_H = 200;
const PAD_X = 6;
const PAD_Y = 6;

/**
 * Multi-subnet overlay chart for the compare drawer (#6885). One `useQueries`
 * call fans out to /subnets/{netuid}/history (the same endpoint SubnetHistoryChart
 * already uses per-subnet) and renders one polyline per subnet on a shared axis.
 * Chart primitives (colors, SVG path shape, aria wiring) mirror Sparkline so no
 * new charting stack is introduced.
 */
export function SubnetsCompareHistoryChart({ netuids }: { netuids: number[] }) {
  const [win, setWin] = useState<Win>("90d");
  const [metric, setMetric] = useState<OverlayMetric>("stake");

  const queries = useQueries({
    queries: netuids.map((n) => ({ ...subnetHistoryQuery(n, win), retry: 0 })),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const allErrored = queries.length > 0 && queries.every((q) => q.isError);
  const firstError = queries.find((q) => q.isError);

  const inputs = netuids.map((n, i) => ({
    netuid: n,
    points: queries[i]?.data?.data?.points ?? [],
  }));
  const model = buildOverlayModel(inputs, metric);
  const hasData = overlayTotalPoints(model) > 0;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MetricPicker value={metric} onChange={setMetric} />
        <WindowPicker value={win} onChange={setWin} />
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : allErrored ? (
        <ErrorState
          error={firstError?.error}
          onRetry={() => {
            for (const q of queries) q.refetch();
          }}
          context="compare history"
        />
      ) : !hasData ? (
        <EmptyState
          title="No on-chain history"
          description="Selected subnets have no daily snapshots for this metric and window yet."
        />
      ) : (
        <>
          <OverlayChart model={model} metric={metric} netuids={netuids} />
          <OverlayLegend netuids={netuids} model={model} metric={metric} />
        </>
      )}
    </div>
  );
}

function MetricPicker({
  value,
  onChange,
}: {
  value: OverlayMetric;
  onChange: (m: OverlayMetric) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Overlay metric"
      className="inline-flex flex-wrap rounded-md border border-border bg-surface/40 p-0.5"
    >
      {OVERLAY_METRICS.map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={m === value}
          onClick={() => onChange(m)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            m === value ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {OVERLAY_METRIC_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

function WindowPicker({ value, onChange }: { value: Win; onChange: (w: Win) => void }) {
  return (
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
          aria-selected={w === value}
          onClick={() => onChange(w)}
          className={classNames(
            "px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider rounded transition-colors",
            w === value ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

function OverlayChart({
  model,
  metric,
  netuids,
}: {
  model: OverlayModel;
  metric: OverlayMetric;
  netuids: number[];
}) {
  const innerW = CHART_W - PAD_X * 2;
  const innerH = CHART_H - PAD_Y * 2;
  const tSpan = model.tMax - model.tMin || 1;
  const vSpan = model.vMax - model.vMin || 1;

  const toX = (t: number) => PAD_X + ((t - model.tMin) / tSpan) * innerW;
  const toY = (v: number) => PAD_Y + innerH - ((v - model.vMin) / vSpan) * innerH;

  const ariaLabel = `${OVERLAY_METRIC_LABEL[metric]} history overlay for subnets ${netuids.join(", ")}`;

  const maxLabel = formatOverlayValue(metric, model.vMax);
  const minLabel = formatOverlayValue(metric, model.vMin);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-stretch gap-2">
        <div
          aria-hidden
          className="flex w-14 shrink-0 flex-col justify-between font-mono text-[10px] tabular-nums text-ink-muted"
        >
          <span className="text-right">{maxLabel}</span>
          <span className="text-right">{minLabel}</span>
        </div>
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          className="block h-40 w-full sm:h-48"
        >
          <line
            x1={PAD_X}
            x2={CHART_W - PAD_X}
            y1={PAD_Y + innerH}
            y2={PAD_Y + innerH}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <line
            x1={PAD_X}
            x2={CHART_W - PAD_X}
            y1={PAD_Y}
            y2={PAD_Y}
            stroke="var(--border)"
            strokeDasharray="2 3"
            strokeWidth={1}
          />
          {model.series.map((s, i) => {
            if (s.points.length === 0) return null;
            const color = overlayColor(i);
            const d = s.points
              .map((pt, j) => {
                if (s.points.length === 1) {
                  const cx = PAD_X + innerW / 2;
                  const cy = toY(pt.v);
                  return `M${cx.toFixed(1)},${cy.toFixed(1)}`;
                }
                const x = toX(pt.t).toFixed(1);
                const y = toY(pt.v).toFixed(1);
                return `${j === 0 ? "M" : "L"}${x},${y}`;
              })
              .join(" ");
            return (
              <path
                key={s.netuid}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function OverlayLegend({
  netuids,
  model,
  metric,
}: {
  netuids: number[];
  model: OverlayModel;
  metric: OverlayMetric;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {netuids.map((n, i) => {
        const s = model.series[i];
        const last = s?.points[s.points.length - 1];
        const color = overlayColor(i);
        return (
          <li
            key={n}
            className="inline-flex items-baseline gap-1.5 font-mono text-[11px] text-ink-strong"
          >
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 translate-y-[-1px] rounded-sm"
              style={{ backgroundColor: color }}
            />
            <span>SN{n}</span>
            <span className="tabular-nums text-ink-muted">
              {last ? formatOverlayValue(metric, last.v) : "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
