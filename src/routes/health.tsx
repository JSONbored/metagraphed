import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useRegistryEvents } from "@/hooks/use-registry-events";
import { Suspense, useEffect, useMemo, useState } from "react";
import { RefreshCw, Pause, Play, ChevronDown, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { HealthPill } from "@/components/metagraphed/chips";
import { Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { TableState } from "@/components/metagraphed/table-state";
import { PageHero } from "@/components/metagraphed/page-hero";
import { PageSection } from "@/components/metagraphed/page-section";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { IncidentCard } from "@/components/metagraphed/incident-card";
import { Donut, DonutLegend } from "@/components/metagraphed/charts/donut";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { SubnetHealthMatrix } from "@/components/metagraphed/subnet-health-matrix";
import { StatusMosaic } from "@/components/metagraphed/analytics/status-mosaic";
import { NetworkPulseBand } from "@/components/metagraphed/analytics/network-pulse-band";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
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
      { property: "og:title", content: "Health — Metagraphed" },
      {
        property: "og:description",
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
  // #1117: push a refresh on each registry publish, on top of the poll interval.
  useRegistryEvents();

  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <HealthHero
            interval={effectiveInterval}
            controls={
              <AutoRefreshControl
                enabled={enabled}
                visible={visible}
                intervalMs={intervalMs}
                onToggle={() => setEnabled((v) => !v)}
                onIntervalChange={setIntervalMs}
              />
            }
          />
        </Suspense>
      </QueryErrorBoundary>

      <main className="space-y-20 md:space-y-24">
        <TimeRangeProvider>
          <PageSection
            id="status-board"
            eyebrow="Status board"
            title="Global health, at a glance"
            description="Probe-derived state across every monitored surface."
            toolbar={<TimeRangeScrub />}
          >
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-56 w-full" />}>
                <StatusBoard interval={effectiveInterval} />
              </Suspense>
            </QueryErrorBoundary>
          </PageSection>

          <PageSection
            id="network-pulse"
            eyebrow="Network pulse"
            title="ok / warn / down distribution"
            description="Aggregate status over the selected range, with incident markers per bucket."
          >
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <NetworkPulseBand />
              </Suspense>
            </QueryErrorBoundary>
          </PageSection>

          <PageSection
            id="status-mosaic"
            eyebrow="Endpoints"
            title="Live status mosaic"
            description="Every monitored endpoint, colored by latest probe state. Filter by state; click a tile to open."
          >
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <StatusMosaic />
              </Suspense>
            </QueryErrorBoundary>
          </PageSection>
        </TimeRangeProvider>

        <PageSection
          id="subnet-matrix"
          eyebrow="Coverage"
          title="Subnet health matrix"
          description="Every active subnet, colored by latest probe state. Click a cell to open."
        >
          <SubnetHealthMatrix />
        </PageSection>

        <PageSection
          id="source-health"
          eyebrow="Sources"
          title="Source freshness"
          description="Where the registry pulls evidence from and how fresh each source is."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <SourceHealth interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>

        <PageSection
          id="incidents"
          eyebrow="Incidents"
          title="Live & recent incidents"
          description="Grouped by host. Ongoing incidents bubble to the top."
        >
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <Incidents interval={effectiveInterval} />
            </Suspense>
          </QueryErrorBoundary>
        </PageSection>
      </main>

      <ApiSourceFooter
        paths={["/api/v1/health", "/api/v1/freshness", "/api/v1/endpoint-incidents"]}
      />
    </AppShell>
  );
}

/* --------------------------- Hero --------------------------- */

function HealthHero({
  interval,
  controls,
}: {
  interval: number | false;
  controls: React.ReactNode;
}) {
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval: interval });
  const { data: fRes } = useSuspenseQuery({ ...freshnessQuery(), refetchInterval: interval });
  const { data: iRes } = useSuspenseQuery({
    ...endpointIncidentsQuery(),
    refetchInterval: interval,
  });
  const h = hRes.data;
  const f = fRes.data;
  const incidents = (iRes.data ?? []) as EndpointIncident[];

  // No per-hour uptime history is exposed on /health, so the hero KPI shows the
  // real current 24h uptime value only — we never ship a fabricated trend shape,
  // so there's no illustrative sparkline here.
  const uptimePct = h?.uptime_24h != null ? h.uptime_24h * 100 : null;

  const ongoing = incidents.filter((i) => !i.ended_at).length;

  return (
    <PageHero
      eyebrow="Operations"
      live
      title="Health & freshness"
      description="Probe-derived health. User submissions cannot set uptime, latency, or incident state."
      actions={controls}
      caption={<>health · {h?.total ?? "—"} surfaces</>}
      kpis={[
        {
          label: "Uptime · 24h",
          value: uptimePct != null ? uptimePct.toFixed(2) + "%" : "—",
        },
        { label: "OK", value: <AnimatedNumber value={h?.ok} />, hint: "surfaces" },
        { label: "Warn", value: <AnimatedNumber value={h?.warn} /> },
        { label: "Down", value: <AnimatedNumber value={h?.down} /> },
        {
          label: "Stale sources",
          value: <AnimatedNumber value={f?.stale_count} />,
          hint: f?.sources ? `of ${f.sources.length}` : undefined,
        },
        {
          label: "Ongoing incidents",
          value: <AnimatedNumber value={ongoing} />,
        },
      ]}
    />
  );
}

