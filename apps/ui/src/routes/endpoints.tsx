import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useSuspenseQuery, useIsFetching } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner } from "@/components/metagraphed/states";
import { StateBlock } from "@/components/metagraphed/states/state-block";
import {
  HealthDot,
  SectionHeading,
  DownloadCsvButton,
  StatTile,
  ShareButton,
} from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  FilterChipRow,
  FilterSheet,
  PageMasthead,
  PagerFooter,
  PanelSkeleton,
  QueryBar,
  QueryProgress,
  ResponsiveTable,
  RoutePending,
  TabStrip,
  type FilterChipItem,
} from "@/components/metagraphed/primitives";
import { EndpointsPriorityStrip } from "@/components/metagraphed/endpoints-priority-strip";
import { EndpointOperationalList } from "@/components/metagraphed/endpoint-operational-list";
import { EndpointComparePanel } from "@/components/metagraphed/endpoint-compare-panel";

import { Radio, Server, ShieldCheck, Activity } from "lucide-react";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { LatencyHeatmap } from "@/components/metagraphed/charts/latency-heatmap";
import { IncidentsTimeline } from "@/components/metagraphed/analytics/incidents-timeline";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import { ProxyHero, ProxyUsagePanel } from "@/components/metagraphed/rpc-proxy";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { rpcEndpointsSummaryLine } from "@/lib/metagraphed/rpc-endpoints-summary";
import { buildUrl } from "@/lib/metagraphed/client";
import {
  endpointsQuery,
  endpointIncidentsQuery,
  endpointPoolsQuery,
  rpcPoolsQuery,
  rpcEndpointsQuery,
  statusToHealth,
  providersQuery,
  subnetsQuery,
  metagraphedQueryKey,
} from "@/lib/metagraphed/queries";
import {
  endpointCategory,
  endpointEligibility,
  indexPoolsById,
  ELIGIBILITY_LABEL,
  ELIGIBILITY_TONE,
  type EndpointCategory,
  type PoolEligibility,
} from "@/lib/metagraphed/endpoint-pool";

import type {
  Endpoint,
  EndpointIncident,
  RpcPool,
  RpcEndpoint,
  Provider,
  Subnet,
} from "@/lib/metagraphed/types";
import { activeFilterCount } from "@/lib/metagraphed/filter-disclosure";

const endpointsSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  category: fallback(z.enum(["all", "rpc", "wss", "api", "sse", "data", "other"]), "all").default(
    "all",
  ),
  provider: fallback(z.string(), "").default(""),
  health: fallback(z.string(), "").default(""),
  netuid: fallback(z.string(), "").default(""),
  region: fallback(z.string(), "").default(""),
  eligibility: fallback(z.string(), "").default(""),
  // "Callable only" hides non-callable directory links (category "other") by
  // default so the table answers "what can I call?" rather than burying it
  // under reference URLs. Persisted in the URL so the view is shareable.
  callable: fallback(z.boolean(), true).default(true),
  sort: fallback(
    z.enum(["netuid", "kind", "provider", "region", "health", "latency", "probed"]),
    "netuid",
  ).default("netuid"),
  order: fallback(z.enum(["asc", "desc"]), "asc").default("asc"),
  page: fallback(z.number().int().min(1), 1).default(1),
  pageSize: fallback(z.number().int().min(10).max(200), 25).default(25),
  view: fallback(z.enum(["table", "grid"]), "table").default("table"),
  // #3976: ProxyUsagePanel's 7d/30d window is URL-backed (like /explorer) so a
  // shared /endpoints link restores the same window and back/forward works.
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  // Deep-linkable expanded endpoint row. Empty string = collapsed.
  endpoint: fallback(z.string(), "").default(""),
  // Comma-separated endpoint IDs selected for side-by-side comparison.
  compare: fallback(z.string(), "").default(""),
});

type EndpointsSearch = z.infer<typeof endpointsSearchSchema>;

