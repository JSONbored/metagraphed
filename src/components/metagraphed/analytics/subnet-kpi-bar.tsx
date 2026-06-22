import { useMemo } from "react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Wifi, Clock, Layers, Radio, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  subnetHealthQuery,
  subnetHealthTrendsQuery,
  subnetHealthPercentilesQuery,
  subnetUptimeQuery,
  subnetProfileQuery,
  trendSurfaceSeries,
} from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
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

interface Segment {
  key: string;
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  icon: LucideIcon;
  series?: number[];
  seriesColor?: string;
  tone?: "ok" | "warn" | "down" | "accent" | "default";
  /** Anchor id to scroll into when this segment is clicked. */
  jumpTo?: string;
}

/**
 * Denser, scannable replacement for the old KPI tile row. Single horizontal
 * bar split into three lanes:
 *   1. Health composition (ok/warn/down/unknown) as a stacked segment bar
 *      with clickable counts that jump to incidents / endpoints.
 *   2. Six KPI segments with value + delta + tiny sparkline, click-to-jump
 *      to the relevant section anchor.
 *   3. Footer with range label + source info tooltip.
 */
export function SubnetKpiBar({ netuid, className }: { netuid: number; className?: string }) {
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
  // The trend window is an aggregate snapshot with a per-surface breakdown (no
  // time dimension), so these sparkline series are distributions ACROSS surfaces
  // (worst-uptime first), not trends over time.
  const window = trends?.windows?.[trendWin];
  const { uptimeSeries, p50Series, p95Series } = useMemo(() => {
    const s = trendSurfaceSeries(window);
    return { uptimeSeries: s.uptimePct, p50Series: s.p50, p95Series: s.p95 };
  }, [window]);

  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;
  const unknown = h?.unknown ?? 0;
  const total = ok + warn + down + unknown;

  const uptimeRange = pickUptimeForRange(range, h?.uptime_24h, up);
  // No time order across the per-surface distribution, so there is no honest
  // first→last delta to report.
  const uptimeDelta = null;

  const segments: Segment[] = [
    {
      key: "uptime",
      label: `Uptime · ${RANGE_LABEL[range]}`,
      value: uptimeRange != null ? `${uptimeRange.toFixed(2)}%` : "—",
      hint: uptimeSeries.length ? `${trendWin} · by surface` : trendWin,
      delta: uptimeDelta,
      icon: Activity,
      series: uptimeSeries,
      seriesColor: "var(--health-ok)",
      tone:
        uptimeRange != null && uptimeRange > 99
          ? "ok"
          : uptimeRange != null && uptimeRange < 95
            ? "warn"
            : "default",
      jumpTo: "health-trends",
    },
    {
      key: "p50",
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
      jumpTo: "endpoints-glance",
    },
    {
      key: "p99",
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
      jumpTo: "endpoints-glance",
    },
    {
      key: "surfaces",
      label: "Surfaces",
      value: profile?.surface_count != null ? String(profile.surface_count) : "—",
      hint: profile?.endpoint_count != null ? `${profile.endpoint_count} ep` : undefined,
      icon: Layers,
      jumpTo: "surfaces",
    },
    {
      key: "candidates",
      label: "Candidates",
      value: profile?.candidate_count != null ? String(profile.candidate_count) : "—",
      hint: "unverified",
      icon: Radio,
    },
    {
      key: "completeness",
      label: "Completeness",
      value: profile?.completeness != null ? `${Math.round(profile.completeness * 100)}%` : "—",
      hint: profile?.missing_kinds?.length ? `${profile.missing_kinds.length} missing` : "no gaps",
      icon: ShieldCheck,
      tone: profile?.completeness != null && profile.completeness > 0.8 ? "ok" : "default",
      jumpTo: "gaps",
    },
  ];

  const jump = (id?: string) => {
    if (!id || typeof document === "undefined") return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div
      className={classNames("rounded-xl border border-border bg-card overflow-hidden", className)}
    >
      {/* Lane 1 — health composition stacked bar */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Tracked endpoints · {formatNumber(total)}
          </span>
          <div className="flex items-center gap-3 font-mono text-[10px]">
            <HealthLegend label="ok" count={ok} color="bg-health-ok" />
            <HealthLegend label="warn" count={warn} color="bg-health-warn" />
            <HealthLegend label="down" count={down} color="bg-health-down" />
            {unknown > 0 ? (
              <HealthLegend label="unknown" count={unknown} color="bg-health-unknown" />
            ) : null}
          </div>
        </div>
        <div
          role="group"
          aria-label="Endpoint health composition"
          className="flex h-2 w-full overflow-hidden rounded-full bg-border/40"
        >
          {total === 0 ? null : (
            <>
              <Seg pct={(ok / total) * 100} cls="bg-health-ok" />
              <Seg pct={(warn / total) * 100} cls="bg-health-warn" />
              <Seg pct={(down / total) * 100} cls="bg-health-down" />
              <Seg pct={(unknown / total) * 100} cls="bg-health-unknown/60" />
            </>
          )}
        </div>
      </div>

      {/* Lane 2 — KPI segments */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border-t border-border divide-x divide-y sm:divide-y-0 divide-border">
        {segments.map((s) => {
          const Icon = s.icon;
          const Tag = s.jumpTo ? "button" : "div";
          return (
            <Tag
              key={s.key}
              type={s.jumpTo ? "button" : undefined}
              onClick={s.jumpTo ? () => jump(s.jumpTo) : undefined}
              className={classNames(
                "group px-3 py-2.5 min-w-0 text-left transition-colors",
                s.jumpTo && "hover:bg-surface/40 focus:bg-surface/40 focus:outline-none",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <Icon
                    aria-hidden
                    className={classNames(
                      "size-3 shrink-0 transition-transform group-hover:scale-110",
                      s.tone === "ok" && "text-health-ok",
                      s.tone === "warn" && "text-health-warn",
                      s.tone === "down" && "text-health-down",
                      s.tone === "accent" && "text-accent",
                      (!s.tone || s.tone === "default") && "text-ink-muted",
                    )}
                  />
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-muted truncate">
                    {s.label}
                  </span>
                </span>
                {s.delta != null && Number.isFinite(s.delta) ? (
                  <span
                    className={classNames(
                      "font-mono text-[9.5px] tabular-nums",
                      s.delta > 0
                        ? "text-health-ok"
                        : s.delta < 0
                          ? "text-health-down"
                          : "text-ink-muted",
                    )}
                  >
                    {s.delta > 0 ? "+" : ""}
                    {s.delta.toFixed(2)}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span
                  className={classNames(
                    "font-display text-[19px] font-semibold tabular-nums leading-none",
                    s.tone === "ok" && "text-health-ok",
                    s.tone === "warn" && "text-health-warn",
                    s.tone === "down" && "text-health-down",
                    s.tone === "accent" && "text-accent",
                    (!s.tone || s.tone === "default") && "text-ink-strong",
                  )}
                >
                  {s.value}
                </span>
                {s.hint ? (
                  <span className="font-mono text-[10px] text-ink-muted truncate">{s.hint}</span>
                ) : null}
              </div>
              {s.series && s.series.length > 1 ? (
                <div className="mt-1.5 -mx-1">
                  <Sparkline
                    values={s.series}
                    width={140}
                    height={16}
                    color={s.seriesColor}
                    fill
                    interactive={false}
                  />
                </div>
              ) : null}
            </Tag>
          );
        })}
      </div>

      {/* Lane 3 — footer */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-border bg-paper/40 font-mono text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-2">
          <Link to="/subnets" className="hover:text-ink-strong transition-colors">
            ← all subnets
          </Link>
          <span aria-hidden>·</span>
          <span>range {RANGE_LABEL[range]}</span>
        </span>
        <InfoTooltip label="Snapshot drawn from /api/v1/subnets/{netuid}/health, /uptime, /health/trends, /health/percentiles. Click any segment to jump to the related section." />
      </div>
    </div>
  );
}

function Seg({ pct, cls }: { pct: number; cls: string }) {
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return <span className={cls} style={{ width: `${pct}%` }} aria-hidden />;
}

function HealthLegend({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-ink-muted">
      <span className={classNames("size-1.5 rounded-full", color)} aria-hidden />
      <span className="uppercase tracking-widest text-[9.5px]">{label}</span>
      <span className="tabular-nums text-ink-strong">{count}</span>
    </span>
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
