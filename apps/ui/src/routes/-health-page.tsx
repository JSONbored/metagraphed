import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { HealthSearch } from "./health";
import { useSuspenseQuery, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useHydrated } from "@/hooks/use-hydrated";
import { useRegistryEvents } from "@/hooks/use-registry-events";
import { resolveRefetchInterval, usePageVisible } from "@/hooks/use-refetch-interval";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Pause, Play, ChevronDown, ChevronRight, ArrowUpRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CaptureCurrencyPanel } from "@/components/metagraphed/capture-currency-panel";
import { EmptyState, StaleBanner } from "@/components/metagraphed/states";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { IncidentCard } from "@/components/metagraphed/incident-card";
import {
  DataTable,
  HealthPill,
  TimeAgo,
  AnimatedNumber,
  CompositionBreakdown,
  AnalyticsSection,
  EntityHero,
  FactSentence,
  FactStrip,
  FactCell,
  TrendDelta,
} from "@jsonbored/ui-kit";
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
import {
  humaniseSeconds,
  isStaleFreshness,
  classNames,
  formatNumber,
} from "@/lib/metagraphed/format";
import type { EndpointIncident, HealthState } from "@/lib/metagraphed/types";
import type { HealthView, StateFilter } from "./health";

const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 5 * 60_000 },
];

const INCIDENT_INITIAL_VISIBLE = 12;

// Which section a `view` deep-link should scroll to + highlight. A bare
// `status` (no `view`) targets the incidents section too, since that's the
// only place `status` has any effect.
const VIEW_SECTION_ID: Record<HealthView, string | null> = {
  "": null,
  matrix: "subnet-matrix",
  incidents: "incidents",
  sources: "source-health",
  freshness: "status-board",
};

