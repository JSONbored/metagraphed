import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { subnetHealthTrendsQuery, subnetHealthPercentilesQuery } from "@/lib/metagraphed/queries";
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
  const points = trendsRes?.data?.windows?.[win]?.points ?? [];
  const pct = aggregatePercentiles(pctRes?.data);

  const uptimeSeries = points
    .map((p) => (typeof p.uptime === "number" ? p.uptime * (p.uptime <= 1 ? 100 : 1) : null))
    .filter((v): v is number => v != null);
  const p50Series = points
    .map((p) => (typeof p.latency_p50 === "number" ? p.latency_p50 : null))
    .filter((v): v is number => v != null);
  const p95Series = points
    .map((p) => (typeof p.latency_p95 === "number" ? p.latency_p95 : null))
    .filter((v): v is number => v != null);

  return (
    <SectionAnchor
      id="health-trends"
      title="Health time-series"
      subtitle="Uptime and latency percentiles over time."
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
      ) : points.length === 0 ? (
        <EmptyState
          title="No trend data"
          description="Health time-series will appear here once the registry has enough samples."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <TrendCard
            label="Uptime"
            value={
              uptimeSeries.length ? `${uptimeSeries[uptimeSeries.length - 1]!.toFixed(1)}%` : "—"
            }
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
