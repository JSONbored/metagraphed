import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useState } from "react";
import { RefreshCw, Pause, Play, ChevronDown, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { IncidentCard } from "@/components/metagraphed/incident-card";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import {
  healthQuery,
  freshnessQuery,
  sourceHealthQuery,
  endpointIncidentsQuery,
} from "@/lib/metagraphed/queries";
import { humaniseSeconds, isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { AnimatedNumber } from "@/components/metagraphed/animated-number";
import type { EndpointIncident, HealthState } from "@/lib/metagraphed/types";

const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 5 * 60_000 },
];

const INCIDENT_INITIAL_VISIBLE = 12;

export const Route = createFileRoute("/health")({
  head: () => ({
    meta: [
      { title: "Health — Metagraphed" },
      {
        name: "description",
        content:
          "Global health, freshness, source health, and recent incidents across the registry.",
      },
    ],
  }),
  component: HealthPage,
});

/** Returns true when the document is visible (or true in SSR). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function HealthPage() {
  const [enabled, setEnabled] = useState(true);
  const [intervalMs, setIntervalMs] = useState(30_000);
  const visible = usePageVisible();
  const effectiveInterval = enabled && visible ? intervalMs : false;

  return (
    <AppShell>
      <PageHero
        eyebrow="Operations"
        live
        title="Health & freshness"
        description="Probe-derived health. User submissions cannot set uptime, latency, or incident state."
        actions={
          <AutoRefreshControl
            enabled={enabled}
            visible={visible}
            intervalMs={intervalMs}
            onToggle={() => setEnabled((v) => !v)}
            onIntervalChange={setIntervalMs}
          />
        }
      />
      <div className="space-y-8">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <GlobalHealth interval={effectiveInterval} />
          </Suspense>
        </QueryErrorBoundary>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Source health
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <SourceHealth interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong mb-2">
            Incidents
          </h2>
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <Incidents interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter
        paths={["/api/v1/health", "/api/v1/freshness", "/api/v1/endpoint-incidents"]}
      />
    </AppShell>
  );
}

/**
 * Consolidated auto-refresh control. One pill-shaped control group:
 * interval select · pause/play with live countdown · sync indicator. The
 * "tab hidden" state is folded into the pause button's label so we don't
 * stack a third chip on top.
 */