export const Route = createFileRoute("/endpoints")({
  validateSearch: zodValidator(endpointsSearchSchema),
  head: () => ({
    meta: [
      { title: "Endpoints — Metagraphed" },
      {
        name: "description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
      { property: "og:title", content: "Endpoints — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root Subtensor RPC/WSS and application endpoints with status, latency, and pool eligibility.",
      },
    ],
  }),
  pendingComponent: () => <RoutePending panels={3} />,
  component: EndpointsPage,
});

// Endpoints is the primary product on this page; proxy is one surface among
// several. Order tabs so the directory is the default landing view rather
// than making users click past the marketing panel to reach it.
type EndpointsTab = "endpoints" | "proxy" | "advanced" | "incidents";
const ENDPOINTS_TABS: ReadonlyArray<{ id: EndpointsTab; label: string }> = [
  { id: "endpoints", label: "Directory" },
  { id: "proxy", label: "Managed RPC" },
  { id: "advanced", label: "Pools" },
  { id: "incidents", label: "Incidents" },
];

function EndpointsPage() {
  const hash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    if (!hash) return;
    const id = hash.replace(/^#/, "");
    if (!id) return;
    // Defer to let Suspense resolve so the target row is in the DOM.
    const t = window.setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 220);
    return () => window.clearTimeout(t);
  }, [hash]);

  // #5329: the page stacked ~9 full-width panels into one ~95,000px feed on
  // mobile. Split its distinct concerns into tabs; each section fetches its own
  // data, so only the active tab's panels mount (and query) at a time.
  const [tab, setTab] = useState<EndpointsTab>("endpoints");
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Infrastructure"
        live
        title="Endpoints"
        description="Callable Subtensor and subnet endpoints — health, latency, and pool eligibility, plus a managed RPC proxy that fans requests across the healthiest members."
        actions={<ShareButton />}
      />
      <div className="space-y-section">
        {/* Endpoint KPIs stay visible above the tabs so the tab bar has context
            and doesn't float alone under the hero. */}
        <AsyncPanel
          context="endpoints overview"
          retryQueryKeys={[metagraphedQueryKey("endpoints"), metagraphedQueryKey("rpc-pools")]}
          fallback={
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <PanelSkeleton height="sm" />
              <PanelSkeleton height="sm" />
              <PanelSkeleton height="sm" />
              <PanelSkeleton height="sm" />
            </div>
          }
        >
          <EndpointsStatStrip />
        </AsyncPanel>
        <TabStrip
          items={ENDPOINTS_TABS}
          value={tab}
          onChange={(v: EndpointsTab) => setTab(v)}
          ariaLabel="Endpoints sections"
        />

        {tab === "proxy" && (
          <>
            <section>
              <ProxyHero />
            </section>
            <section>
              <SectionHeading title="Proxy usage" />
              <AsyncPanel
                height="md"
                context="proxy usage"
                retryQueryKeys={[metagraphedQueryKey("rpc-usage")]}
              >
                <ProxyUsagePanel />
              </AsyncPanel>
            </section>
          </>
        )}

        {tab === "endpoints" && (
          <>
            <AsyncPanel
              context="priority signals"
              retryQueryKeys={[
                metagraphedQueryKey("endpoints"),
                metagraphedQueryKey("endpoint-incidents"),
              ]}
              fallback={
                <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <PanelSkeleton key={i} height="sm" />
                  ))}
                </div>
              }
            >
              <EndpointsPriorityStrip />
            </AsyncPanel>
            <section>
              <SectionHeading title="Endpoint directory" />
              <AsyncPanel
                height="lg"
                context="endpoints"
                retryQueryKeys={[
                  metagraphedQueryKey("endpoints"),
                  metagraphedQueryKey("rpc-pools"),
                  metagraphedQueryKey("endpoint-incidents"),
                  metagraphedQueryKey("providers"),
                  metagraphedQueryKey("subnets"),
                ]}
              >
                <EndpointsTable />
              </AsyncPanel>
            </section>
            <TimeRangeProvider>
              <section>
                <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
                  <SectionHeading title="Latency diagnostics" />
                  <TimeRangeScrub />
                </div>
                <AsyncPanel
                  height="lg"
                  context="latency heatmap"
                  retryQueryKeys={[metagraphedQueryKey("endpoints")]}
                >
                  <LatencyHeatmapSection />
                </AsyncPanel>
              </section>
            </TimeRangeProvider>
          </>
        )}

        {tab === "advanced" && (
          <>
            <section>
              <SectionHeading title="RPC pools" />
              <AsyncPanel
                height="sm"
                context="RPC pools"
                retryQueryKeys={[metagraphedQueryKey("rpc-pools")]}
              >
                <PoolsTable />
              </AsyncPanel>
            </section>
            <section>
              <SectionHeading title="Endpoint pools" />
              <AsyncPanel
                height="sm"
                context="endpoint pools"
                retryQueryKeys={[metagraphedQueryKey("endpoint-pools")]}
              >
                <EndpointPoolsTable />
              </AsyncPanel>
            </section>
            <section>
              <SectionHeading title="Root RPC/WSS endpoints" />
              <AsyncPanel
                height="sm"
                context="root RPC/WSS endpoints"
                retryQueryKeys={[metagraphedQueryKey("rpc-endpoints")]}
              >
                <RpcEndpointsTable />
              </AsyncPanel>
            </section>
          </>
        )}

        {tab === "incidents" && (
          <>
            <section>
              <SectionHeading title="Incidents timeline" />
              <AsyncPanel
                height="md"
                context="incidents"
                retryQueryKeys={[metagraphedQueryKey("endpoint-incidents")]}
              >
                <IncidentsTimeline />
              </AsyncPanel>
            </section>
          </>
        )}
      </div>
      <ApiSourceFooter
        paths={[
          "/rpc/v1/finney",
          "/api/v1/rpc/usage",
          "/api/v1/endpoints",
          "/api/v1/rpc/pools",
          "/api/v1/endpoint-pools",
          "/api/v1/rpc/endpoints",
          "/api/v1/endpoint-incidents",
        ]}
      />
    </AppShell>
  );
}

