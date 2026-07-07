import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, ArrowRight, Info, X } from "lucide-react";
import {
  subnetHealthQuery,
  subnetHealthIncidentsQuery,
  subnetHealthPercentilesQuery,
  subnetHealthTrendsQuery,
  subnetEndpointsQuery,
  subnetAxonRemovalsQuery,
  flattenSurfaceIncidents,
} from "@/lib/metagraphed/queries";
import type {
  Endpoint,
  FlatSurfaceIncident,
  SurfaceLatencyPercentiles,
} from "@/lib/metagraphed/types";
import { UptimeTimeline } from "@/components/metagraphed/analytics/uptime-timeline";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { PanelShell } from "@/components/metagraphed/panel-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { formatFreshness } from "@/lib/metagraphed/freshness";
import { useSubnetFilter, type Severity } from "@/components/metagraphed/subnet-filter-context";

/**
 * Unified operational panel — collapses the old KPI bar, uptime timeline,
 * live-health card, latency trends, and incidents into one zone. Reads as
 * "is this subnet healthy right now, and what's the trend?"
 */
export function OperationalPanel({ netuid }: { netuid: number }) {
  const queryClient = useQueryClient();
  const healthOpts = subnetHealthQuery(netuid);
  const pctOpts = subnetHealthPercentilesQuery(netuid);
  const incOpts = subnetHealthIncidentsQuery(netuid);
  const healthQ = useQuery(healthOpts);
  const pctQ = useQuery(pctOpts);
  const incQ = useQuery(incOpts);
  const endpointsQ = useQuery(subnetEndpointsQuery(netuid));
  const endpoints = (endpointsQ.data?.data ?? []) as Endpoint[];
  const filter = useSubnetFilter();
  const healthRes = healthQ.data;
  const pctRes = pctQ.data;
  const incRes = incQ.data;
  const h = healthRes?.data;
  // /health/percentiles returns one row PER SURFACE; the KPI tiles want a single
  // subnet-level latency. Summarize across surfaces: median p50 (typical), worst
  // p99/p95 (tail). No fabrication — pure aggregation of real per-surface values.
  const pct = aggregatePercentiles(pctRes?.data ?? []);
  // /health/incidents returns per-surface SLA rows; flatten the nested downtime
  // windows into a single newest-first list for the "recent incidents" rail.
  const incidents = flattenSurfaceIncidents(incRes?.data ?? []).slice(0, 3);
  const refreshKeys = [
    healthOpts.queryKey,
    pctOpts.queryKey,
    incOpts.queryKey,
    subnetHealthTrendsQuery(netuid).queryKey,
  ];
  const retryOperational = () =>
    Promise.all(
      refreshKeys.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey, refetchType: "active" }),
      ),
    );

  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;
  const unknown = h?.unknown ?? 0;
  const total = ok + warn + down + unknown;
  const uptime = h?.uptime_24h != null ? h.uptime_24h * 100 : null;

  return (
    <PanelShell
      id="health-trends"
      title="Operational status"
      subtitle="Uptime, latency, and incidents across all tracked endpoints. Click a segment to filter the resource list."
      info="GET /api/v1/subnets/{netuid}/health · /health/trends · /health/incidents"
      right={<TimeRangeScrub />}
      tone="warn"
      meta={{
        generatedAt: healthRes?.meta?.generated_at ?? h?.generated_at,
        stale: healthRes?.meta?.stale,
      }}
      refreshQueryKeys={refreshKeys}
      isLoading={healthQ.isPending}
      skeletonHeight={288}
      isEmpty={!healthQ.isPending && !healthQ.error && total === 0 && endpoints.length === 0}
      emptyTitle="No operational samples yet"
      emptyDescription="This is an empty registry state: health probes exist in the API, but no endpoint samples are available for this subnet yet."
    >
      {healthQ.error ? (
        <ErrorState error={healthQ.error} onRetry={retryOperational} context="operational status" />
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {/* Status ribbon */}
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border border-b border-border">
            <Stat
              label="Uptime 24h"
              value={uptime != null ? `${uptime.toFixed(2)}%` : "—"}
              tone={
                uptime == null ? "default" : uptime > 99 ? "ok" : uptime < 95 ? "warn" : "default"
              }
              hint="Mean uptime across all tracked endpoints in the last 24 hours."
            />
            <Stat
              label="Latency p50"
              value={pct?.p50 != null ? `${Math.round(pct.p50)} ms` : "—"}
              hint="Median request latency from the most recent probe window."
            />
            <Stat
              label="Latency p99"
              value={
                pct?.p99 != null
                  ? `${Math.round(pct.p99)} ms`
                  : pct?.p95 != null
                    ? `${Math.round(pct.p95)} ms`
                    : "—"
              }
              tone={(pct?.p99 ?? pct?.p95 ?? 0) > 1000 ? "warn" : "default"}
              hint="99th percentile latency (falls back to p95 when p99 unavailable)."
            />
            <Stat
              label={`Tracked · ${formatNumber(total)}`}
              value={
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-border/40 mt-1.5">
                  {total > 0 ? (
                    <>
                      <SegBtn
                        pct={(ok / total) * 100}
                        sev="ok"
                        cls="bg-health-ok"
                        count={ok}
                        filter={filter}
                      />
                      <SegBtn
                        pct={(warn / total) * 100}
                        sev="warn"
                        cls="bg-health-warn"
                        count={warn}
                        filter={filter}
                      />
                      <SegBtn
                        pct={(down / total) * 100}
                        sev="down"
                        cls="bg-health-down"
                        count={down}
                        filter={filter}
                      />
                      <SegBtn
                        pct={(unknown / total) * 100}
                        sev="unknown"
                        cls="bg-health-unknown/60"
                        count={unknown}
                        filter={filter}
                      />
                    </>
                  ) : null}
                </div>
              }
              hint={`${ok} ok · ${warn} warn · ${down} down${unknown ? ` · ${unknown} unknown` : ""}. Click a segment to filter resources.`}
            />
          </div>

          {/* #3482: chain teardown activity — axon (serving-endpoint) removals over
            the window, from the already-shipped subnetAxonRemovalsQuery. A flex strip
            below the health ribbon so the lone tile sits flush left (no empty grid
            columns); #3481 (serving/prometheus) tiles wrap in alongside it. */}
          <div className="flex flex-wrap divide-x divide-border border-b border-border">
            <AxonRemovalsStat netuid={netuid} />
          </div>

          {!filter.isAll ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-paper/40">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Filtering resources
              </span>
              {(["ok", "warn", "down", "unknown"] as Severity[])
                .filter((s) => filter.isActive(s))
                .map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-strong"
                  >
                    {s}
                  </span>
                ))}
              <button
                type="button"
                onClick={filter.reset}
                className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
              >
                <X className="size-3" /> clear
              </button>
            </div>
          ) : null}

          {/* Per-endpoint status mosaic — always renders something tangible
            even when timeline samples are sparse. */}
          {endpoints.length > 0 ? (
            <div className="border-b border-border px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Endpoint mosaic · {endpoints.length}
                  <InfoTooltip label="One cell per tracked endpoint, colored by the last probe result: ok (2xx within latency budget), warn (slow / intermittent 5xx), down (consecutive failures), or unknown (no probe in window). Source: /api/v1/subnets/{netuid}/endpoints joined with /health. Stale snapshots still render — check the panel's `updated` stamp." />
                </span>
                <span className="font-mono text-[9.5px] text-ink-muted/80">
                  one cell = one tracked endpoint, colored by last probe
                </span>
              </div>
              <div
                className="flex flex-wrap gap-[3px]"
                role="img"
                aria-label="Per-endpoint health mosaic"
              >
                {endpoints.map((e) => (
                  <Tooltip key={e.id} delayDuration={120}>
                    <TooltipTrigger asChild>
                      <span
                        className={classNames(
                          "size-3 rounded-[2px] border border-border/40",
                          (e.health ?? "unknown") === "ok" && "bg-health-ok",
                          (e.health ?? "") === "warn" && "bg-health-warn",
                          (e.health ?? "") === "down" && "bg-health-down",
                          (!e.health || e.health === "unknown") && "bg-health-unknown/40",
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="font-mono text-[10px]">
                      <div className="text-ink-strong">{e.kind?.toUpperCase() ?? "—"}</div>
                      <div className="text-ink">{e.url?.replace(/^https?:\/\//, "") ?? "—"}</div>
                      <div className="text-ink-muted">
                        {e.health ?? "unknown"} ·{" "}
                        {e.latency_ms != null ? `${e.latency_ms}ms` : "no latency"}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}

          {/* Timeline */}
          <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="min-w-0 border-b lg:border-b-0 lg:border-r border-border">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-paper/40 px-4 py-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
                    Health trend
                  </div>
                  <div className="font-mono text-[9.5px] text-ink-muted/80">
                    uptime &amp; latency over the selected window, with incident markers
                    {healthRes?.meta?.generated_at
                      ? ` · ${formatFreshness(healthRes.meta.generated_at) ?? ""}`
                      : ""}
                  </div>
                </div>
                <TimeRangeScrub />
              </div>
              <UptimeTimeline netuid={netuid} className="border-0 rounded-none" />
            </div>
            <div className="min-w-0 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Recent incidents
                </span>
                <a
                  href="#incidents"
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById("incidents")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-accent"
                >
                  all <ArrowRight className="size-3" />
                </a>
              </div>
              {incQ.error ? (
                <ErrorState
                  error={incQ.error}
                  onRetry={retryOperational}
                  context="recent incidents"
                />
              ) : incidents.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-paper/40 px-3 py-6 text-center">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    Clean history
                  </div>
                  <div className="mt-1 text-[11px] text-ink-muted">
                    No incidents recorded for this subnet.
                  </div>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {incidents.map((inc, i) => {
                    const open = !inc.ended_at;
                    return (
                      <li
                        key={`${inc.surface_id}-${inc.started_at ?? i}`}
                        className="flex items-start gap-2 rounded-lg border border-border bg-surface/30 px-2.5 py-2"
                      >
                        <span className="shrink-0 mt-0.5">{sevIcon(inc.severity)}</span>
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate text-[12px] text-ink-strong"
                            title={inc.surface_id}
                          >
                            {shortSurfaceId(inc.surface_id, netuid)}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                            {inc.started_at ? (
                              <>
                                <TimeAgo at={inc.started_at} />
                                {durationOf(inc) ? ` · ${durationOf(inc)}` : ""}
                              </>
                            ) : null}
                          </div>
                        </div>
                        <span
                          className={classNames(
                            "shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider",
                            open
                              ? "border-health-down/40 bg-health-down/10 text-health-down"
                              : "border-border bg-paper text-ink-muted",
                          )}
                        >
                          {open ? "open" : "resolved"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

/**
 * #3482: teardown-activity KPI — axon (serving-endpoint) removals for this subnet
 * over the trailing window, from the already-shipped subnetAxonRemovalsQuery
 * (#3660). The endpoint returns a flat window aggregate (removals / distinct
 * removers), so it renders as a single `Stat` tile matching the health ribbon's
 * convention: "…" while pending, "—" on error, the count otherwise.
 */
function AxonRemovalsStat({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetAxonRemovalsQuery(netuid));
  const a = res?.data;
  const removals = a?.removals ?? 0;
  const removers = a?.distinct_removers ?? 0;
  const win = a?.window ?? "30d";
  const value = isError ? "—" : isPending && !a ? "…" : formatNumber(removals);
  return (
    <Stat
      label={`Teardowns · ${win}`}
      value={value}
      tone={removals > 0 ? "warn" : "default"}
      hint={`Axon (serving-endpoint) removals for SN${netuid} over the ${win} window — ${removers} distinct ${removers === 1 ? "remover" : "removers"}. Source: /api/v1/subnets/{netuid}/axon-removals.`}
    />
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone?: "ok" | "warn" | "default";
}) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="px-3 py-2.5 min-w-0 focus:outline-none focus-visible:bg-surface/40"
        >
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted truncate">
            {label}
          </div>
          <div
            className={classNames(
              "mt-1 font-display text-base font-semibold tabular-nums leading-tight truncate",
              tone === "ok" && "text-health-ok",
              tone === "warn" && "text-health-warn",
              (!tone || tone === "default") && "text-ink-strong",
            )}
          >
            {value}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-[11px] leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function SegBtn({
  pct,
  sev,
  cls,
  count,
  filter,
}: {
  pct: number;
  sev: Severity;
  cls: string;
  count: number;
  filter: ReturnType<typeof useSubnetFilter>;
}) {
  if (pct <= 0) return null;
  const active = filter.isActive(sev);
  const label = `${count} ${sev} — click to filter resources`;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => (e.shiftKey ? filter.toggle(sev) : filter.only(sev))}
          aria-pressed={!filter.isAll && active}
          aria-label={label}
          className={classNames(
            "h-full focus:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-opacity",
            cls,
            !filter.isAll && !active && "opacity-30",
          )}
          style={{ width: `${pct}%` }}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[10px]">
        {count} {sev} · click to filter (shift+click to add)
      </TooltipContent>
    </Tooltip>
  );
}

function sevIcon(sev?: string) {
  if (sev === "high") return <AlertOctagon className="size-3.5 text-health-down" />;
  if (sev === "medium") return <AlertTriangle className="size-3.5 text-health-warn" />;
  return <Info className="size-3.5 text-ink-muted" />;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function maxOf(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

/**
 * Collapse per-surface latency percentiles into a single subnet-level summary.
 * p50 → median across surfaces (typical), p95/p99 → worst across surfaces (tail).
 * Returns null fields when no surface reports that percentile (rendered as "—").
 */
function aggregatePercentiles(rows: SurfaceLatencyPercentiles[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  const pick = (key: "p50" | "p95" | "p99") =>
    rows
      .map((r) => r.latency_ms?.[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    p50: median(pick("p50")),
    p95: maxOf(pick("p95")),
    p99: maxOf(pick("p99")),
  };
}

/** Trim the "sn-<netuid>-" / "community-sn-<netuid>-" prefix from a surface id. */
function shortSurfaceId(id: string, netuid: number): string {
  return id.replace(new RegExp(`^(community-)?sn-${netuid}-`), "");
}

function durationOf(inc: FlatSurfaceIncident): string | null {
  const ms =
    inc.duration_ms ??
    (inc.started_at && inc.ended_at
      ? Date.parse(inc.ended_at) - Date.parse(inc.started_at)
      : undefined);
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
