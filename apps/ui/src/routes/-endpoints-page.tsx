import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useIsFetching } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner } from "@/components/metagraphed/states";
import { StateBlock } from "@/components/metagraphed/states/state-block";
import { DataTable, SectionHead, FactStrip, FactCell, RangeControl } from "@jsonbored/ui-kit";
import { AsyncPanel, PanelSkeleton, QueryProgress } from "@/components/metagraphed/primitives";
import {
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { EndpointsPriorityStrip } from "@/components/metagraphed/endpoints-priority-strip";
import { EndpointOperationalList } from "@/components/metagraphed/endpoint-operational-list";
import { EndpointComparePanel } from "@/components/metagraphed/endpoint-compare-panel";

import { IncidentsTimeline } from "@/components/metagraphed/analytics/incidents-timeline";
import { LatencyRanking } from "@/components/metagraphed/charts/latency-ranking";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import { ProxyHero, ProxyUsagePanel } from "@/components/metagraphed/rpc-proxy";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { rpcEndpointsSummaryLine } from "@/lib/metagraphed/rpc-endpoints-summary";

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
import { HubSections } from "@/components/metagraphed/hub-prose";
import { activeFilterCount } from "@/lib/metagraphed/filter-disclosure";
import type { EndpointsSearch } from "./apis.endpoints";

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

export function EndpointsPage() {
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
    <>
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
        <RangeControl
          options={ENDPOINTS_TABS.map((t) => ({ value: t.id, label: String(t.label) }))}
          value={tab}
          onChange={(v: EndpointsTab) => setTab(v)}
          label="Endpoints sections"
        />

        {tab === "proxy" && (
          <>
            <section>
              <ProxyHero />
            </section>
            <section>
              <SectionHead name="Proxy usage" />
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
              <SectionHead name="Endpoint directory" />
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
                  <SectionHead name="Latency diagnostics" />
                  <TimeRangeScrub />
                </div>
                <AsyncPanel
                  height="lg"
                  context="latency ranking"
                  retryQueryKeys={[metagraphedQueryKey("endpoints")]}
                >
                  <LatencyRankingSection />
                </AsyncPanel>
              </section>
            </TimeRangeProvider>
          </>
        )}

        {tab === "advanced" && (
          <>
            <section>
              <SectionHead name="RPC pools" />
              <AsyncPanel
                height="sm"
                context="RPC pools"
                retryQueryKeys={[metagraphedQueryKey("rpc-pools")]}
              >
                <PoolsTable />
              </AsyncPanel>
            </section>
            <section>
              <SectionHead name="Endpoint pools" />
              <AsyncPanel
                height="sm"
                context="endpoint pools"
                retryQueryKeys={[metagraphedQueryKey("endpoint-pools")]}
              >
                <EndpointPoolsTable />
              </AsyncPanel>
            </section>
            <section>
              <SectionHead name="Root RPC/WSS endpoints" />
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
              <SectionHead name="Incidents timeline" />
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
      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/endpoints" />
    </>
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
    <FactStrip variant="grid">
      <FactCell label="Endpoints" value={total} hint="tracked" />
      <FactCell
        label="RPC pools"
        value={pools.length}
        hint={proxy ? `${proxy} proxy` : undefined}
      />
      <FactCell label="Archive-capable" value={archive} />
      <FactCell
        label="Healthy"
        value={okPct != null ? `${okPct}%` : "—"}
        hint={`${ok}/${probed.length} probed`}
      />
    </FactStrip>
  );
}

function LatencyRankingSection() {
  const { data } = useSuspenseQuery(endpointsQuery());
  // The callable-endpoints table below is scoped to callable kinds (rpc/wss/api/
  // sse/data — i.e. not "other" directory links). Feed the ranking the same
  // callable-scoped population so both describe the same set of endpoints.
  const callable = useMemo(() => {
    const rows = (data.data ?? []) as Endpoint[];
    return rows.filter((e) => endpointCategory(e.kind) !== "other");
  }, [data]);
  return <LatencyRanking endpoints={callable} />;
}

function PoolsTable() {
  const { data } = useSuspenseQuery(rpcPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  const stale = isStaleFreshness(data.meta?.generated_at);
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
      <DataTable
        rows={rows}
        rowKey={(p) => p.id}
        caption="RPC pools"
        source="rpc-pools"
        empty={
          <EmptyState
            title="No RPC pools tracked"
            description="The proxy routes across registered pools — pool members and their eligibility appear here once registered."
            action={{ label: "Open API", href: "/api/v1/rpc/pools", external: true }}
          />
        }
        columns={[
          { key: "name", label: "Pool", sortable: true, value: (p) => p.name ?? p.id },
          { key: "region", label: "Region", sortable: true, value: (p) => p.region ?? null },
          {
            key: "members",
            label: "Members",
            kind: "number",
            sortable: true,
            value: (p) => p.members_count ?? null,
          },
          {
            key: "archive",
            label: "Archive",
            sortable: true,
            value: (p) => (p.archive_capable ? "yes" : null),
          },
          {
            key: "eligibility",
            label: "Eligibility",
            sortable: true,
            value: (p) => ELIGIBILITY_LABEL[poolEligibility(p)],
            render: (p) => {
              const eligibility = poolEligibility(p);
              return (
                <span
                  className={classNames(
                    "text-13 inline-flex items-center rounded border px-1.5 py-0.5",
                    ELIGIBILITY_TONE[eligibility],
                  )}
                >
                  {ELIGIBILITY_LABEL[eligibility]}
                </span>
              );
            },
          },
        ]}
      />
      <p className="px-1 text-10 text-ink-muted">
        Proxy-eligible members serve live traffic through the reverse proxy above; the proxy prefers
        in-sync, healthy nodes and fails over automatically.
      </p>
    </div>
  );
}

/** The pool's own access tier, from the two capability flags it carries. */
function poolEligibility(p: RpcPool): PoolEligibility {
  if (p.proxy_enabled) return "proxy-enabled";
  if (p.archive_capable) return "archive-capable";
  return "pool-member";
}

function EndpointPoolsTable() {
  const { data } = useSuspenseQuery(endpointPoolsQuery());
  const rows = (data.data ?? []) as RpcPool[];
  const stale = isStaleFreshness(data.meta?.generated_at);
  const endpointTotal = (p: RpcPool) =>
    typeof p.endpoint_count === "number"
      ? p.endpoint_count
      : typeof p.members_count === "number"
        ? p.members_count
        : null;
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
      <DataTable
        rows={rows}
        rowKey={(p) => p.id}
        caption="Endpoint pools"
        source="endpoint-pools"
        empty={
          <EmptyState
            title="No endpoint pools tracked"
            description="Generalized pool composition across subtensor-rpc, subtensor-wss, and archive kinds appears here once pools are scored."
            action={{ label: "Open API", href: "/api/v1/endpoint-pools", external: true }}
          />
        }
        columns={[
          { key: "id", label: "Pool", sortable: true, value: (p) => p.id },
          {
            key: "kind",
            label: "Kind",
            sortable: true,
            value: (p) => String(p.kind ?? "") || null,
          },
          {
            key: "endpoints",
            label: "Endpoints",
            kind: "number",
            sortable: true,
            value: (p) => endpointTotal(p),
            format: (_value, p) => {
              const total = endpointTotal(p);
              const eligible = typeof p.eligible_count === "number" ? p.eligible_count : null;
              if (eligible != null && total != null) return `${eligible}/${total} eligible`;
              return total != null ? String(total) : "—";
            },
          },
          {
            key: "best_endpoint_id",
            label: "Best endpoint",
            sortable: true,
            value: (p) =>
              typeof p.best_endpoint_id === "string" && p.best_endpoint_id.trim()
                ? p.best_endpoint_id
                : null,
          },
        ]}
      />
      <p className="px-1 text-10 text-ink-muted">
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
  return (
    <div className="space-y-2">
      {stale ? (
        <StaleBanner
          generatedAt={data.meta?.generated_at}
          refreshQueryKeys={[rpcEndpointsQuery().queryKey]}
        />
      ) : null}
      <DataTable
        rows={rows}
        rowKey={(e: RpcEndpoint) => e.id}
        caption="Root RPC/WSS endpoints"
        source="rpc-endpoints"
        empty={
          <EmptyState
            title="No RPC endpoints tracked"
            description="The base-layer Subtensor RPC/WSS registry appears here once endpoints are registered."
            action={{ label: "Open API", href: "/api/v1/rpc/endpoints", external: true }}
          />
        }
        columns={[
          {
            key: "provider",
            label: "Provider",
            sortable: true,
            value: (e: RpcEndpoint) => e.provider ?? null,
          },
          { key: "kind", label: "Kind", sortable: true, value: (e: RpcEndpoint) => e.kind ?? null },
          {
            key: "classification",
            label: "Classification",
            sortable: true,
            value: (e: RpcEndpoint) => e.classification ?? "unknown",
            render: (e: RpcEndpoint) => (
              <span
                className={classNames(
                  "text-13 inline-flex items-center rounded border px-1.5 py-0.5",
                  CLASSIFICATION_TONE[e.classification ?? "unknown"] ?? CLASSIFICATION_TONE.unknown,
                )}
              >
                {e.classification ?? "unknown"}
              </span>
            ),
          },
          {
            key: "status",
            label: "Status",
            kind: "status",
            sortable: true,
            value: (e: RpcEndpoint) => statusToHealth(e.status),
          },
          {
            key: "archive",
            label: "Archive",
            sortable: true,
            value: (e: RpcEndpoint) =>
              e.archive_support == null ? null : e.archive_support ? "yes" : "no",
          },
          {
            key: "latency",
            label: "Latency",
            kind: "number",
            sortable: true,
            value: (e: RpcEndpoint) => e.latency_ms ?? null,
            format: (v) => (typeof v === "number" ? `${formatNumber(v)}ms` : "—"),
          },
        ]}
      />
      {summaryLine ? <p className="px-1 text-10 text-ink-muted">{summaryLine}</p> : null}
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

  const search = useSearch({ from: "/apis/endpoints" }) as EndpointsSearch;
  const navigate = useNavigate({ from: "/apis/endpoints" });
  const expandedId = search.endpoint || null;
  const toggleExpanded = (id: string) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        endpoint: prev.endpoint === id ? "" : id,
      }),
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
      search: (prev: Record<string, unknown>) => ({ ...prev, compare: Array.from(next).join(",") }),
      resetScroll: false,
      replace: true,
    });
  };
  const clearCompare = () =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, compare: "" }),
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
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...patch,
        ...(resetsPage ? { page: 1 } : {}),
      }),
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

  const sortPreset = `${search.sort}:${search.order}`;
  const setSortPreset = (value: string) => {
    const [sort, order] = value.split(":") as [EndpointsSearch["sort"], EndpointsSearch["order"]];
    setSearch({ sort, order, page: 1 });
  };

  // Reset clears search/filters/sort/page but keeps page size, view, and the
  // callable-only default (true).
  const resetAll = () =>
    navigate({
      search: { pageSize: search.pageSize, view: search.view },
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
          { label: "Browse providers", to: "/apis/providers" },
        ]}
      />
    );

  return (
    <div className="space-y-3 relative">
      <QueryProgress active={isFetchingRows} position="sticky" />
      {/* One filter row over the whole directory: search, the six field
          filters, the callable-only scope toggle, and the result count. */}
      <div
        className="sticky z-[var(--mg-z-raised)] -mx-1 bg-paper px-1 py-2"
        style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search.q}
            onChange={(v) => setSearch({ q: v })}
            placeholder="Search URL, provider, netuid…"
          />
          <SelectFilter
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
          <SelectFilter
            label="Health"
            value={search.health}
            onChange={(v) => setSearch({ health: v })}
            options={["ok", "warn", "down", "unknown"].map((value) => ({ value, label: value }))}
          />
          <SelectFilter
            label="Sort"
            value={sortPreset}
            onChange={setSortPreset}
            allowEmpty={false}
            options={[
              { value: "netuid:asc", label: "Subnet number" },
              { value: "health:asc", label: "Health first" },
              { value: "latency:asc", label: "Fastest latency" },
              { value: "latency:desc", label: "Slowest latency" },
              { value: "probed:desc", label: "Newest probe" },
              { value: "provider:asc", label: "Provider A–Z" },
            ]}
          />
          <SelectFilter
            label="Provider"
            value={search.provider}
            onChange={(v) => setSearch({ provider: v })}
            options={providers.map((value) => ({ value, label: value }))}
          />
          <SelectFilter
            label="Region"
            value={search.region}
            onChange={(v) => setSearch({ region: v })}
            options={regions.map((value) => ({ value, label: value }))}
          />
          <SelectFilter
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
          <label className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-13">
            <span className="shrink-0 text-ink-muted">Subnet</span>
            <input
              value={search.netuid}
              onChange={(event) => setSearch({ netuid: event.target.value.replace(/[^0-9]/g, "") })}
              inputMode="numeric"
              placeholder="Any"
              className="w-20 min-w-0 rounded bg-transparent font-mono text-13 text-ink-strong placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
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
              "mg-focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 text-13",
              search.callable ? "text-accent-text" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            <span
              className={classNames(
                "size-1.5 rounded-full mg-dot",
                search.callable ? "bg-accent" : "bg-ink-subtle",
              )}
              aria-hidden
            />
            <span>Callable</span>
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-11 text-ink-muted">
          <span>
            {formatNumber(sorted.length)} of {formatNumber(scoped.length)} endpoints
          </span>
          <span>
            {search.callable && directoryCount > 0
              ? `${directoryCount} reference links hidden`
              : "All records visible"}
          </span>
          <ResetFiltersButton
            active={
              activeCount + (search.category !== "all" ? 1 : 0) + (search.callable ? 1 : 0) > 0
            }
            onReset={resetAll}
            bare
          />
        </div>
      </div>

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
          {/* The directory below is a card list, not a DataTable, so it
              carries its own pager rather than the table's. */}
          <div className="mg-dt-footer">
            <span className="mg-dt-range">
              Page {safePage} of {totalPages} · {pageRows.length} shown · {sorted.length} total
            </span>
            <nav className="mg-dt-pager" aria-label="Endpoint directory pages">
              <button
                type="button"
                onClick={() => setSearch({ page: Math.max(1, safePage - 1) })}
                disabled={safePage <= 1}
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setSearch({ page: Math.min(totalPages, safePage + 1) })}
                disabled={safePage >= totalPages}
              >
                Next
              </button>
            </nav>
          </div>
        </>
      )}
    </div>
  );
}