function EndpointsStatStrip() {
  const rows = (useSuspenseQuery(endpointsQuery()).data.data ?? []) as Endpoint[];
  const pools = (useSuspenseQuery(rpcPoolsQuery()).data.data ?? []) as RpcPool[];
  const total = rows.length;
  const archive = rows.filter((e) => e.archive).length;
  const proxy = pools.filter((p) => p.proxy_enabled).length;
  // "Healthy %" must divide by the PROBED population, not all ~1173 endpoints —
  // most rows are unprobed directory links (health "unknown") and dragged the
  // ratio down to ~5%. A row is probed once it has a real probe-derived health
  // state (normalizeEndpoint leaves unprobed rows as "unknown").
  const probed = rows.filter((e) => e.health && e.health !== "unknown");
  const ok = probed.filter((e) => e.health === "ok").length;
  const okPct = probed.length > 0 ? Math.round((ok / probed.length) * 100) : null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile icon={Radio} eyebrow="Endpoints" value={total} hint="tracked" />
      <StatTile
        icon={Server}
        eyebrow="RPC pools"
        value={pools.length}
        hint={proxy ? `${proxy} proxy` : undefined}
        tone="accent"
      />
      <StatTile icon={ShieldCheck} eyebrow="Archive-capable" value={archive} />
      <StatTile
        icon={Activity}
        eyebrow="Healthy"
        value={okPct != null ? `${okPct}%` : "—"}
        hint={`${ok}/${probed.length} probed`}
        tone={okPct != null && okPct > 90 ? "ok" : okPct != null && okPct < 70 ? "warn" : "default"}
      />
    </div>
  );
}

function LatencyHeatmapSection() {
  const { data } = useSuspenseQuery(endpointsQuery());
  // The callable-endpoints table below is scoped to callable kinds (rpc/wss/api/
  // sse/data — i.e. not "other" directory links). Feed the heatmap the same
  // callable-scoped population so both describe the same set of endpoints.
  const callable = useMemo(() => {
    const rows = (data.data ?? []) as Endpoint[];
    return rows.filter((e) => endpointCategory(e.kind) !== "other");
  }, [data]);
  return <LatencyHeatmap endpoints={callable} />;
}

