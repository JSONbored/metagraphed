import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { healthQuery, endpointIncidentsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { EndpointIncident } from "@/lib/metagraphed/types";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { useTimeRange, RANGE_HOURS, RANGE_BUCKETS, RANGE_LABEL } from "./time-range-context";

/**
 * Stacked band showing the current ok/warn/down distribution across registered
 * surfaces, with REAL incident-start markers placed per bucket over the active
 * TimeRange. Per-hour health history isn't exposed, so the band is the live
 * current distribution (flat — no synthetic per-bucket variation); the time
 * dimension is carried by the real incident markers, not a fabricated trend.
 */
export function NetworkPulseBand({ className }: { className?: string }) {
  const { range } = useTimeRange();
  const { data: hRes } = useSuspenseQuery(healthQuery());
  const { data: iRes } = useSuspenseQuery(endpointIncidentsQuery());
  const h = hRes.data;
  const incidents = (iRes.data ?? []) as EndpointIncident[];

  const total = (h?.total ?? 0) || 1;
  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;

  const bucketCount = RANGE_BUCKETS[range];
  const hoursPerBucket = RANGE_HOURS[range] / bucketCount;

  // No per-hour health history is exposed, so every bucket shows the REAL current
  // ok/warn/down distribution (no synthetic variation) — the time dimension comes
  // from the real incident markers below, not a fabricated trend.
  const buckets = useMemo(() => {
    const share = { ok: ok / total, warn: warn / total, down: down / total };
    return Array.from({ length: bucketCount }, () => share);
  }, [ok, warn, down, total, bucketCount]);

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
      const bucket = bucketCount - 1 - Math.floor((ageMs / totalMs) * bucketCount);
      const idx = Math.max(0, Math.min(bucketCount - 1, bucket));
      map.set(idx, (map.get(idx) ?? 0) + 1);
    }
    return map;
  }, [incidents, now, totalMs, bucketCount]);

  const W = 480;
  const H = 88;
  const colW = W / bucketCount;

  return (
    <div className={classNames("rounded-lg border border-border bg-card p-5", className)}>
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
          <InfoTooltip label="Current ok/warn/down distribution across registered surfaces. Markers indicate incident starts per bucket over the selected range." />
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
          return (
            <g key={i}>
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
          return (
            <g key={bucket}>
              <line x1={x} x2={x} y1={H} y2={H + 8} stroke="var(--health-down)" strokeWidth={1.5} />
              <circle cx={x} cy={H + 11} r={3} fill="var(--health-down)" opacity={0.9}>
                <title>{`${count} incident${count > 1 ? "s" : ""} ~${Math.round((bucketCount - 1 - bucket) * hoursPerBucket)}h ago`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-ink-muted">
        <span>-{RANGE_LABEL[range]}</span>
        <span>current distribution · incident markers</span>
        <span>now</span>
      </div>
    </div>
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
