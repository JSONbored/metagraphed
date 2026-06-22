import { useMemo } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Activity, Layers, Radio, ShieldCheck, Wifi, Clock } from "lucide-react";
import {
  subnetHealthQuery,
  subnetHealthTrendsQuery,
  subnetHealthPercentilesQuery,
  subnetUptimeQuery,
  subnetProfileQuery,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { SurfaceLatencyPercentiles, Uptime } from "@/lib/metagraphed/types";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { useTimeRange, RANGE_LABEL, type TimeRange } from "./time-range-context";

/**
 * The /health/percentiles artifact is a per-surface array, not a single object.
 * Aggregate the real per-surface p50/p95/p99 into one subnet-level figure by
 * averaging across surfaces that reported each percentile (no synthesis — empty
 * stays undefined).
 */
function aggregatePercentiles(rows: SurfaceLatencyPercentiles[] | undefined): {
  p50?: number;
  p95?: number;
  p99?: number;
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
  return { p50: avg((l) => l.p50), p95: avg((l) => l.p95), p99: avg((l) => l.p99) };
}

/**
 * Dense subnet-profile KPI strip. Reads uptime / percentiles / surface counts
 * from a handful of subnet-scoped endpoints and renders them as a single
 * tabular row with mini-trends and active-range emphasis.
 */
export function SubnetKpiStrip({ netuid, className }: { netuid: number; className?: string }) {
  const { range } = useTimeRange();
  const { data: profileRes } = useSuspenseQuery(subnetProfileQuery(netuid));
  const { data: healthRes } = useSuspenseQuery(subnetHealthQuery(netuid));
  const { data: trendsRes } = useQuery(subnetHealthTrendsQuery(netuid));
  const { data: pctRes } = useQuery(subnetHealthPercentilesQuery(netuid));
  const { data: uptimeRes } = useQuery(subnetUptimeQuery(netuid));

  const profile = profileRes.data;
  const h = healthRes.data;
  const trends = trendsRes?.data;
  const pct = aggregatePercentiles(pctRes?.data);
  const up = uptimeRes?.data;

  const trendWin: "7d" | "30d" = range === "30d" ? "30d" : "7d";
  const points = trends?.windows?.[trendWin]?.points ?? [];

  const uptimeSeries = useMemo(
    () =>
      points
        .map((p) =>
          typeof p.uptime === "number" ? (p.uptime <= 1 ? p.uptime * 100 : p.uptime) : null,
        )
        .filter((v): v is number => v != null),
    [points],
  );
  const p50Series = useMemo(
    () =>
      points
        .map((p) => (typeof p.latency_p50 === "number" ? p.latency_p50 : null))
        .filter((v): v is number => v != null),
    [points],
  );
  const p95Series = useMemo(
    () =>
      points
        .map((p) => (typeof p.latency_p95 === "number" ? p.latency_p95 : null))
        .filter((v): v is number => v != null),
    [points],
  );

  const uptimeRangeValue = pickUptimeForRange(range, h?.uptime_24h, up);
  const uptimeDelta = computeDelta(uptimeSeries);

  const tiles: Array<{
    label: string;
    value: string;
    hint?: string;
    delta?: number | null;
    icon: typeof Activity;
    series?: number[];
    seriesColor?: string;
    tone?: "ok" | "warn" | "down" | "accent" | "default";
  }> = [
    {
      label: `Uptime · ${RANGE_LABEL[range]}`,
      value: uptimeRangeValue != null ? `${uptimeRangeValue.toFixed(2)}%` : "—",
      hint: trendWin === "30d" ? "trend 30d" : "trend 7d",
      delta: uptimeDelta,
      icon: Activity,
      series: uptimeSeries,
      seriesColor: "var(--health-ok)",
      tone:
        uptimeRangeValue != null && uptimeRangeValue > 99
          ? "ok"
          : uptimeRangeValue != null && uptimeRangeValue < 95
            ? "warn"
            : "default",
    },
    {
      label: "Latency p50",
      value:
        pct.p50 != null
          ? `${Math.round(pct.p50)}ms`
          : p50Series.length
            ? `${Math.round(p50Series.at(-1)!)}ms`
            : "—",
      hint: "rolling",
      icon: Wifi,
      series: p50Series,
      seriesColor: "var(--accent)",
    },
    {
      label: "Latency p99",
      value:
        pct.p99 != null
          ? `${Math.round(pct.p99)}ms`
          : p95Series.length
            ? `${Math.round(p95Series.at(-1)!)}ms`
            : "—",
      hint: pct.p99 == null && p95Series.length ? "p95 fallback" : "rolling",
      icon: Clock,
      series: p95Series,
      seriesColor: "var(--health-warn)",
      tone: (pct.p99 ?? p95Series.at(-1) ?? 0) > 1000 ? "warn" : "default",
    },
    {
      label: "Surfaces",
      value: profile?.surface_count != null ? String(profile.surface_count) : "—",
      hint: profile?.endpoint_count != null ? `${profile.endpoint_count} endpoints` : undefined,
      icon: Layers,
    },
    {
      label: "Candidates",
      value: profile?.candidate_count != null ? String(profile.candidate_count) : "—",
      hint: "unverified leads",
      icon: Radio,
    },
    {
      label: "Completeness",
      value: profile?.completeness != null ? `${Math.round(profile.completeness * 100)}%` : "—",
      hint: profile?.missing_kinds?.length ? `${profile.missing_kinds.length} missing` : "no gaps",
      icon: ShieldCheck,
      tone: profile?.completeness != null && profile.completeness > 0.8 ? "ok" : "default",
    },
  ];

  return (
    <div
      className={classNames("rounded-xl border border-border bg-card overflow-hidden", className)}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-paper/40">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Subnet KPIs · range {RANGE_LABEL[range]}
        </div>
        <InfoTooltip label="Snapshot drawn from /api/v1/subnets/{netuid}/health, /uptime, /health/trends and /health/percentiles. Range affects the trend window and the headline uptime tile." />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-y sm:divide-y-0 divide-border">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <div key={t.label} className="px-4 py-3 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon
                    aria-hidden
                    className={classNames(
                      "size-3 shrink-0",
                      t.tone === "ok" && "text-health-ok",
                      t.tone === "warn" && "text-health-warn",
                      t.tone === "down" && "text-health-down",
                      t.tone === "accent" && "text-accent",
                      (!t.tone || t.tone === "default") && "text-ink-muted",
                    )}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted truncate">
                    {t.label}
                  </span>
                </div>
                {t.delta != null && Number.isFinite(t.delta) ? (
                  <span
                    className={classNames(
                      "font-mono text-[10px] tabular-nums",
                      t.delta > 0
                        ? "text-health-ok"
                        : t.delta < 0
                          ? "text-health-down"
                          : "text-ink-muted",
                    )}
                    title="Δ vs first sample in trend window"
                  >
                    {t.delta > 0 ? "+" : ""}
                    {t.delta.toFixed(2)}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span
                  className={classNames(
                    "font-display text-xl font-semibold tabular-nums leading-none",
                    t.tone === "ok" && "text-health-ok",
                    t.tone === "warn" && "text-health-warn",
                    t.tone === "down" && "text-health-down",
                    t.tone === "accent" && "text-accent",
                    (!t.tone || t.tone === "default") && "text-ink-strong",
                  )}
                >
                  {t.value}
                </span>
                {t.hint ? (
                  <span className="font-mono text-[10px] text-ink-muted truncate">{t.hint}</span>
                ) : null}
              </div>
              {t.series && t.series.length > 1 ? (
                <div className="mt-2">
                  <Sparkline
                    values={t.series}
                    width={140}
                    height={18}
                    color={t.seriesColor}
                    fill
                    interactive={false}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pickUptimeForRange(
  range: TimeRange,
  uptime24h: number | undefined,
  uptime: Uptime | undefined,
): number | null {
  const pct = (v: number | undefined | null) =>
    typeof v === "number" ? (v <= 1 ? v * 100 : v) : null;
  // The /uptime artifact exposes one long-range window (default 90d) via an
  // overall reliability grade — there is no per-range 30d/90d/180d split.
  const longRange = pct(uptime?.reliability?.uptime_ratio);
  if (range === "1h" || range === "24h") return pct(uptime24h);
  if (range === "7d") return pct(uptime24h) ?? longRange;
  return longRange ?? pct(uptime24h);
}

function computeDelta(series: number[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1]! - series[0]!;
}
