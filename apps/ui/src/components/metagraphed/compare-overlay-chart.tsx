import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { subnetHistoryQuery } from "@/lib/metagraphed/queries";
import { EmptyState } from "@/components/metagraphed/states";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import {
  buildOverlaySeries,
  overlayDomain,
  OVERLAY_METRICS,
  type OverlayMetric,
  type SubnetHistory,
} from "@/lib/metagraphed/compare-overlay";
import type { SubnetHistoryPoint } from "@/lib/metagraphed/types";

const VIEW_W = 640;
const VIEW_H = 180;
const PAD = 6;

// #6885: overlay the /history series of several selected subnets on one chart,
// reusing the same metric keys subnet-history-chart.tsx exposes per subnet. One
// useQueries batch fans out the already-shipped per-subnet history endpoint; the
// series math lives in the unit-tested compare-overlay model.
export function CompareOverlayChart({ netuids }: { netuids: number[] }) {
  const [metric, setMetric] = useState<OverlayMetric>("total_stake_tao");

  const results = useQueries({
    queries: netuids.map((netuid) => subnetHistoryQuery(netuid, "90d")),
  });

  const histories = useMemo<SubnetHistory[]>(
    () =>
      netuids.map((netuid, i) => ({
        netuid,
        points: (results[i]?.data?.data?.points ?? []) as SubnetHistoryPoint[],
      })),
    [netuids, results],
  );

  const metricDef = OVERLAY_METRICS.find((m) => m.key === metric)!;
  const series = useMemo(() => buildOverlaySeries(histories, metric), [histories, metric]);
  const domain = useMemo(() => overlayDomain(series), [series]);
  const isLoading = results.some((r) => r.isLoading);
  const fmt = (v: number) => (metricDef.isTao ? formatTao(v) : formatNumber(v));

  const metricPicker = (
    <div
      role="tablist"
      aria-label="Overlay metric"
      className="inline-flex flex-wrap rounded-md border border-border bg-surface/40 p-0.5"
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

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          History overlay
        </span>
        {metricPicker}
      </div>

      {isLoading ? (
        <div className="h-44 w-full animate-pulse rounded-xl border border-border bg-card" />
      ) : series.length === 0 || domain == null ? (
        <EmptyState
          title="No overlapping history"
          description="None of the selected subnets has enough on-chain history for this metric yet. Try another metric or different subnets."
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width="100%"
            height={VIEW_H}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${metricDef.label} over time overlaid across ${series.length} subnet${series.length === 1 ? "" : "s"}`}
          >
            {series.map((s) => (
              <polyline
                key={s.netuid}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={polylinePoints(s.values, domain)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {/* Legend: one swatch per subnet with its latest value. */}
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {series.map((s) => (
              <li key={s.netuid} className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-sm"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-ink-strong">SN{s.netuid}</span>
                {s.last != null ? <span className="text-ink-muted">{fmt(s.last)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Map a value series onto the shared [min,max] domain across the fixed viewBox,
// oldest→newest left→right. A flat domain (min===max) pins to the vertical middle.
function polylinePoints(values: number[], domain: { min: number; max: number }): string {
  const span = domain.max - domain.min;
  const n = values.length;
  const innerW = VIEW_W - PAD * 2;
  const innerH = VIEW_H - PAD * 2;
  return values
    .map((v, i) => {
      const x = PAD + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
      const t = span === 0 ? 0.5 : (v - domain.min) / span;
      const y = PAD + (1 - t) * innerH; // invert: higher value → higher on screen
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