function AutoRefreshControl({
  enabled,
  visible,
  intervalMs,
  onToggle,
  onIntervalChange,
}: {
  enabled: boolean;
  visible: boolean;
  intervalMs: number;
  onToggle: () => void;
  onIntervalChange: (ms: number) => void;
}) {
  const fetching = useIsFetching({ queryKey: ["metagraphed"] });
  const qc = useQueryClient();
  const active = enabled && visible;
  const [secondsLeft, setSecondsLeft] = useState(Math.round(intervalMs / 1000));

  useEffect(() => {
    setSecondsLeft(Math.round(intervalMs / 1000));
    if (!active) return;
    const total = Math.round(intervalMs / 1000);
    const i = window.setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? total : s - 1));
    }, 1000);
    return () => window.clearInterval(i);
  }, [active, intervalMs]);

  // Throttled, deduped aria-live so the countdown never spams a screen reader.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const next = !enabled
      ? "Auto-refresh paused."
      : !visible
        ? "Auto-refresh paused while tab is hidden."
        : `Auto-refresh on, every ${Math.round(intervalMs / 1000)} seconds.`;
    const t = window.setTimeout(() => {
      setAnnouncement((prev) => (prev === next ? prev : next));
    }, 900);
    return () => window.clearTimeout(t);
  }, [enabled, visible, intervalMs]);

  const pauseLabel = !enabled ? "Paused" : !visible ? "Tab hidden" : null;

  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card overflow-hidden text-[11px]">
      <label className="sr-only" htmlFor="health-interval">
        Auto-refresh interval
      </label>
      <select
        id="health-interval"
        value={intervalMs}
        onChange={(e) => onIntervalChange(Number(e.target.value))}
        disabled={!enabled}
        className="bg-card px-2 py-1 text-ink focus:outline-none disabled:opacity-60 border-r border-border"
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            every {opt.label}
          </option>
        ))}
      </select>

      <button
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-ink hover:bg-surface/60 transition-colors border-r border-border"
        title={enabled ? "Pause auto-refresh" : "Resume auto-refresh"}
        aria-pressed={enabled}
      >
        {enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
        {pauseLabel ? (
          <span className="font-mono uppercase tracking-widest text-[10px] text-ink-muted">
            {pauseLabel}
          </span>
        ) : (
          <span aria-hidden="true" className="font-mono text-ink-muted">
            in <AnimatedNumber value={secondsLeft} flashOnChange={false} duration={250} />s
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => qc.invalidateQueries({ queryKey: ["metagraphed"] })}
        className="inline-flex items-center gap-1 px-2 py-1 font-mono uppercase tracking-widest text-[10px] text-ink-muted hover:text-ink-strong hover:bg-surface/60 transition-colors"
        title={fetching ? "Refreshing…" : "Refresh now"}
        aria-label="Refresh now"
      >
        <RefreshCw
          className={classNames(
            "size-3",
            fetching ? "animate-spin text-ink-strong" : "text-ink-muted",
          )}
        />
        {fetching ? "sync" : "refresh"}
      </button>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

function GlobalHealth({ interval }: { interval: number | false }) {
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval: interval });
  const { data: fRes } = useSuspenseQuery({ ...freshnessQuery(), refetchInterval: interval });
  const h = hRes.data;
  const f = fRes.data;
  const stale = isStaleFreshness(hRes.meta?.generated_at);
  const segs = [
    { label: "OK", value: h?.ok ?? 0, color: "var(--health-ok, #22c55e)" },
    { label: "Warn", value: h?.warn ?? 0, color: "var(--health-warn, #f59e0b)" },
    { label: "Down", value: h?.down ?? 0, color: "var(--health-down, #ef4444)" },
    { label: "Unknown", value: h?.unknown ?? 0, color: "var(--ink-muted, #94a3b8)" },
  ].filter((s) => s.value > 0);
  const uptimePct = h?.uptime_24h != null ? (h.uptime_24h * 100).toFixed(2) + "%" : "—";
  const sourceAges =
    (f?.sources ?? [])
      .map((s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 1000 : null))
      .filter((v): v is number => typeof v === "number") ?? [];
  return (
    <div className="space-y-4">
      {stale ? <StaleBanner generatedAt={hRes.meta?.generated_at} /> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded border border-border bg-card p-3 flex items-center gap-4">
          <Donut
            segments={segs}
            size={96}
            strokeWidth={12}
            centerLabel={uptimePct}
            centerSub="uptime 24h"
          />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1">
              Status mix
            </div>
            <DonutLegend segments={segs} />
          </div>
        </div>
        <div className="rounded border border-border bg-card p-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-2">
            Source freshness
          </div>
          <Sparkline values={sourceAges} width={280} height={56} ariaLabel="Source freshness" />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Cell label="Avg age" num={f?.avg_age_seconds} format={(n) => humaniseSeconds(n)} />
            <Cell label="Max age" num={f?.max_age_seconds} format={(n) => humaniseSeconds(n)} />
            <Cell label="Stale" num={f?.stale_count} />
          </div>
        </div>
        <div className="rounded border border-border bg-card p-3 grid grid-cols-2 gap-2">
          <Cell label="OK" num={h?.ok} accent="text-health-ok" />
          <Cell label="Warn" num={h?.warn} accent="text-health-warn" />
          <Cell label="Down" num={h?.down} accent="text-health-down" />
          <Cell label="Unknown" num={h?.unknown} accent="text-ink-muted" />
        </div>
      </div>
      <div className="text-[11px] font-mono text-ink-muted">
        snapshot <TimeAgo at={hRes.meta?.generated_at} />
      </div>
    </div>
  );
}

function Cell({
  label,
  num,
  accent,
  format,
}: {
  label: string;
  num: number | null | undefined;
  accent?: string;
  format?: (n: number) => string;
}) {
  return (
    <div className="bg-card p-3 mg-kpi">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div
        className={`mg-kpi-num font-display text-xl font-semibold tabular-nums ${accent ?? "text-ink-strong"}`}
      >
        <AnimatedNumber value={num} format={format} />
      </div>
    </div>
  );
}

function SourceHealth({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...sourceHealthQuery(), refetchInterval: interval });
  const rows = data.data ?? [];
  if (rows.length === 0) return <EmptyState title="No source health" />;
  return (
    <div className="rounded border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-4 py-2.5 text-left">Source</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5 text-right">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s) => (
            <tr key={s.name}>
              <td className="px-4 py-2.5 font-medium">{s.name}</td>
              <td className="px-4 py-2.5">
                <HealthPill state={s.ok === false ? "down" : s.ok ? "ok" : "unknown"} />
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                <TimeAgo at={s.last_seen} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Extract a stable "host" key from an incident's endpoint_id. Examples:
 *   "endpoint-sn-1-subnetradar-dashboard" → "subnetradar-dashboard"
 *   "endpoint-sn-40-chunking-website"      → "chunking-website"
 *   "endpoint-sn7-allways"                 → "allways"
 *   anything else                          → the raw id
 */
function hostKeyFromEndpointId(id: unknown): string {
  if (id === null || id === undefined || id === "") return "—";
  const text = String(id);
  const m = text.match(/^endpoint-sn-?\d+-(.+)$/i);
  return m ? m[1]! : text;
}

type SeverityRank = 0 | 1 | 2 | 3;
function severityRank(state: HealthState | undefined): SeverityRank {
  if (state === "down") return 3;
  if (state === "warn") return 2;
  if (state === "unknown") return 1;
  return 0;
}

type StateFilter = "all" | "down" | "warn" | "resolved";

function Incidents({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...endpointIncidentsQuery(), refetchInterval: interval });
  const rows = useMemo(() => (data.data ?? []) as EndpointIncident[], [data]);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    return rows.filter((i) => {
      const ongoing = !i.ended_at;
      if (filter === "all") return true;
      if (filter === "down") return ongoing && i.state === "down";
      if (filter === "warn") return ongoing && i.state === "warn";
      if (filter === "resolved") return !ongoing;
      return true;
    });
  }, [rows, filter]);

  const groups = useMemo(() => {
    const byHost = new Map<string, EndpointIncident[]>();
    for (const i of filtered) {
      const key = hostKeyFromEndpointId(i.endpoint_id);
      const list = byHost.get(key) ?? [];
      list.push(i);
      byHost.set(key, list);
    }
    const out = Array.from(byHost.entries()).map(([host, items]) => {
      const ongoing = items.filter((i) => !i.ended_at).length;
      const top = items.reduce<EndpointIncident>((acc, cur) => {
        return severityRank(cur.state) > severityRank(acc.state) ? cur : acc;
      }, items[0]!);
      return { host, items, ongoing, dominantState: top.state };
    });
    out.sort((a, b) => {
      const sev = severityRank(b.dominantState) - severityRank(a.dominantState);
      if (sev !== 0) return sev;
      return b.items.length - a.items.length;
    });
    return out;
  }, [filtered]);

  // 14-day incident sparkline (count of incidents per day, oldest first).
  const incidentsByDay = useMemo(() => {
    const buckets = new Map<string, number>();
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const r of rows) {
      const key = r.started_at?.slice(0, 10);
      if (key && buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return Array.from(buckets.values());
  }, [rows]);

  if (rows.length === 0) return <EmptyState title="No recent incidents" />;

  const visibleGroups = showAll ? groups : groups.slice(0, INCIDENT_INITIAL_VISIBLE);

  const FILTER_OPTIONS: Array<{ value: StateFilter; label: string; count: number }> = [
    { value: "all", label: "All", count: rows.length },
    {
      value: "down",
      label: "Down",
      count: rows.filter((i) => !i.ended_at && i.state === "down").length,
    },
    {
      value: "warn",
      label: "Degraded",
      count: rows.filter((i) => !i.ended_at && i.state === "warn").length,
    },
    {
      value: "resolved",
      label: "Resolved",
      count: rows.filter((i) => i.ended_at).length,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded border border-border bg-card p-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Incidents · 14d
          </div>
          <div className="font-display text-lg font-semibold text-ink-strong tabular-nums">
            {rows.length}
          </div>
        </div>
        <Sparkline
          values={incidentsByDay}
          width={220}
          height={36}
          color="var(--health-down, #ef4444)"
          ariaLabel="Incidents over time"
          className="ml-auto"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              setFilter(opt.value);
              setShowAll(false);
            }}
            className={classNames(
              "inline-flex items-center gap-1 rounded border px-2 py-1 font-mono uppercase tracking-widest transition-colors",
              filter === opt.value
                ? "border-ink/40 bg-surface text-ink-strong"
                : "border-border bg-card text-ink-muted hover:text-ink",
            )}
          >
            {opt.label}
            <span className="text-[10px] tabular-nums opacity-80">{opt.count}</span>
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {groups.length} {groups.length === 1 ? "host" : "hosts"} · {filtered.length} incidents
        </span>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="No incidents match this filter" />
      ) : (
        <>
          <ul className="space-y-2">
            {visibleGroups.map((g) => {
              const open = !!openGroups[g.host];
              const singleton = g.items.length === 1;
              if (singleton) {
                return <IncidentCard key={g.host} incident={g.items[0]!} />;
              }
              return (
                <li key={g.host} className="rounded border border-border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenGroups((s) => ({ ...s, [g.host]: !open }))}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface/40 transition-colors min-h-11"
                    aria-expanded={open}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 text-ink-muted shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 text-ink-muted shrink-0" />
                    )}
                    <HealthPill state={g.dominantState} />
                    <span className="font-mono text-[12px] text-ink-strong truncate">{g.host}</span>
                    <span className="ml-auto inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted shrink-0">
                      {g.ongoing > 0 ? (
                        <span className="text-health-down">{g.ongoing} ongoing</span>
                      ) : null}
                      <span>{g.items.length} total</span>
                    </span>
                  </button>
                  {open ? (
                    <ul className="grid gap-2 p-2 md:grid-cols-2 border-t border-border bg-paper/40">
                      {g.items.map((i) => (
                        <IncidentCard key={i.id} incident={i} />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {groups.length > INCIDENT_INITIAL_VISIBLE ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="block w-full rounded border border-border bg-card px-3 py-2 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 min-h-9"
            >
              {showAll ? "Show fewer" : `Show all ${groups.length} grouped incidents`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