/* --------------------------- Auto-refresh control --------------------------- */

/**
 * Consolidated auto-refresh control. One pill-shaped control group:
 * interval select · pause/play with live countdown · sync indicator. The
 * "tab hidden" state is folded into the pause button's label so we don't
 * stack a third chip on top. Throttled aria-live keeps the countdown from
 * spamming screen readers.
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
    <div className="inline-flex items-center rounded-full border border-border bg-card overflow-hidden text-[11px]">
      <label className="sr-only" htmlFor="health-interval">
        Auto-refresh interval
      </label>
      <select
        id="health-interval"
        value={intervalMs}
        onChange={(e) => onIntervalChange(Number(e.target.value))}
        disabled={!enabled}
        className="bg-card px-3 py-1.5 text-ink focus:outline-none disabled:opacity-60 border-r border-border"
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            every {opt.label}
          </option>
        ))}
      </select>

      <button
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-ink hover:bg-surface/60 transition-colors border-r border-border"
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
        className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono uppercase tracking-widest text-[10px] text-ink-muted hover:text-ink-strong hover:bg-surface/60 transition-colors"
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

/* --------------------------- Status board --------------------------- */

function StatusBoard({ interval }: { interval: number | false }) {
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval: interval });
  const { data: fRes } = useSuspenseQuery({ ...freshnessQuery(), refetchInterval: interval });
  const h = hRes.data;
  const f = fRes.data;
  const stale = isStaleFreshness(hRes.meta?.generated_at);
  const segs = [
    { label: "OK", value: h?.ok ?? 0, color: "var(--health-ok)" },
    { label: "Warn", value: h?.warn ?? 0, color: "var(--health-warn)" },
    { label: "Down", value: h?.down ?? 0, color: "var(--health-down)" },
    { label: "Unknown", value: h?.unknown ?? 0, color: "var(--health-unknown)" },
  ].filter((s) => s.value > 0);
  const uptimePct = h?.uptime_24h != null ? (h.uptime_24h * 100).toFixed(2) + "%" : "—";

  const sourceAges =
    (f?.sources ?? [])
      .map((s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 1000 : null))
      .filter((v): v is number => typeof v === "number") ?? [];

  return (
    <div className="space-y-4">
      {stale ? (
        <StaleBanner
          generatedAt={hRes.meta?.generated_at}
          refreshQueryKeys={[
            healthQuery().queryKey,
            freshnessQuery().queryKey,
            sourceHealthQuery().queryKey,
          ]}
          refreshLabel="Refresh health now"
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
        <BoardCard title="Status mix">
          <div className="flex items-center gap-5">
            <Donut
              segments={segs}
              size={112}
              strokeWidth={14}
              centerLabel={uptimePct}
              centerSub="uptime 24h"
            />
            <div className="min-w-0 flex-1">
              <DonutLegend segments={segs} />
            </div>
          </div>
        </BoardCard>

        <BoardCard title="Source freshness">
          <Sparkline
            values={sourceAges}
            width={320}
            height={64}
            color="var(--accent)"
            ariaLabel="Source freshness"
            className="w-full"
          />
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Cell label="Avg age" num={f?.avg_age_seconds} format={(n) => humaniseSeconds(n)} />
            <Cell label="Max age" num={f?.max_age_seconds} format={(n) => humaniseSeconds(n)} />
            <Cell label="Stale" num={f?.stale_count} />
          </div>
        </BoardCard>

        <BoardCard title="Counts">
          <div className="grid grid-cols-2 gap-2">
            <Cell label="OK" num={h?.ok} accent="text-health-ok" />
            <Cell label="Warn" num={h?.warn} accent="text-health-warn" />
            <Cell label="Down" num={h?.down} accent="text-health-down" />
            <Cell label="Unknown" num={h?.unknown} accent="text-ink-muted" />
          </div>
        </BoardCard>
      </div>
      <div className="text-[11px] font-mono text-ink-muted">
        snapshot <TimeAgo at={hRes.meta?.generated_at} />
      </div>
    </div>
  );
}

function BoardCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted mb-3">
        {title}
      </div>
      {children}
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
    <div className="rounded-lg border border-border/60 bg-paper/40 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">{label}</div>
      <div
        className={`mt-1 font-display text-lg font-semibold tabular-nums leading-none ${accent ?? "text-ink-strong"}`}
      >
        <AnimatedNumber value={num} format={format} />
      </div>
    </div>
  );
}

