import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetHealthTrendsQuery,
  subnetHealthPercentilesQuery,
  trendSurfaceSeries,
} from "@/lib/metagraphed/queries";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { classNames } from "@/lib/metagraphed/format";
import type { SurfaceLatencyPercentiles } from "@/lib/metagraphed/types";

type Win = "7d" | "30d";

/**
 * The /health/percentiles artifact is a per-surface array, not a single object.
 * Aggregate the real per-surface p50/p95 into one subnet-level figure by
 * averaging across surfaces that reported each percentile (no synthesis).
 */
function aggregatePercentiles(rows: SurfaceLatencyPercentiles[] | undefined): {
  p50?: number;
  p95?: number;
} {
  if (!rows || rows.length === 0) return {};
  const avg = (
    pick: (l: NonNullable<SurfaceLatencyPercentiles["latency_ms"]>) => number | undefined,
  ) => {
    const vals = rows
      .map((r) => (r.latency_ms ? pick(r.latency_ms) : undefined))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  };
  return { p50: avg((l) => l.p50), p95: avg((l) => l.p95) };
}

export function HealthTrends({ netuid }: { netuid: number }) {
  const [win, setWin] = useState<Win>("7d");
  const { data: trendsRes, isLoading } = useQuery(subnetHealthTrendsQuery(netuid));
  const { data: pctRes } = useQuery(subnetHealthPercentilesQuery(netuid));
  // The window is an aggregate snapshot with a per-surface breakdown (no time
  // dimension), so these series are distributions ACROSS surfaces, worst-uptime
  // first — not a time-series. Headline uptime reads the window aggregate.
  const window = trendsRes?.data?.windows?.[win];
  const { uptimePct: uptimeSeries, p50: p50Series, p95: p95Series } = trendSurfaceSeries(window);
  const windowUptime = typeof window?.uptime_ratio === "number" ? window.uptime_ratio * 100 : null;
  const hasData = (window?.surfaces?.length ?? 0) > 0;
  const pct = aggregatePercentiles(pctRes?.data);

  return (
    <SectionAnchor
      id="health-trends"
      title="Health by surface"
      subtitle="Window uptime and latency percentiles, spread across surfaces."
      info="GET /api/v1/subnets/{netuid}/health/trends"
      right={
        <div className="inline-flex rounded-md border border-border bg-surface/40 p-0.5">
          {(["7d", "30d"] as Win[]).map((w) => (
            <button
              key={w}
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
      }
    >
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !hasData ? (
        <EmptyState
          title="No trend data"
          description="Per-surface health will appear here once the registry has enough samples."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <TrendCard
            label="Uptime"
            value={windowUptime != null ? `${windowUptime.toFixed(2)}%` : "—"}
            series={uptimeSeries}
            color="var(--health-ok, #4ade80)"
          />
          <TrendCard
            label="Latency p50"
            value={
              pct.p50 != null
                ? `${Math.round(pct.p50)} ms`
                : p50Series.length
                  ? `${Math.round(p50Series[p50Series.length - 1]!)} ms`
                  : "—"
            }
            series={p50Series}
            color="var(--accent, #7aa2ff)"
          />
          <TrendCard
            label="Latency p95"
            value={
              pct.p95 != null
                ? `${Math.round(pct.p95)} ms`
                : p95Series.length
                  ? `${Math.round(p95Series[p95Series.length - 1]!)} ms`
                  : "—"
            }
            series={p95Series}
            color="var(--health-warn, #fbbf24)"
          />
        </div>
      )}
    </SectionAnchor>
  );
}

function TrendCard({
  label,
  value,
  series,
  color,
}: {
  label: string;
  value: string;
  series: number[];
  color: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </span>
        <span className="font-display text-base font-semibold tabular-nums text-ink-strong">
          {value}
        </span>
      </div>
      <div className="mt-2">
        {series.length > 0 ? (
          <Sparkline values={series} color={color} width={260} height={36} />
        ) : (
          <div className="h-9 rounded bg-surface/40" />
        )}
      </div>
    </div>
  );
}