export function HealthPage() {
  const search = useSearch({ from: "/health" }) as HealthSearch;
  const [enabled, setEnabled] = useState(true);
  const [intervalMs, setIntervalMs] = useState(30_000);
  const visible = usePageVisible();
  const effectiveInterval = resolveRefetchInterval(intervalMs, enabled, visible);
  // #1117: push a refresh on each registry publish, on top of the poll interval.
  useRegistryEvents();

  const activeSectionId =
    VIEW_SECTION_ID[search.view] ?? (search.status !== "all" ? "incidents" : null);
  const sectionRing = (id: string) =>
    activeSectionId === id ? "ring-1 ring-accent/40 rounded" : undefined;

  useEffect(() => {
    if (!activeSectionId) return;
    const t = window.setTimeout(() => {
      document
        .getElementById(activeSectionId)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(t);
    // Deep-link arrival only — deliberately not re-run when `search` changes
    // afterward (e.g. clicking an incident-filter chip below), or the page
    // would yank itself back to this section every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell>
      <AsyncPanel height="xl">
        <HealthHero
          interval={effectiveInterval}
          controls={
            <>
              <div className="mg-actions">
                <Link
                  to="/status"
                  className="inline-flex items-center gap-1 rounded px-2 py-1 min-h-8 text-13 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                >
                  Public status
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              </div>
              <AutoRefreshControl
                enabled={enabled}
                visible={visible}
                intervalMs={intervalMs}
                onToggle={() => setEnabled((v) => !v)}
                onIntervalChange={setIntervalMs}
              />
            </>
          }
        />
      </AsyncPanel>

      <main className="space-y-20 md:space-y-24">
        <TimeRangeProvider>
          <AnalyticsSection
            id="status-board"
            name="Global health, at a glance"
            question="Probe-derived state across every monitored surface."
            controls={<TimeRangeScrub />}
            className={sectionRing("status-board")}
          >
            <AsyncPanel height="lg">
              <StatusBoard interval={effectiveInterval} />
            </AsyncPanel>
          </AnalyticsSection>

          <AnalyticsSection
            id="network-pulse"
            name="ok / warn / down distribution"
            question="Aggregate status over the selected range."
          >
            <AsyncPanel height="lg">
              <NetworkPulseBand />
            </AsyncPanel>
          </AnalyticsSection>

          <AnalyticsSection
            id="status-mosaic"
            name="Live status mosaic"
            question="Every monitored endpoint by its latest probe state."
          >
            <AsyncPanel height="lg">
              <StatusMosaic />
            </AsyncPanel>
          </AnalyticsSection>
        </TimeRangeProvider>

        <AnalyticsSection
          id="subnet-matrix"
          name="Subnet health matrix"
          question="Every active subnet, colored by latest probe state. Click a cell to open."
          className={sectionRing("subnet-matrix")}
        >
          <SubnetHealthMatrix />
        </AnalyticsSection>

        <AnalyticsSection
          id="source-health"
          name="Source freshness"
          question="Where the registry pulls evidence from and how fresh each source is."
          className={sectionRing("source-health")}
        >
          <AsyncPanel height="md">
            <SourceHealth interval={effectiveInterval} />
          </AsyncPanel>
        </AnalyticsSection>

        {/* #10300: /chain/indexer-lag and /health/failure-reasons were both
            published and rendered nowhere. The ops console is their home --
            "how current is our capture, and what is failing behind it" is the
            question this page exists to answer. */}
        <AnalyticsSection
          id="capture-currency"
          name="Capture currency & failure mix"
          question="How far behind the chain head our indexing is, and what is actually going wrong with the probes."
          className={sectionRing("capture-currency")}
        >
          <AsyncPanel height="md">
            <CaptureCurrencyPanel />
          </AsyncPanel>
        </AnalyticsSection>

        <AnalyticsSection
          id="incidents"
          name="Live & recent incidents"
          question="Grouped by host. Ongoing incidents bubble to the top."
          className={sectionRing("incidents")}
        >
          <AsyncPanel height="md">
            <Incidents interval={effectiveInterval} />
          </AsyncPanel>
        </AnalyticsSection>
      </main>

      <ApiSourceFooter
        paths={[
          "/api/v1/health",
          "/api/v1/freshness",
          "/api/v1/endpoint-incidents",
          "/api/v1/chain/indexer-lag",
          "/api/v1/health/failure-reasons",
        ]}
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
    <EntityHero
      name="Health & freshness"
      action={controls}
      sentence={
        <FactSentence>
          {
            <>
              Operational drill-down for maintainers — subnet matrix, endpoint mosaic, source
              freshness, and live incidents. Probe-derived only; submissions cannot set uptime or
              incident state. For plain-language uptime, see{" "}
              <Link to="/status" className="text-accent-text underline-offset-2 hover:underline">
                System status
              </Link>
              .
            </>
          }
        </FactSentence>
      }
      facts={
        <FactStrip>
          {[
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
          ].map((k) => (
            <FactCell
              key={k.label}
              label={k.label}
              value={k.value}
              hint={typeof k.hint === "string" ? k.hint : undefined}
            />
          ))}
        </FactStrip>
      }
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
    <div className="inline-flex items-center rounded border border-border bg-card overflow-hidden text-13">
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
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-ink hover:bg-surface transition-colors border-r border-border"
        aria-pressed={enabled}
      >
        {enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
        {pauseLabel ? (
          <span className="text-13 text-ink-muted">{pauseLabel}</span>
        ) : (
          <span aria-hidden="true" className="font-mono text-ink-muted">
            in <AnimatedNumber value={secondsLeft} flashOnChange={false} duration={250} />s
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => qc.invalidateQueries({ queryKey: ["metagraphed"] })}
        className="text-13 inline-flex items-center gap-1.5 px-3 py-1.5 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
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
  // `stale` reads the wall clock during render, so the server pass and the
  // client's first pass disagree by however long the response spent in flight
  // (#8241). Hold it at its pre-hydration value until hydration completes,
  // matching useHydrated's documented use.
  const hydrated = useHydrated();
  const h = hRes.data;
  const f = fRes.data;
  const stale = hydrated && isStaleFreshness(hRes.meta?.generated_at);
  const segs = [
    { label: "OK", value: h?.ok ?? 0, color: "var(--health-ok)" },
    { label: "Warn", value: h?.warn ?? 0, color: "var(--health-warn)" },
    { label: "Down", value: h?.down ?? 0, color: "var(--health-down)" },
    { label: "Unknown", value: h?.unknown ?? 0, color: "var(--health-unknown)" },
  ].filter((s) => s.value > 0);
  const uptimePct = h?.uptime_24h != null ? (h.uptime_24h * 100).toFixed(2) + "%" : "—";

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
          <CompositionBreakdown
            segments={segs.map((seg) => ({
              key: `status:${seg.label}`,
              label: seg.label,
              value: seg.value,
            }))}
            formatValue={(v) => formatNumber(v)}
            legendCols={4}
            ariaLabel={`Status mix · ${uptimePct} uptime 24h`}
          />
        </BoardCard>

        <BoardCard title="Source freshness">
          <div className="grid grid-cols-3 gap-2">
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
      <div className="text-11 text-ink-muted">
        snapshot <TimeAgo at={hRes.meta?.generated_at} />
      </div>
    </div>
  );
}

function BoardCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel flush>
      <div className="p-4">
        <div className="text-13 text-ink-muted mb-3">{title}</div>
        {children}
      </div>
    </Panel>
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
    <div className="rounded border border-border/60 bg-paper px-3 py-2.5">
      <div className="text-13 text-ink-muted">{label}</div>
      <div
        className={`mt-1 font-display text-16 font-semibold tabular-nums leading-none ${accent ?? "text-ink-strong"}`}
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
  return (
    <DataTable
      rows={rows}
      rowKey={(s) => s.name}
      caption="Source health"
      source="source-health"
      empty={
        <EmptyState
          title="No source health"
          description="Source freshness telemetry will appear once probes report in."
        />
      }
      columns={[
        { key: "name", label: "Source", sortable: true, value: (s) => s.name },
        {
          key: "status",
          label: "Status",
          kind: "status",
          sortable: true,
          value: (s) => (s.ok === false ? "down" : s.ok ? "ok" : "unknown"),
        },
        {
          key: "last_seen",
          label: "Last seen",
          kind: "time",
          sortable: true,
          align: "right",
          value: (s) => s.last_seen ?? null,
        },
      ]}
    />
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

function Incidents({ interval }: { interval: number | false }) {
  const { data } = useSuspenseQuery({ ...endpointIncidentsQuery(), refetchInterval: interval });
  const rows = useMemo(() => (data.data ?? []) as EndpointIncident[], [data]);
  // The 14-day bucket keys below are derived from the wall clock, so a server
  // pass that straddles a UTC midnight (or simply runs seconds earlier) builds
  // a different set of days than the client's first pass (#8241).
  const hydrated = useHydrated();
  const search = useSearch({ from: "/health" }) as HealthSearch;
  const navigate = useNavigate({ from: "/health" });
  const filter = search.status;
  const setFilter = (next: StateFilter) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, status: next }),
      resetScroll: false,
    });
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

  // 14-day incident trend (count of incidents per day, oldest first).
  const incidentsByDay = useMemo(() => {
    if (!hydrated) return [];
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
  }, [rows, hydrated]);

  if (rows.length === 0) {
    return (
      <EmptyState
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
      <Panel bodyClassName="flex items-center gap-4">
        <div>
          <div className="text-13 text-ink-muted">Incidents · 14d</div>
          <div className="font-display text-28 font-semibold text-ink-strong tabular-nums leading-none mt-1">
            {rows.length}
          </div>
        </div>
        <TrendDelta values={incidentsByDay} label="Incidents per day, 14d" className="ml-auto" />
      </Panel>

      <div className="flex flex-wrap items-center gap-1.5 text-11">
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
              "inline-flex items-center gap-1.5 rounded border px-3 py-1 font-mono transition-all duration-150",
              filter === opt.value
                ? "border-ink/40 bg-ink-strong text-paper"
                : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-accent/40",
            )}
          >
            {opt.label}
            <span className="text-10 tabular-nums opacity-80">{opt.count}</span>
          </button>
        ))}
        <span className="ml-auto text-10 text-ink-muted">
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
              if (singleton) return <IncidentCard key={g.host} incident={g.items[0]!} />;
              return (
                <li key={g.host} className="rounded border border-border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenGroups((s) => ({ ...s, [g.host]: !open }))}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface transition-colors min-h-11"
                    aria-expanded={open}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 text-ink-muted shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 text-ink-muted shrink-0" />
                    )}
                    <HealthPill state={g.dominantState} />
                    <span className="font-mono text-13 text-ink-strong truncate">{g.host}</span>
                    <span className="text-13 ml-auto inline-flex items-center gap-2 text-ink-muted shrink-0">
                      {g.ongoing > 0 ? (
                        <span className="text-health-down">{g.ongoing} ongoing</span>
                      ) : null}
                      <span>{g.items.length} total</span>
                    </span>
                  </button>
                  {open ? (
                    <ul className="grid gap-2 p-3 md:grid-cols-2 border-t border-border bg-paper">
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
              className="block w-full rounded border border-border bg-card px-3 py-2.5 text-13 font-medium text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors min-h-9"
            >
              {showAll ? "Show fewer" : `Show all ${groups.length} grouped incidents`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
