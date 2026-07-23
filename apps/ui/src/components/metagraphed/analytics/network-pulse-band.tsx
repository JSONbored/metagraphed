import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  healthQuery,
  endpointIncidentsQuery,
  bulkHealthTrendsQuery,
  bulkTrendDays,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import {
  useTimeRange,
  RANGE_HOURS,
  RANGE_BUCKETS,
  RANGE_LABEL,
  type TimeRange,
} from "./time-range-context";

// The bulk /api/v1/health/trends artifact is per-DAY, so map a TimeRange onto the
// matching trend window. 1h/24h carry less than a day of real per-day points, so
// they fall back to the live current snapshot (still real, just not a trend).
const RANGE_TO_TREND_WINDOW: Record<TimeRange, string | null> = {
  "1h": null,
  "24h": null,
  "7d": "7d",
  "30d": "30d",
};

/**
 * Stacked band showing per-bucket ok/down health across the active TimeRange.
 * For 7d/30d the buckets reflect the REAL sample-weighted daily uptime from the
 * bulk /api/v1/health/trends artifact (down = 1 − uptime); for sub-day ranges
 * (1h/24h), which carry less than a day of per-day points, the band falls back
 * to the live current ok/warn/down snapshot. REAL incident-start markers are
 * placed per bucket over the range in both modes.
 */
export function NetworkPulseBand({ className }: { className?: string }) {
  const { range } = useTimeRange();
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());
  const { data: tRes } = useSuspenseQuery(bulkHealthTrendsQuery());
  const h = hRes.data;
  const incidents = (iRes.data ?? []) as EndpointIncident[];

  const total = (h?.total ?? 0) || 1;
  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;

  const bucketCount = RANGE_BUCKETS[range];

  // For 7d/30d, build per-bucket shares from the REAL daily uptime series (the
  // most-recent `bucketCount` days). For 1h/24h there's no sub-day series, so we
  // honestly fall back to repeating the live current snapshot across buckets.
  const trendDays = useMemo(() => {
    const windowKey = RANGE_TO_TREND_WINDOW[range];
    if (!windowKey) return [];
    return bulkTrendDays(tRes.data.windows[windowKey]);
  }, [tRes.data, range]);

  const usingTrend = trendDays.length > 1;

  const buckets = useMemo(() => {
    if (usingTrend) {
      // Take the trailing `bucketCount` days so the band ends "now"; each day's
      // ok-share is its mean uptime_ratio, the rest is treated as down.
      const days = trendDays.slice(-bucketCount);
      return days.map((d) => {
        const okShare = Math.min(1, Math.max(0, d.uptime_ratio));
        return { ok: okShare, warn: 0, down: 1 - okShare };
      });
    }
    const share = { ok: ok / total, warn: warn / total, down: down / total };
    return Array.from({ length: bucketCount }, () => share);
  }, [usingTrend, trendDays, ok, warn, down, total, bucketCount]);

  // The number of columns actually drawn — `bucketCount` in snapshot mode, or the
  // available trailing-day count (≤ bucketCount) in trend mode.
  const renderedCount = buckets.length || 1;

  const now = Date.now();
  const totalMs = RANGE_HOURS[range] * 3_600_000;
  const incidentBucket = useMemo(() => {
    const map = new Map<number, number>();
    for (const inc of incidents) {
      if (!inc.started_at) continue;
      const t = Date.parse(inc.started_at);
      if (!Number.isFinite(t)) continue;
      const ageMs = now - t;
      if (ageMs < 0 || ageMs > totalMs) continue;
      const bucket = renderedCount - 1 - Math.floor((ageMs / totalMs) * renderedCount);
      const idx = Math.max(0, Math.min(renderedCount - 1, bucket));
      map.set(idx, (map.get(idx) ?? 0) + 1);
    }
    return map;
  }, [incidents, now, totalMs, renderedCount]);

  const W = 480;
  const H = 88;
  const colW = W / renderedCount;

  return (
    <Panel as="div" flush className={className}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Network pulse · {RANGE_LABEL[range]}
            </div>
            <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
              ok / warn / down
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <Legend swatch="bg-health-ok" label="ok" />
            <Legend swatch="bg-health-warn" label="warn" />
            <Legend swatch="bg-health-down" label="down" />
            <InfoTooltip label="For 7d/30d each bar is the real sample-weighted daily uptime from /api/v1/health/trends (down = 1 − uptime); 1h/24h fall back to the live current ok/warn/down snapshot. Markers indicate incident starts per bucket." />
          </div>
        </div>
        <svg
          width="100%"
          height={H + 16}
          viewBox={`0 0 ${W} ${H + 16}`}
          preserveAspectRatio="none"
          className="block w-full"
          role="img"
          aria-label={`Network status distribution over ${RANGE_LABEL[range]}`}
        >
          {buckets.map((b, i) => {
            const x = i * colW;
            const okH = b.ok * H;
            const warnH = b.warn * H;
            const downH = b.down * H;
            const day = usingTrend ? trendDays.slice(-renderedCount)[i] : undefined;
            const title = day
              ? `${day.date} · ${(day.uptime_ratio * 100).toFixed(1)}% uptime · ${day.subnet_count} subnets`
              : `${(b.ok * 100).toFixed(1)}% ok · ${(b.down * 100).toFixed(1)}% down (current snapshot)`;
            return (
              <g key={i}>
                <title>{title}</title>
                <rect
                  x={x + 0.5}
                  y={H - okH}
                  width={colW - 1}
                  height={okH}
                  fill="var(--health-ok)"
                  opacity={0.85}
                />
                <rect
                  x={x + 0.5}
                  y={H - okH - warnH}
                  width={colW - 1}
                  height={warnH}
                  fill="var(--health-warn)"
                  opacity={0.85}
                />
                <rect
                  x={x + 0.5}
                  y={0}
                  width={colW - 1}
                  height={downH}
                  fill="var(--health-down)"
                  opacity={0.85}
                />
              </g>
            );
          })}
          {Array.from(incidentBucket.entries()).map(([bucket, count]) => {
            const x = bucket * colW + colW / 2;
            const hoursAgo = Math.round(
              (renderedCount - 1 - bucket) * (RANGE_HOURS[range] / renderedCount),
            );
            return (
              <g key={bucket}>
                <line
                  x1={x}
                  x2={x}
                  y1={H}
                  y2={H + 8}
                  stroke="var(--health-down)"
                  strokeWidth={1.5}
                />
                <circle cx={x} cy={H + 11} r={3} fill="var(--health-down)" opacity={0.9}>
                  <title>{`${count} incident${count > 1 ? "s" : ""} ~${hoursAgo}h ago`}</title>
                </circle>
              </g>
            );
          })}
        </svg>
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-ink-muted">
          <span>-{RANGE_LABEL[range]}</span>
          <span>
            {usingTrend ? "daily uptime · incident markers" : "current snapshot · incident markers"}
          </span>
          <span>now</span>
        </div>
      </div>
    </Panel>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted">
      <span className={classNames("inline-block size-2 rounded-sm", swatch)} aria-hidden />
      {label}
    </span>
  );
}