/* --------------------------- Source health --------------------------- */

function SourceHealth({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...sourceHealthQuery(), refetchInterval: interval });
  const rows = data.data ?? [];
  if (rows.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No source health"
        description="Source freshness telemetry will appear once probes report in."
      />
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface-2/60 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-5 py-3 text-left">Source</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3 text-right">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s) => (
            <tr key={s.name} className="mg-row-hover">
              <td className="px-5 py-3 font-medium">{s.name}</td>
              <td className="px-5 py-3">
                <HealthPill state={s.ok === false ? "down" : s.ok ? "ok" : "unknown"} />
              </td>
              <td className="px-5 py-3 text-right font-mono text-[11px] text-ink-muted">
                <TimeAgo at={s.last_seen} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------- Incidents --------------------------- */

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
      const top = items.reduce<EndpointIncident>(
        (acc, cur) => (severityRank(cur.state) > severityRank(acc.state) ? cur : acc),
        items[0]!,
      );
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

  if (rows.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No recent incidents"
        description="Nothing is currently failing or degraded — everything's quiet."
      />
    );
  }

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
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
            Incidents · 14d
          </div>
          <div className="font-display text-2xl font-semibold text-ink-strong tabular-nums leading-none mt-1">
            {rows.length}
          </div>
        </div>
        <Sparkline
          values={incidentsByDay}
          width={260}
          height={44}
          color="var(--health-down)"
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
            aria-pressed={filter === opt.value}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono uppercase tracking-widest transition-all duration-150",
              filter === opt.value
                ? "border-ink/40 bg-ink-strong text-paper"
                : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-accent/40",
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
        <TableState variant="empty" title="No incidents match this filter" />
      ) : (
        <>
          <ul className="space-y-2">
            {visibleGroups.map((g) => {
              const open = !!openGroups[g.host];
              const singleton = g.items.length === 1;
              if (singleton) return <IncidentCard key={g.host} incident={g.items[0]!} />;
              return (
                <li
                  key={g.host}
                  className="rounded-xl border border-border bg-card overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpenGroups((s) => ({ ...s, [g.host]: !open }))}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface/40 transition-colors min-h-11"
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
                    <ul className="grid gap-2 p-3 md:grid-cols-2 border-t border-border bg-paper/40">
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
              className="block w-full rounded-xl border border-border bg-card px-3 py-2.5 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors min-h-9"
            >
              {showAll ? "Show fewer" : `Show all ${groups.length} grouped incidents`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
