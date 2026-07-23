import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  subnetHealthTrendsQuery,
  subnetHealthIncidentsQuery,
  flattenSurfaceIncidents,
  sortedHealthTrendSurfaces,
} from "@/lib/metagraphed/queries";
import { classNames, durationLabel, formatNumber, formatRelative } from "@/lib/metagraphed/format";
import { formatFreshness } from "@/lib/metagraphed/freshness";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { Tooltip, TooltipContent, TooltipTrigger, InfoTooltip, TimeAgo } from "@jsonbored/ui-kit";
import { useTimeRange, RANGE_LABEL } from "./time-range-context";
import type { FlatSurfaceIncident, HealthTrendSurface } from "@/lib/metagraphed/types";

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

/** Health tint for an uptime ratio (0–1). Mirrors the 95% guide on the bars. */
function uptimeTint(ratio: number | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "var(--ink-muted)";
  if (ratio >= 0.99) return "var(--health-ok)";
  if (ratio >= 0.95) return "var(--health-warn)";
  return "var(--health-down)";
}

function pct(ratio: number | undefined, digits = 2): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

function ms(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}ms`;
}

/** Trim a fully-qualified surface_id down to something readable in a tight row. */
function shortSurfaceId(id: string): string {
  return id.replace(/^community-sn-\d+-/, "").replace(/^allways-/, "");
}

/**
 * Subnet uptime / latency breakdown. Reads /health/trends and joins
 * /health/incidents as severity markers.
 *
 * IMPORTANT: the health-trends API returns each window as an *aggregate*
 * snapshot with a per-surface breakdown (`windows[range].surfaces[]`), NOT a
 * `points[]` time-series. So this renders one horizontal uptime bar per surface
 * for the selected window (largest downtime first), with p50/p95 latency, plus
 * an aggregate header. The active TimeRange selects the window: 7d and 30d map
 * to upstream windows directly; 1h/24h have no finer-grained source upstream and
 * fall back to the 7d window.
 */
export function UptimeTimeline({ netuid, className }: { netuid: number; className?: string }) {
  const { range } = useTimeRange();
  const winKey: "7d" | "30d" = range === "30d" ? "30d" : "7d";
  // 1h/24h have no sub-7d window upstream; surface that the bars are a 7d view.
  const usingFallbackWindow = range === "1h" || range === "24h";

  const {
    data: tRes,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(subnetHealthTrendsQuery(netuid));
  const { data: iRes } = useQuery(subnetHealthIncidentsQuery(netuid, winKey));

  const window = tRes?.data?.windows?.[winKey];
  const incidents = flattenSurfaceIncidents(iRes?.data ?? []);
  const trendsAt = tRes?.meta?.generated_at;
  const freshLine = formatFreshness(trendsAt, RANGE_LABEL[range]);

  // Per-severity filter — persists in component state and gates both the
  // incident markers and the count badges in the legend.
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

  // Surfaces, ordered worst-uptime-first so problem endpoints surface on top.
  const surfaces = useMemo<HealthTrendSurface[]>(() => {
    return sortedHealthTrendSurfaces(window);
  }, [window]);

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (isError) {
    return (
      <Panel as="div">
        <ErrorState error={error} onRetry={() => refetch()} context="uptime timeline" />
      </Panel>
    );
  }

  if (surfaces.length === 0) {
    return (
      <Panel as="div">
        <EmptyState
          title="No trend data"
          description="Per-surface uptime &amp; latency will appear here once the prober has collected enough samples for this subnet."
          lastChecked={trendsAt}
        />
      </Panel>
    );
  }

  // Incident severity tallies + the filtered set that renders as markers. These
  // sit after the early returns above so the visibleIncidents map can't run on a
  // half-populated component; the cost is trivial (re-derived each render).
  const incidentCounts = (() => {
    const counts: Record<IncidentState, number> = { ok: 0, warn: 0, down: 0, info: 0, unknown: 0 };
    for (const i of incidents) counts[classifyIncident(i)]++;
    return counts;
  })();
  const visibleIncidents = incidents.filter((i) => activeFilters.has(classifyIncident(i)));
  const hasIncidents = incidents.length > 0;

  return (
    <Panel as="div" flush className={classNames("overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-border bg-paper/40">
        <div className="mg-type-micro text-ink-muted">
          Uptime by surface · {RANGE_LABEL[range]}
          {usingFallbackWindow ? <span className="text-ink-muted/60"> (7d window)</span> : null}
        </div>
        {freshLine ? (
          <span className="font-mono text-[9.5px] text-ink-muted/70">· {freshLine}</span>
        ) : null}
        {/* Aggregate window stats. */}
        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: uptimeTint(window?.uptime_ratio) }}
              aria-hidden
            />
            <span className="tabular-nums text-ink-strong">{pct(window?.uptime_ratio)}</span> uptime
          </span>
          {typeof window?.samples === "number" ? (
            <span className="tabular-nums">{formatNumber(window.samples)} samples</span>
          ) : null}
          <span className="tabular-nums">{surfaces.length} surfaces</span>
          <InfoTooltip label="Per-surface uptime ratio over the selected window, worst first. The bar fills to the uptime %; the dashed mark is the 95% SLA line. p50/p95 are latency percentiles for that surface. Reconstructed downtime windows (if any) are listed below as incident markers." />
        </div>
      </div>

      {/* Per-surface uptime bars. */}
      <ul className="divide-y divide-border">
        {surfaces.map((s) => {
          const ratio = s.uptime_ratio;
          const fillPct =
            typeof ratio === "number" && Number.isFinite(ratio)
              ? Math.max(0, Math.min(100, ratio * 100))
              : 0;
          const tint = uptimeTint(ratio);
          return (
            <li key={s.surface_id} className="px-4 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="truncate font-mono text-[11px] text-ink-strong"
                  title={s.surface_id}
                >
                  {shortSurfaceId(s.surface_id)}
                </span>
                <span
                  className="shrink-0 font-mono text-[10px] tabular-nums"
                  style={{ color: tint }}
                >
                  {pct(ratio)}
                </span>
              </div>
              {/* Uptime bar with a 95% SLA guide. */}
              <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-paper">
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{ width: `${fillPct}%`, background: tint }}
                />
                <span
                  className="absolute inset-y-0 w-px bg-border"
                  style={{ left: "95%" }}
                  aria-hidden
                />
              </div>
              <div className="mt-1 flex items-center gap-3 font-mono text-[9.5px] text-ink-muted tabular-nums">
                {typeof s.samples === "number" ? (
                  <span>{formatNumber(s.samples)} samples</span>
                ) : null}
                <span>p50 {ms(s.latency_ms?.p50 ?? s.avg_latency_ms)}</span>
                <span>p95 {ms(s.latency_ms?.p95)}</span>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Incident markers — reconstructed downtime windows for this range.
          Previously this overlay was dead code because the component always hit
          the empty state (it read a `points[]` series the API never returns). */}
      {hasIncidents ? (
        <div className="border-t border-border bg-paper/30 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="mg-type-micro text-ink-muted">Downtime windows</span>
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
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 mg-type-micro transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {visibleIncidents.map((i, idx) => {
              const sev = classifyIncident(i);
              const tint =
                sev === "down"
                  ? "var(--health-down)"
                  : sev === "warn"
                    ? "var(--health-warn)"
                    : "var(--ink-muted)";
              const startLabel = formatRelative(i.started_at);
              const endLabel = i.ended_at ? formatRelative(i.ended_at) : "ongoing";
              const dur = durationLabel(i.started_at ?? undefined, i.ended_at ?? undefined);
              const aria = `${sev} incident, started ${startLabel}, ${i.ended_at ? `ended ${endLabel}` : "ongoing"}, duration ${dur}${i.surface_id ? `, ${i.surface_id}` : ""}`;
              return (
                <Tooltip key={`${i.surface_id}-${i.started_at ?? idx}`} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={aria}
                      className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[9.5px] text-ink-muted transition-colors hover:text-ink-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden
                        className="inline-block size-1.5 rounded-full"
                        style={{ background: tint }}
                      />
                      <span className="tabular-nums">{dur}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
                    <div className="mg-type-micro text-primary-foreground/80">
                      {sev} · {dur}
                    </div>
                    <div className="mt-1 break-all">{i.surface_id}</div>
                    <div className="mt-1 font-mono text-[10px] text-primary-foreground/70">
                      started <TimeAgo at={i.started_at} />
                      <br />
                      {i.ended_at ? (
                        <>
                          ended <TimeAgo at={i.ended_at} />
                        </>
                      ) : (
                        "still open"
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
