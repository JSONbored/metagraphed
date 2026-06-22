import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetHealthTrendsQuery,
  subnetHealthIncidentsQuery,
  flattenSurfaceIncidents,
} from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { formatFreshness } from "@/lib/metagraphed/freshness";
import { Skeleton, EmptyState } from "@/components/metagraphed/states";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTimeRange, RANGE_LABEL, RANGE_HOURS } from "./time-range-context";
import type { FlatSurfaceIncident } from "@/lib/metagraphed/types";

type IncidentState = "ok" | "warn" | "down" | "info" | "unknown";
const INCIDENT_FILTERS: ReadonlyArray<{ id: IncidentState; label: string; tint: string }> = [
  { id: "down", label: "down", tint: "var(--health-down)" },
  { id: "warn", label: "warn", tint: "var(--health-warn)" },
  { id: "info", label: "info", tint: "var(--ink-muted)" },
];

function classifyIncident(i: FlatSurfaceIncident): IncidentState {
  const s = (i.severity ?? "").toLowerCase();
  if (s === "down" || s === "high") return "down";
  if (s === "warn" || s === "medium") return "warn";
  if (s === "info" || s === "low") return "info";
  return "info";
}

function durationLabel(start?: string, end?: string): string {
  if (!start) return "—";
  const s = Date.parse(start);
  if (!Number.isFinite(s)) return "—";
  const e = end ? Date.parse(end) : Date.now();
  const ms = Math.max(0, (Number.isFinite(e) ? e : Date.now()) - s);
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * Subnet uptime / latency timeline. Reads /health/trends and joins
 * /health/incidents as severity markers below the curve.
 *
 * Uses the active TimeRange: 1h/24h fall back to the 7d window with the
 * tail trimmed; 7d and 30d match upstream windows directly.
 */
export function UptimeTimeline({ netuid, className }: { netuid: number; className?: string }) {
  const { range } = useTimeRange();
  const winKey: "7d" | "30d" = range === "30d" ? "30d" : "7d";

  const { data: tRes, isLoading } = useQuery(subnetHealthTrendsQuery(netuid));
  const { data: iRes } = useQuery(subnetHealthIncidentsQuery(netuid));

  const allPoints = tRes?.data?.windows?.[winKey]?.points ?? [];
  const incidents = flattenSurfaceIncidents(iRes?.data ?? []);
  const trendsAt = tRes?.meta?.generated_at;
  const freshLine = formatFreshness(trendsAt, RANGE_LABEL[range]);

  // Per-severity filter — persists in component state and gates both the
  // SVG markers and the count badges in the legend.
  const [activeFilters, setActiveFilters] = useState<Set<IncidentState>>(
    () => new Set<IncidentState>(["down", "warn", "info"]),
  );
  const toggleFilter = (id: IncidentState) =>
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Never let the user filter everything out — restore on empty.
      if (next.size === 0) return new Set<IncidentState>(["down", "warn", "info"]);
      return next;
    });

  const visibleHours = RANGE_HOURS[range];
  const points = useMemo(() => {
    if (range === "1h" || range === "24h") {
      const cutoff = Date.now() - visibleHours * 3_600_000;
      return allPoints.filter((p) => {
        const t = Date.parse(p.t ?? "");
        return Number.isFinite(t) && t >= cutoff;
      });
    }
    return allPoints;
  }, [allPoints, range, visibleHours]);

  const W = 720;
  const H = 160;
  const PAD_L = 36;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <EmptyState
          title="No timeline data"
          description="Uptime / latency trends will appear here once the registry has enough samples for this range."
        />
      </div>
    );
  }

  const tMin = Date.parse(points[0]!.t ?? "") || Date.now() - visibleHours * 3_600_000;
  const tMax = Date.parse(points[points.length - 1]!.t ?? "") || Date.now();
  const tSpan = tMax - tMin || 1;

  // Uptime axis: always 0-100 so the area reads as a coverage chart.
  const uptimePath = (() => {
    const pts: string[] = [];
    points.forEach((p, i) => {
      const u = typeof p.uptime === "number" ? (p.uptime <= 1 ? p.uptime * 100 : p.uptime) : null;
      if (u == null) return;
      const t = Date.parse(p.t ?? "") || tMin;
      const x = PAD_L + ((t - tMin) / tSpan) * innerW;
      const y = PAD_T + innerH - (u / 100) * innerH;
      pts.push(`${pts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      void i;
    });
    return pts.join(" ");
  })();

  // Latency p50 as a faint secondary line (normalized into the same area).
  const latencyValues = points
    .map((p) => (typeof p.latency_p50 === "number" ? p.latency_p50 : null))
    .filter((v): v is number => v != null);
  const latencyMax = Math.max(1, ...latencyValues);
  const latencyPath = (() => {
    const pts: string[] = [];
    points.forEach((p) => {
      const v = typeof p.latency_p50 === "number" ? p.latency_p50 : null;
      if (v == null) return;
      const t = Date.parse(p.t ?? "") || tMin;
      const x = PAD_L + ((t - tMin) / tSpan) * innerW;
      const y = PAD_T + innerH - (v / latencyMax) * innerH;
      pts.push(`${pts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(" ");
  })();

  const areaPath = uptimePath
    ? `${uptimePath} L${(PAD_L + innerW).toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${PAD_L},${(PAD_T + innerH).toFixed(1)} Z`
    : "";

  // Plain derivations (no useMemo) — they sit after the early returns above, so
  // hooks here would violate rules-of-hooks. The cost is trivial and recomputing
  // each render keeps behavior identical.
  const inWindowIncidents = incidents.filter((i) => {
    const start = Date.parse(i.started_at ?? "");
    return Number.isFinite(start) && start >= tMin - 3_600_000;
  });
  const incidentCounts = (() => {
    const counts: Record<IncidentState, number> = { ok: 0, warn: 0, down: 0, info: 0, unknown: 0 };
    for (const i of inWindowIncidents) counts[classifyIncident(i)]++;
    return counts;
  })();
  const visibleIncidents = inWindowIncidents.filter((i) => activeFilters.has(classifyIncident(i)));

  return (
    <div
      className={classNames("rounded-xl border border-border bg-card overflow-hidden", className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-border bg-paper/40">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Uptime timeline · {RANGE_LABEL[range]}
        </div>
        {freshLine ? (
          <span className="font-mono text-[9.5px] text-ink-muted/70">· {freshLine}</span>
        ) : null}
        <div
          className="ml-auto flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter incident markers by severity"
        >
          {INCIDENT_FILTERS.map((f) => {
            const active = activeFilters.has(f.id);
            const count = incidentCounts[f.id];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => toggleFilter(f.id)}
                aria-pressed={active}
                aria-label={`${f.label} incidents (${count}). Click to ${active ? "hide" : "show"}.`}
                className={classNames(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  active
                    ? "border-border bg-card text-ink-strong"
                    : "border-border/60 bg-paper/40 text-ink-muted/60 opacity-60",
                )}
              >
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: f.tint }}
                />
                {f.label}
                <span className="tabular-nums text-ink-muted">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] text-ink-muted basis-full md:basis-auto">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm bg-health-ok" aria-hidden /> uptime
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm bg-accent/60" aria-hidden /> p50 latency
          </span>
          <InfoTooltip label="Uptime % over the selected range (0–100 axis). Latency p50 is normalized into the same plot for trend comparison; absolute p50 reads from the KPI strip. Incident markers along the bottom axis are keyboard-focusable — Tab to one to see severity, start/end, and message." />
        </div>
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        role="img"
        aria-label={`Subnet ${netuid} uptime over ${RANGE_LABEL[range]}`}
      >
        {/* Y-axis guides */}
        {[0, 50, 95, 100].map((v) => {
          const y = PAD_T + innerH - (v / 100) * innerH;
          return (
            <g key={v}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeOpacity={v === 95 ? 0.5 : 0.25}
                strokeDasharray={v === 95 ? "2 2" : undefined}
              />
              <text
                x={PAD_L - 4}
                y={y + 3}
                textAnchor="end"
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill="var(--ink-muted)"
              >
                {v}%
              </text>
            </g>
          );
        })}

        {/* Uptime area + line */}
        {areaPath ? <path d={areaPath} fill="var(--health-ok)" opacity={0.12} /> : null}
        {uptimePath ? (
          <path
            d={uptimePath}
            fill="none"
            stroke="var(--health-ok)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {/* Latency p50 line (normalized) */}
        {latencyPath ? (
          <path
            d={latencyPath}
            fill="none"
            stroke="var(--accent)"
            strokeOpacity={0.55}
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        ) : null}

        {/* Incident markers along the bottom axis. Each marker is a
            focusable <g role="button"> with a Radix tooltip so keyboard
            users can Tab through and read severity + duration + message. */}
        {visibleIncidents.map((i, idx) => {
          const t = Date.parse(i.started_at ?? "") || tMin;
          const x = PAD_L + Math.max(0, Math.min(innerW, ((t - tMin) / tSpan) * innerW));
          const sev = classifyIncident(i);
          const tint =
            sev === "down"
              ? "var(--health-down)"
              : sev === "warn"
                ? "var(--health-warn)"
                : "var(--ink-muted)";
          const startLabel = i.started_at ? new Date(i.started_at).toLocaleString() : "—";
          const endLabel = i.ended_at ? new Date(i.ended_at).toLocaleString() : "ongoing";
          const dur = durationLabel(i.started_at ?? undefined, i.ended_at ?? undefined);
          const aria = `${sev} incident, started ${startLabel}, ${i.ended_at ? `ended ${endLabel}` : "ongoing"}, duration ${dur}${i.surface_id ? `, ${i.surface_id}` : ""}`;
          return (
            <Tooltip key={`${i.surface_id}-${i.started_at ?? idx}`} delayDuration={150}>
              <TooltipTrigger asChild>
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={aria}
                  className="focus:outline-none [&_circle]:focus-visible:stroke-[hsl(var(--ring))] [&_circle]:focus-visible:stroke-2 cursor-pointer"
                >
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD_T}
                    y2={PAD_T + innerH}
                    stroke={tint}
                    strokeOpacity={0.18}
                  />
                  {/* invisible larger hit target for hover/focus */}
                  <circle cx={x} cy={PAD_T + innerH + 10} r={8} fill="transparent" />
                  <circle cx={x} cy={PAD_T + innerH + 10} r={3.5} fill={tint} />
                </g>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
                <div className="font-mono text-[10px] uppercase tracking-widest text-primary-foreground/80">
                  {sev} · {dur}
                </div>
                <div className="mt-1 break-all">{i.surface_id}</div>
                <div className="mt-1 font-mono text-[10px] text-primary-foreground/70">
                  started {startLabel}
                  <br />
                  {i.ended_at ? `ended ${endLabel}` : "still open"}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}

        {/* X-axis label */}
        <text
          x={PAD_L}
          y={H - 6}
          fontFamily="ui-monospace, monospace"
          fontSize={9}
          fill="var(--ink-muted)"
        >
          {formatTime(tMin)}
        </text>
        <text
          x={W - PAD_R}
          y={H - 6}
          textAnchor="end"
          fontFamily="ui-monospace, monospace"
          fontSize={9}
          fill="var(--ink-muted)"
        >
          {formatTime(tMax)}
        </text>
      </svg>
    </div>
  );
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
  } catch {
    return "—";
  }
}