function PoolsTable() {
  const { data } = useSuspenseQuery(rpcPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  const stale = isStaleFreshness(data.meta?.generated_at);
  if (rows.length === 0)
    return (
      <EmptyState
        title="No RPC pools tracked"
        description="The proxy routes across registered pools — pool members and their eligibility appear here once registered."
      />
    );
  return (
    <div className="space-y-2">
      {stale ? (
        <StaleBanner
          generatedAt={data.meta?.generated_at}
          refreshQueryKeys={[
            rpcPoolsQuery().queryKey,
            endpointsQuery().queryKey,
            endpointIncidentsQuery().queryKey,
          ]}
        />
      ) : null}
      <ResponsiveTable className="rounded border border-border bg-card" minWidth={720}>
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface/50 text-[10px] text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Pool</th>
              <th className="px-3 py-2 text-left">Region</th>
              <th className="px-3 py-2 text-right">Members</th>
              <th className="px-3 py-2 text-center">Archive</th>
              <th className="px-3 py-2 text-center">Eligibility</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p) => {
              const eligibility: PoolEligibility = p.proxy_enabled
                ? "proxy-enabled"
                : p.archive_capable
                  ? "archive-capable"
                  : "pool-member";
              return (
                <tr
                  key={p.id}
                  id={`pool-${p.id}`}
                  className="mg-row-hover scroll-mt-24 target:bg-accent/10"
                >
                  <td className="px-3 py-2 font-medium text-ink-strong">{p.name ?? p.id}</td>
                  <td className="px-3 py-2 text-[12px]">{p.region ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{p.members_count ?? "—"}</td>
                  <td className="px-3 py-2 text-center text-[11px] text-ink-muted">
                    {p.archive_capable ? "yes" : "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span
                      className={classNames(
                        "mg-type-micro inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]",
                        ELIGIBILITY_TONE[eligibility],
                      )}
                    >
                      {ELIGIBILITY_LABEL[eligibility]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ResponsiveTable>
      <p className="px-1 font-mono text-[10px] text-ink-muted">
        Proxy-eligible members serve live traffic through the reverse proxy above; the proxy prefers
        in-sync, healthy nodes and fails over automatically.
      </p>
    </div>
  );
}

function EndpointPoolsTable() {
  const { data } = useSuspenseQuery(endpointPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  const stale = isStaleFreshness(data.meta?.generated_at);
  if (rows.length === 0)
    return (
      <EmptyState
        title="No endpoint pools tracked"
        description="Generalized pool composition across subtensor-rpc, subtensor-wss, and archive kinds appears here once pools are scored."
      />
    );
  return (
    <div className="space-y-2">
      {stale ? (
        <StaleBanner
          generatedAt={data.meta?.generated_at}
          refreshQueryKeys={[
            endpointPoolsQuery().queryKey,
            endpointsQuery().queryKey,
            endpointIncidentsQuery().queryKey,
          ]}
        />
      ) : null}
      <ResponsiveTable className="rounded border border-border bg-card" minWidth={720}>
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface/50 text-[10px] text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Pool</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-right">Endpoints</th>
              <th className="px-3 py-2 text-left">Best endpoint</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p) => {
              const eligible = typeof p.eligible_count === "number" ? p.eligible_count : null;
              const total =
                typeof p.endpoint_count === "number"
                  ? p.endpoint_count
                  : typeof p.members_count === "number"
                    ? p.members_count
                    : null;
              const bestId =
                typeof p.best_endpoint_id === "string" && p.best_endpoint_id.trim()
                  ? p.best_endpoint_id
                  : null;
              return (
                <tr
                  key={p.id}
                  id={`endpoint-pool-${p.id}`}
                  className="mg-row-hover scroll-mt-24 target:bg-accent/10"
                >
                  <td className="px-3 py-2 font-medium text-ink-strong">{p.id}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{String(p.kind ?? "—")}</td>
                  <td className="px-3 py-2 text-right font-mono text-[11px]">
                    {eligible != null && total != null
                      ? `${eligible}/${total} eligible`
                      : total != null
                        ? String(total)
                        : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                    {bestId ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ResponsiveTable>
      <p className="px-1 font-mono text-[10px] text-ink-muted">
        Covers all pool kinds (subtensor-rpc, subtensor-wss, archive) from the generalized
        endpoint-pools artifact — distinct from the Bittensor RPC proxy pools above.
      </p>
    </div>
  );
}

const CLASSIFICATION_TONE: Record<string, string> = {
  live: "border-health-ok/40 text-health-ok",
  redirected: "border-health-warn/40 text-health-warn",
  "auth-required": "border-ink-subtle text-ink-muted",
  dead: "border-health-down/40 text-health-down",
  unsafe: "border-health-down/40 text-health-down",
  unsupported: "border-ink-subtle text-ink-muted",
  "rate-limited": "border-health-warn/40 text-health-warn",
  unknown: "border-ink-subtle text-ink-muted",
};

function RpcEndpointsTable() {
  const { data } = useSuspenseQuery(rpcEndpointsQuery());
  const rows = data.data.endpoints;
  const summaryLine = rpcEndpointsSummaryLine(data.data.summary);
  const stale = isStaleFreshness(data.meta?.generated_at);
  if (rows.length === 0)
    return (
      <EmptyState
        title="No RPC endpoints tracked"
        description="The base-layer Subtensor RPC/WSS registry appears here once endpoints are registered."
      />
    );
  return (
    <div className="space-y-2">
      {stale ? (
        <StaleBanner
          generatedAt={data.meta?.generated_at}
          refreshQueryKeys={[rpcEndpointsQuery().queryKey]}
        />
      ) : null}
      <ResponsiveTable className="rounded border border-border bg-card" minWidth={720}>
        <table className="w-full text-sm">
          <thead className="mg-type-micro bg-surface/50 text-[10px] text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Provider</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Classification</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Archive</th>
              <th className="px-3 py-2 text-right">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((e: RpcEndpoint) => (
              <tr key={e.id} className="mg-row-hover">
                <td className="px-3 py-2 font-medium text-ink-strong">{e.provider ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={classNames(
                      "mg-type-micro inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]",
                      CLASSIFICATION_TONE[e.classification ?? "unknown"] ??
                        CLASSIFICATION_TONE.unknown,
                    )}
                  >
                    {e.classification ?? "unknown"}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  <HealthDot state={statusToHealth(e.status)} />
                </td>
                <td className="px-3 py-2 text-center text-[11px] text-ink-muted">
                  {e.archive_support == null ? "—" : e.archive_support ? "yes" : "no"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px]">
                  {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
      {summaryLine ? (
        <p className="px-1 font-mono text-[10px] text-ink-muted">{summaryLine}</p>
      ) : null}
    </div>
  );
}

type SortKey = "netuid" | "kind" | "provider" | "region" | "health" | "latency" | "probed";
const HEALTH_RANK: Record<string, number> = { ok: 0, warn: 1, down: 2, unknown: 3 };

function endpointValue(e: Endpoint, k: SortKey): string | number | null {
  switch (k) {
    case "netuid":
      return e.netuid ?? null;
    case "kind":
      return e.kind ?? "";
    case "provider":
      return e.provider ?? e.provider_slug ?? "";
    case "region":
      return e.region ?? "";
    case "health":
      return HEALTH_RANK[String(e.health ?? "unknown")] ?? 99;
    case "latency":
      return e.latency_ms ?? Number.POSITIVE_INFINITY;
    case "probed":
      return e.last_probed_at ? Date.parse(e.last_probed_at) : 0;
  }
}

function EndpointsTable() {
  const { data } = useSuspenseQuery(endpointsQuery());
  const { data: poolsRes } = useSuspenseQuery(rpcPoolsQuery());
  const { data: incRes } = useSuspenseQuery(endpointIncidentsQuery());
  const rows = useMemo(() => (data.data ?? []) as Endpoint[], [data]);
  const pools = useMemo(() => (poolsRes.data ?? []) as RpcPool[], [poolsRes]);
  const incidents = useMemo(() => (incRes.data ?? []) as EndpointIncident[], [incRes]);
  // O(1) pool lookup — index once, reuse for every endpoint's eligibility.
  const poolsById = useMemo(() => indexPoolsById(pools), [pools]);
  const generatedAt = data.meta?.generated_at as string | undefined;
  const stale = isStaleFreshness(generatedAt);
  // expandedId is URL-driven so the drawer is deep-linkable and preserved on
  // back/forward without stacking history entries.

  // Lookup maps for inline subnet + provider logos.
  const { data: provRes } = useSuspenseQuery(providersQuery());
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  const providerById = useMemo(() => {
    const m = new Map<string, Provider>();
    for (const p of (provRes.data ?? []) as Provider[]) m.set(p.slug, p);
    return m;
  }, [provRes]);
  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);

  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const expandedId = search.endpoint || null;
  const toggleExpanded = (id: string) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, endpoint: prev.endpoint === id ? "" : id }) as never,
      resetScroll: false,
      replace: true,
    });

  // Compare state: URL-driven CSV of endpoint IDs (capped at 4).
  const COMPARE_MAX = 4;
  const compareIds = useMemo(() => {
    const set = new Set<string>();
    for (const raw of (search.compare ?? "").split(",")) {
      const id = raw.trim();
      if (id) set.add(id);
      if (set.size >= COMPARE_MAX) break;
    }
    return set;
  }, [search.compare]);
  const toggleCompare = (id: string) => {
    const next = new Set(compareIds);
    if (next.has(id)) next.delete(id);
    else if (next.size < COMPARE_MAX) next.add(id);
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, compare: Array.from(next).join(",") }) as never,
      resetScroll: false,
      replace: true,
    });
  };
  const clearCompare = () =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, compare: "" }) as never,
      resetScroll: false,
      replace: true,
    });

  const setSearch = (patch: Partial<EndpointsSearch>) => {
    // Any filter change resets page to 1 unless caller specifies otherwise.
    const resetsPage =
      Object.keys(patch).some((k) =>
        [
          "q",
          "category",
          "provider",
          "health",
          "netuid",
          "region",
          "eligibility",
          "callable",
        ].includes(k),
      ) && patch.page == null;
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, ...patch, ...(resetsPage ? { page: 1 } : {}) }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
      replace: true,
    });
  };

  const providers = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.provider ?? r.provider_slug).filter(Boolean) as string[]),
      ).sort(),
    [rows],
  );
  const regions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.region).filter(Boolean) as string[])).sort(),
    [rows],
  );

  // Pre-compute category + eligibility per endpoint once (O(1) eligibility via
  // the indexed pool map).
  const enriched = useMemo(
    () =>
      rows.map((e) => ({
        e,
        cat: endpointCategory(e.kind),
        eli: endpointEligibility(e, poolsById),
      })),
    [rows, poolsById],
  );

  // "Callable" = anything an agent can actually POST/GET against (rpc/wss/api/
  // sse/data). The registry also carries non-callable directory links (websites,
  // docs, dashboards → category "other"); those are hidden by default so the
  // table answers "what can I call?" rather than burying it under reference URLs.
  const directoryCount = useMemo(
    () => enriched.filter((x) => x.cat === "other").length,
    [enriched],
  );
  const scoped = useMemo(
    () => (search.callable ? enriched.filter((x) => x.cat !== "other") : enriched),
    [enriched, search.callable],
  );

  const netuidNum = search.netuid.trim() === "" ? null : Number(search.netuid);

  // Category chip counts reflect every active filter EXCEPT category itself,
  // so the chip count truthfully says "how many endpoints would I see if I
  // picked this kind, with my other filters applied?".
  const categoryCounts = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    const matchOther = ({ e, eli }: { e: Endpoint; cat: EndpointCategory; eli: string }) => {
      if (search.provider && (e.provider ?? e.provider_slug) !== search.provider) return false;
      if (search.health && (e.health ?? "unknown") !== search.health) return false;
      if (search.region && e.region !== search.region) return false;
      if (search.eligibility && eli !== search.eligibility) return false;
      if (netuidNum != null && Number.isFinite(netuidNum) && e.netuid !== netuidNum) return false;
      if (!needle) return true;
      return [e.url, e.provider, e.provider_slug, e.region, String(e.netuid ?? ""), e.kind, e.id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    };
    const counts: Partial<Record<EndpointCategory | "all", number>> = { all: 0 };
    for (const x of scoped) {
      if (!matchOther(x)) continue;
      counts.all = (counts.all ?? 0) + 1;
      counts[x.cat] = (counts[x.cat] ?? 0) + 1;
    }
    return counts;
  }, [
    scoped,
    search.q,
    search.provider,
    search.health,
    search.region,
    search.eligibility,
    netuidNum,
  ]);

  const filtered = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    return scoped
      .filter(({ e, cat, eli }) => {
        if (search.category !== "all" && cat !== search.category) return false;
        if (search.provider && (e.provider ?? e.provider_slug) !== search.provider) return false;
        if (search.health && (e.health ?? "unknown") !== search.health) return false;
        if (search.region && e.region !== search.region) return false;
        if (search.eligibility && eli !== search.eligibility) return false;
        if (netuidNum != null && Number.isFinite(netuidNum) && e.netuid !== netuidNum) return false;
        if (!needle) return true;
        return [e.url, e.provider, e.provider_slug, e.region, String(e.netuid ?? ""), e.kind, e.id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle));
      })
      .map((x) => x.e);
  }, [
    scoped,
    search.q,
    search.category,
    search.provider,
    search.health,
    search.region,
    search.eligibility,
    netuidNum,
  ]);

  const sorted = useMemo(() => {
    const mul = search.order === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = endpointValue(a, search.sort);
      const vb = endpointValue(b, search.sort);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [filtered, search.sort, search.order]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / search.pageSize));
  const safePage = Math.min(search.page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * search.pageSize, safePage * search.pageSize);

  // Same mobile-disclosure treatment as /blocks and /extrinsics (#5323): this
  // toolbar has even more controls, so an always-visible filter bar pushed the
  // first endpoint row down on a 375px viewport (#6580). Count only the six
  // collapsible text/select filters for the toggle badge.
  const activeCount = activeFilterCount([
    search.q,
    search.netuid,
    search.provider,
    search.region,
    search.health,
    search.eligibility,
  ]);

  // The table filters client-side over the full fetched list; the CSV export
  // hits the backend route directly (full endpoint snapshot, no client filters).
  const endpointsCsvUrl = buildUrl("/api/v1/endpoints");
  const sortPreset = `${search.sort}:${search.order}`;
  const setSortPreset = (value: string) => {
    const [sort, order] = value.split(":") as [EndpointsSearch["sort"], EndpointsSearch["order"]];
    setSearch({ sort, order, page: 1 });
  };

  // Reset clears search/filters/sort/page but keeps page size, view, and the
  // callable-only default (true).
  const resetAll = () =>
    navigate({
      search: { pageSize: search.pageSize, view: search.view } as never,
      replace: true,
    });

  // Hooks must run unconditionally, before the early-empty-state return below.
  const isFetchingRows = useIsFetching({ queryKey: metagraphedQueryKey("endpoints") }) > 0;

  if (rows.length === 0)
    return (
      <StateBlock
        kind="registry"
        variant="empty"
        title="No endpoints in the registry"
        description="The endpoints artifact returned no rows. The source may be temporarily unavailable — inspect the raw API response or try again shortly."
        updatedAt={generatedAt}
        windowLabel="latest snapshot"
        freshnessHint="Endpoint records refresh every probe cycle. A missing row means the probe hasn't reached the source yet."
        evidenceHref="/metagraph/endpoints.json"
        actions={[
          {
            label: "Open /api/v1/endpoints",
            href: "/api/v1/endpoints",
            external: true,
            primary: true,
          },
          { label: "Browse providers", to: "/providers" },
        ]}
      />
    );

  return (
    <div className="space-y-3 relative">
      <QueryProgress active={isFetchingRows} position="sticky" />
      {/* One shared command surface replaces the previous stacked category,
          search, select, toggle, and view-control bars. */}
      <div
        className="sticky z-20 -mx-1 bg-paper/92 px-1 py-2 backdrop-blur"
        style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
      >
        <QueryBar ariaLabel="Filter endpoint directory">
          <QueryBar.Search
            value={search.q}
            onChange={(v) => setSearch({ q: v })}
            debounceMs={180}
            placeholder="Search URL, provider, netuid…"
          />
          <QueryBar.Divider />
          <div className="hidden items-center sm:flex">
            <QueryBar.FilterTrigger
              label="Kind"
              value={search.category === "all" ? "" : search.category}
              onChange={(v) => setSearch({ category: (v || "all") as EndpointsSearch["category"] })}
              options={(
                [
                  ["rpc", "RPC"],
                  ["wss", "WSS"],
                  ["api", "API"],
                  ["sse", "SSE"],
                  ["data", "Data"],
                  ["other", "Other"],
                ] as const
              )
                .filter(([value]) => (categoryCounts[value] ?? 0) > 0)
                .map(([value, label]) => ({
                  value,
                  label: `${label} · ${categoryCounts[value] ?? 0}`,
                }))}
            />
            <QueryBar.FilterTrigger
              label="Health"
              value={search.health}
              onChange={(v) => setSearch({ health: v })}
              options={["ok", "warn", "down", "unknown"].map((value) => ({ value, label: value }))}
            />
            <QueryBar.FilterTrigger
              label="Sort"
              value={sortPreset}
              onChange={setSortPreset}
              options={[
                { value: "netuid:asc", label: "Subnet number" },
                { value: "health:asc", label: "Health first" },
                { value: "latency:asc", label: "Fastest latency" },
                { value: "latency:desc", label: "Slowest latency" },
                { value: "probed:desc", label: "Newest probe" },
                { value: "provider:asc", label: "Provider A–Z" },
              ]}
            />
            <div className="hidden xl:contents">
              <QueryBar.FilterTrigger
                label="Provider"
                value={search.provider}
                onChange={(v) => setSearch({ provider: v })}
                options={providers.map((value) => ({ value, label: value }))}
              />
              <QueryBar.FilterTrigger
                label="Region"
                value={search.region}
                onChange={(v) => setSearch({ region: v })}
                options={regions.map((value) => ({ value, label: value }))}
              />
              <QueryBar.FilterTrigger
                label="Access"
                value={search.eligibility}
                onChange={(v) => setSearch({ eligibility: v })}
                options={[
                  { value: "proxy-enabled", label: "Proxy enabled" },
                  { value: "pool-member", label: "Pool member" },
                  { value: "archive-capable", label: "Archive capable" },
                  { value: "unassigned", label: "Unassigned" },
                ]}
              />
            </div>
          </div>
          <QueryBar.Utility>
            <FilterSheet
              label="More filters"
              activeCount={activeFilterCount([
                search.netuid,
                search.provider,
                search.region,
                search.eligibility,
              ])}
              className="xl:hidden"
            >
              <label className="grid gap-1">
                <span className="mg-label">Subnet number</span>
                <input
                  value={search.netuid}
                  onChange={(event) =>
                    setSearch({ netuid: event.target.value.replace(/[^0-9]/g, "") })
                  }
                  inputMode="numeric"
                  placeholder="Any subnet"
                  className="h-9 rounded border border-border bg-paper px-2 font-mono text-[12px] text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <QueryBar.FilterTrigger
                label="Provider"
                value={search.provider}
                onChange={(value) => setSearch({ provider: value })}
                options={providers.map((value) => ({ value, label: value }))}
                className="w-full justify-between border border-border"
              />
              <QueryBar.FilterTrigger
                label="Region"
                value={search.region}
                onChange={(value) => setSearch({ region: value })}
                options={regions.map((value) => ({ value, label: value }))}
                className="w-full justify-between border border-border"
              />
              <QueryBar.FilterTrigger
                label="Access"
                value={search.eligibility}
                onChange={(value) => setSearch({ eligibility: value })}
                options={[
                  { value: "proxy-enabled", label: "Proxy enabled" },
                  { value: "pool-member", label: "Pool member" },
                  { value: "archive-capable", label: "Archive capable" },
                  { value: "unassigned", label: "Unassigned" },
                ]}
                className="w-full justify-between border border-border"
              />
              <QueryBar.FilterTrigger
                label="Sort"
                value={sortPreset}
                onChange={setSortPreset}
                options={[
                  { value: "netuid:asc", label: "Subnet number" },
                  { value: "health:asc", label: "Health first" },
                  { value: "latency:asc", label: "Fastest latency" },
                  { value: "latency:desc", label: "Slowest latency" },
                  { value: "probed:desc", label: "Newest probe" },
                  { value: "provider:asc", label: "Provider A–Z" },
                ]}
                className="w-full justify-between border border-border"
              />
            </FilterSheet>
            <button
              type="button"
              onClick={() =>
                setSearch({
                  callable: !search.callable,
                  ...(!search.callable && search.category === "other"
                    ? { category: "all" as const }
                    : {}),
                })
              }
              aria-pressed={search.callable}
              title={
                search.callable
                  ? `Showing callable endpoints — ${directoryCount} reference links hidden`
                  : "Showing all endpoint records"
              }
              className={classNames(
                "mg-focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 font-mono text-[10px] uppercase tracking-widest",
                search.callable ? "text-accent-text" : "text-ink-muted hover:text-ink-strong",
              )}
            >
              <span
                className={classNames(
                  "size-1.5 rounded-full",
                  search.callable ? "bg-accent" : "bg-ink-subtle",
                )}
                aria-hidden
              />
              <span className="hidden xl:inline">Callable</span>
            </button>
            <DownloadCsvButton url={endpointsCsvUrl} />
          </QueryBar.Utility>
        </QueryBar>
        <QueryBar.MetaRow
          count={sorted.length}
          total={scoped.length}
          noun="endpoints"
          activeCount={
            activeCount + (search.category !== "all" ? 1 : 0) + (search.callable ? 1 : 0)
          }
          onReset={resetAll}
          trailing={
            <span>
              {search.callable && directoryCount > 0
                ? `${directoryCount} reference links hidden`
                : "All records visible"}
            </span>
          }
        />
      </div>

      <FilterChipRow
        items={[
          ...(search.q ? [{ id: "q", label: "Search", value: search.q } as FilterChipItem] : []),
          ...(search.netuid
            ? [{ id: "netuid", label: "Netuid", value: search.netuid } as FilterChipItem]
            : []),
          ...(search.provider
            ? [{ id: "provider", label: "Provider", value: search.provider } as FilterChipItem]
            : []),
          ...(search.region
            ? [{ id: "region", label: "Region", value: search.region } as FilterChipItem]
            : []),
          ...(search.health
            ? [{ id: "health", label: "Health", value: search.health } as FilterChipItem]
            : []),
          ...(search.eligibility
            ? [
                {
                  id: "eligibility",
                  label: "Eligibility",
                  value: search.eligibility,
                } as FilterChipItem,
              ]
            : []),
          ...(search.callable
            ? [{ id: "callable", label: "Scope", value: "callable only" } as FilterChipItem]
            : []),
        ]}
        onRemove={(id) => {
          if (id === "callable") setSearch({ callable: false });
          else setSearch({ [id]: "" } as Partial<EndpointsSearch>);
        }}
        onClearAll={resetAll}
      />

      {stale ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[endpointsQuery().queryKey, endpointIncidentsQuery().queryKey]}
        />
      ) : null}

      {sorted.length === 0 ? (
        <StateBlock
          kind="registry"
          variant="empty"
          title="No endpoints match these filters"
          description="Remove one filter at a time, or reset to see the full list. Eligibility and category chips have the biggest effect on row count."
          actions={[
            { label: "Reset filters", onClick: resetAll, primary: true },
            { label: "Open API", href: "/api/v1/endpoints", external: true },
          ]}
          freshnessHint="Endpoint records refresh every probe cycle. Probe latency varies by region — re-check after a few minutes if a known endpoint is missing."
          evidenceHref="/metagraph/endpoints.json"
        />
      ) : (
        <>
          {compareIds.size > 0 ? (
            <EndpointComparePanel
              endpoints={rows.filter((r) => compareIds.has(r.id))}
              incidents={incidents}
              poolsById={poolsById}
              providerById={providerById}
              subnetById={subnetById}
              onRemove={toggleCompare}
              onClear={clearCompare}
            />
          ) : null}
          <EndpointOperationalList
            rows={pageRows}
            incidents={incidents}
            poolsById={poolsById}
            providerById={providerById}
            subnetById={subnetById}
            expandedId={expandedId}
            onToggle={toggleExpanded}
            compareIds={compareIds}
            onToggleCompare={toggleCompare}
            compareMax={4}
          />
          <PagerFooter
            summary={`Page ${safePage} of ${totalPages} · ${pageRows.length} shown · ${sorted.length} total`}
            hasPrev={safePage > 1}
            hasNext={safePage < totalPages}
            onPrev={() => setSearch({ page: Math.max(1, safePage - 1) })}
            onNext={() => setSearch({ page: Math.min(totalPages, safePage + 1) })}
          />
        </>
      )}
    </div>
  );
}
