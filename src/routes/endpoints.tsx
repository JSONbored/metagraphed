import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo } from "react";

import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Search, X } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { HealthPill } from "@/components/metagraphed/chips";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { RegistryEmpty } from "@/components/metagraphed/states/registry-empty";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { PageHero } from "@/components/metagraphed/page-hero";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { Radio, Server, ShieldCheck, Activity } from "lucide-react";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { LatencyHeatmap } from "@/components/metagraphed/charts/latency-heatmap";
import { IncidentsTimeline } from "@/components/metagraphed/analytics/incidents-timeline";
import {
  TimeRangeProvider,
  useTimeRange,
  RANGE_LABEL,
} from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EndpointKindTabs } from "@/components/metagraphed/endpoint-kind-tabs";
import { ViewModeToggle } from "@/components/metagraphed/view-mode-toggle";
import { ProxyHero, ProxyUsagePanel } from "@/components/metagraphed/rpc-proxy";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { useScrolled } from "@/hooks/use-scrolled";
import {
  endpointsQuery,
  rpcPoolsQuery,
  providersQuery,
  subnetsQuery,
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

import type { Endpoint, RpcPool, Provider, Subnet } from "@/lib/metagraphed/types";

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
  component: EndpointsPage,
});

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

  return (
    <AppShell>
      <PageHero
        eyebrow="Infrastructure"
        live
        title="Endpoints"
        description="A load-balanced reverse proxy for Bittensor RPC, plus the registry of callable Subtensor and subnet endpoints behind it."
      />
      <div className="space-y-section">
        {/* The headline feature: the live reverse proxy + its usage analytics. */}
        <section>
          <ProxyHero />
        </section>
        <section>
          <SectionHeading title="Proxy usage" />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>
              <ProxyUsagePanel />
            </Suspense>
          </QueryErrorBoundary>
        </section>

        <QueryErrorBoundary>
          <Suspense
            fallback={
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            }
          >
            <EndpointsStatStrip />
          </Suspense>
        </QueryErrorBoundary>

        <TimeRangeProvider>
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
              <SectionHeading title="Latency & severity heatmap" />
              <TimeRangeScrub />
            </div>
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <LatencyHeatmapSection />
              </Suspense>
            </QueryErrorBoundary>
          </section>
          <section>
            <SectionHeading title="RPC pools" />
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <PoolsTable />
              </Suspense>
            </QueryErrorBoundary>
          </section>
          <section>
            <SectionHeading title="Callable endpoints" />
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <EndpointsTable />
              </Suspense>
            </QueryErrorBoundary>
          </section>
          <section>
            <SectionHeading title="Incidents timeline" />
            <QueryErrorBoundary>
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <IncidentsTimeline />
              </Suspense>
            </QueryErrorBoundary>
          </section>
        </TimeRangeProvider>
      </div>
      <ApiSourceFooter
        paths={[
          "/rpc/v1/finney",
          "/api/v1/rpc/usage",
          "/api/v1/endpoints",
          "/api/v1/rpc/pools",
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
  const ok = rows.filter((e) => e.health === "ok").length;
  const okPct = total > 0 ? Math.round((ok / total) * 100) : null;
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
        hint={`${ok}/${total}`}
        tone={okPct != null && okPct > 90 ? "ok" : okPct != null && okPct < 70 ? "warn" : "default"}
      />
    </div>
  );
}

function LatencyHeatmapSection() {
  const rows = (useSuspenseQuery(endpointsQuery()).data.data ?? []) as Endpoint[];
  return <LatencyHeatmap endpoints={rows} />;
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
            ["metagraphed", "rpc-pools"],
            ["metagraphed", "endpoints"],
            ["metagraphed", "endpoint-incidents"],
          ]}
        />
      ) : null}
      <div className="rounded border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left">Pool</th>
              <th className="px-3 py-2 text-left">Region</th>
              <th className="px-3 py-2 text-right">Members</th>
              <th className="px-3 py-2">Archive</th>
              <th className="px-3 py-2">Eligibility</th>
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
                  <td className="px-3 py-2 text-[11px] text-ink-muted">
                    {p.archive_capable ? "yes" : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={classNames(
                        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest",
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
      </div>
      <p className="px-1 font-mono text-[10px] text-ink-muted">
        Proxy-eligible members serve live traffic through the reverse proxy above; the proxy prefers
        in-sync, healthy nodes and fails over automatically.
      </p>
    </div>
  );
}

type SortKey = "netuid" | "kind" | "provider" | "region" | "health" | "latency" | "probed";
type SortOrder = "asc" | "desc";

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
  const scrolled = useScrolled(8);
  const { data } = useSuspenseQuery(endpointsQuery());
  const { data: poolsRes } = useSuspenseQuery(rpcPoolsQuery());
  const rows = useMemo(() => (data.data ?? []) as Endpoint[], [data]);
  const pools = useMemo(() => (poolsRes.data ?? []) as RpcPool[], [poolsRes]);
  // O(1) pool lookup — index once, reuse for every endpoint's eligibility.
  const poolsById = useMemo(() => indexPoolsById(pools), [pools]);
  const generatedAt = data.meta?.generated_at as string | undefined;
  const { range } = useTimeRange();
  const windowLabel = `${RANGE_LABEL[range]} window · latest probe`;

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

  const hasFilters =
    search.q ||
    search.category !== "all" ||
    search.provider ||
    search.health ||
    search.netuid ||
    search.region ||
    search.eligibility;

  function toggleSort(k: SortKey) {
    if (search.sort === k) {
      setSearch({ order: search.order === "asc" ? "desc" : "asc" });
    } else {
      setSearch({ sort: k, order: "asc" });
    }
  }

  // Reset clears search/filters/sort/page but keeps page size, view, and the
  // callable-only default (true).
  const resetAll = () =>
    navigate({
      search: { pageSize: search.pageSize, view: search.view } as never,
      replace: true,
    });

  if (rows.length === 0)
    return (
      <RegistryEmpty
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
    <div className="space-y-3">
      {/* Kind chip rail */}
      <EndpointKindTabs
        value={search.category}
        counts={categoryCounts}
        onChange={(v) => setSearch({ category: v as EndpointsSearch["category"] })}
      />

      {/* Toolbar */}
      <div
        data-scrolled={scrolled ? "true" : "false"}
        className="mg-sticky-toolbar sticky top-14 z-20 -mx-1 px-1 py-2 backdrop-blur bg-paper/90 border-b border-border/60 flex flex-wrap items-center gap-2"
      >
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted" />
          <input
            value={search.q}
            onChange={(e) => setSearch({ q: e.target.value })}
            placeholder="Search URL, provider, netuid…"
            className="w-full rounded border border-border bg-card pl-7 pr-2 py-1.5 text-[12px] focus:outline-none focus:border-ink/30"
            aria-label="Search endpoints"
          />
        </div>
        <label className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
          <span className="font-mono uppercase tracking-widest text-[10px]">Netuid</span>
          <input
            value={search.netuid}
            onChange={(e) => setSearch({ netuid: e.target.value.replace(/[^0-9]/g, "") })}
            inputMode="numeric"
            placeholder="any"
            className="w-16 rounded border border-border bg-card px-1.5 py-1 text-[11px] focus:outline-none focus:border-ink/30"
            aria-label="Filter by netuid"
          />
        </label>
        <FilterSelect
          label="Provider"
          value={search.provider}
          onChange={(v) => setSearch({ provider: v })}
          options={providers}
        />
        <FilterSelect
          label="Region"
          value={search.region}
          onChange={(v) => setSearch({ region: v })}
          options={regions}
        />
        <FilterSelect
          label="Health"
          value={search.health}
          onChange={(v) => setSearch({ health: v })}
          options={["ok", "warn", "down", "unknown"]}
        />
        <FilterSelect
          label="Eligibility"
          value={search.eligibility}
          onChange={(v) => setSearch({ eligibility: v })}
          options={["proxy-enabled", "pool-member", "archive-capable", "unassigned"]}
        />
        <button
          type="button"
          onClick={resetAll}
          disabled={!hasFilters}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink-strong disabled:opacity-40 disabled:cursor-not-allowed"
          title="Clear search, filters, sort, and page"
        >
          <X className="size-3" /> Reset filters
        </button>
        <button
          type="button"
          onClick={() => {
            setSearch({
              callable: !search.callable,
              // Leaving callable-only while viewing the "other" tab would show 0
              // rows; snap back to "all" so the toggle is never a dead end.
              ...(!search.callable && search.category === "other"
                ? { category: "all" as const }
                : {}),
            });
          }}
          aria-pressed={search.callable}
          title={
            search.callable
              ? `Showing callable endpoints — ${directoryCount} directory links hidden`
              : "Showing all endpoints, including directory links"
          }
          className={classNames(
            "ml-auto inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
            search.callable
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border bg-card text-ink-muted hover:text-ink-strong",
          )}
        >
          <span className={classNames("size-1.5 rounded-full", search.callable && "bg-accent")} />
          Callable only
          {directoryCount > 0 ? (
            <span className="text-ink-muted">· {directoryCount} links</span>
          ) : null}
        </button>
        <ViewModeToggle
          value={search.view}
          options={["table", "grid"]}
          onChange={(v) => setSearch({ view: v as "table" | "grid" })}
        />
        <span className="font-mono text-[10px] text-ink-muted">
          {sorted.length} of {scoped.length}
        </span>
      </div>

      {sorted.length === 0 ? (
        <RegistryEmpty
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
          {search.view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pageRows.map((e) => {
                const provSlug = e.provider_slug;
                const prov = provSlug ? providerById.get(provSlug) : undefined;
                const sn = e.netuid != null ? subnetById.get(e.netuid) : undefined;
                return (
                  <div key={e.id} className="rounded border border-border bg-card p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                        {e.kind ?? "endpoint"}
                      </span>
                      <SparkLegend
                        metric="Endpoint health"
                        source="/api/v1/endpoints"
                        windowLabel={windowLabel}
                        updatedAt={e.last_probed_at}
                        staleness="Falls back to last known state when the probe hasn't completed."
                      >
                        <HealthPill state={e.health} />
                      </SparkLegend>
                    </div>
                    <div className="font-mono text-[11px] break-all">
                      {e.url ? (
                        <div className="flex items-start gap-1.5 min-w-0">
                          <ExternalLink href={e.url} className="break-all text-[11px]">
                            {e.url}
                          </ExternalLink>
                          <CopyButton value={e.url} label="URL" />
                        </div>
                      ) : (
                        "—"
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                      {e.netuid != null ? (
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: e.netuid }}
                          className="inline-flex items-center gap-1.5 font-mono hover:text-ink-strong"
                        >
                          <BrandIcon
                            url={sn?.website}
                            iconUrl={sn?.icon_url}
                            netuid={e.netuid}
                            name={sn?.name}
                            fallback={e.netuid}
                            size={14}
                          />
                          sn{String(e.netuid).padStart(3, "0")}
                        </Link>
                      ) : null}
                      {provSlug ? (
                        <Link
                          to="/providers/$slug"
                          params={{ slug: provSlug }}
                          className="inline-flex items-center gap-1.5 truncate max-w-[20ch] hover:underline"
                        >
                          <BrandIcon
                            url={prov?.website ?? prov?.homepage}
                            iconUrl={prov?.icon_url}
                            repoUrl={prov?.repo}
                            providerSlug={provSlug}
                            name={prov?.name ?? e.provider ?? provSlug}
                            fallback={provSlug}
                            size={14}
                          />
                          <span className="truncate">{e.provider ?? prov?.name ?? provSlug}</span>
                        </Link>
                      ) : e.provider ? (
                        <span className="truncate max-w-[18ch]">{e.provider}</span>
                      ) : null}
                      {e.region ? <span className="font-mono">{e.region}</span> : null}
                      {e.latency_ms != null ? (
                        <SparkLegend
                          metric="Latency"
                          source="/api/v1/endpoints (last probe)"
                          windowLabel={windowLabel}
                          updatedAt={e.last_probed_at}
                          staleness="No new measurement is taken between probes — last measured value is shown."
                        >
                          <span className="font-mono ml-auto">{e.latency_ms}ms</span>
                        </SparkLegend>
                      ) : null}
                    </div>
                    <SparkLegend
                      metric="Last probe"
                      source="/api/v1/endpoints"
                      windowLabel={windowLabel}
                      updatedAt={e.last_probed_at}
                      staleness="Rows older than the probe cycle are dimmed in tooltips elsewhere."
                    >
                      <span className="font-mono text-[10px] text-ink-muted">
                        probed <TimeAgo at={e.last_probed_at} />
                      </span>
                    </SparkLegend>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded border border-border bg-card overflow-x-clip">
              <table className="w-full text-sm">
                <thead className="sticky top-[6.75rem] z-10 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 text-[10px] font-mono uppercase tracking-widest text-ink-muted shadow-[0_1px_0_0_var(--border)]">
                  <tr>
                    <Th
                      label="Netuid"
                      k="netuid"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                    />
                    <Th
                      label="Kind"
                      k="kind"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                    />
                    <th className="px-3 py-2 text-left">URL</th>
                    <Th
                      label="Provider"
                      k="provider"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                    />
                    <Th
                      label="Region"
                      k="region"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                    />
                    <Th
                      label="Health"
                      k="health"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                      align="center"
                    />
                    <Th
                      label="Latency"
                      k="latency"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                      align="right"
                    />
                    <Th
                      label="Probed"
                      k="probed"
                      sortKey={search.sort}
                      sortOrder={search.order}
                      onSort={toggleSort}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageRows.map((e) => {
                    const provSlug = e.provider_slug;
                    const prov = provSlug ? providerById.get(provSlug) : undefined;
                    const sn = e.netuid != null ? subnetById.get(e.netuid) : undefined;
                    return (
                      <tr key={e.id} className="mg-row-accent hover:bg-surface/40">
                        <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                          {e.netuid != null ? (
                            <Link
                              to="/subnets/$netuid"
                              params={{ netuid: e.netuid }}
                              className="inline-flex items-center gap-1.5 hover:text-ink-strong"
                            >
                              <BrandIcon
                                url={sn?.website}
                                iconUrl={sn?.icon_url}
                                netuid={e.netuid}
                                name={sn?.name}
                                fallback={e.netuid}
                                size={14}
                              />
                              {String(e.netuid).padStart(3, "0")}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-[11px] max-w-[36ch]">
                          {e.url ? (
                            <div className="flex items-center gap-1.5 min-w-0">
                              <ExternalLink href={e.url} className="truncate text-[11px]">
                                {e.url}
                              </ExternalLink>
                              <CopyButton value={e.url} label="URL" />
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 text-[12px]">
                          {provSlug ? (
                            <Link
                              to="/providers/$slug"
                              params={{ slug: provSlug }}
                              className="inline-flex items-center gap-1.5 hover:underline min-w-0"
                            >
                              <BrandIcon
                                url={prov?.website ?? prov?.homepage}
                                iconUrl={prov?.icon_url}
                                repoUrl={prov?.repo}
                                providerSlug={provSlug}
                                name={prov?.name ?? e.provider ?? provSlug}
                                fallback={provSlug}
                                size={16}
                              />
                              <span className="truncate">
                                {e.provider ?? prov?.name ?? provSlug}
                              </span>
                            </Link>
                          ) : (
                            (e.provider ?? "—")
                          )}
                        </td>
                        <td className="px-3 py-2 text-[12px]">{e.region ?? "—"}</td>
                        <td className="px-3 py-2 text-center">
                          <SparkLegend
                            metric="Endpoint health"
                            source="/api/v1/endpoints"
                            windowLabel={windowLabel}
                            updatedAt={e.last_probed_at}
                            staleness="Falls back to last known state when the probe hasn't completed."
                          >
                            <HealthPill state={e.health} />
                          </SparkLegend>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px]">
                          {e.latency_ms != null ? (
                            <SparkLegend
                              metric="Latency"
                              source="/api/v1/endpoints (last probe)"
                              windowLabel={windowLabel}
                              updatedAt={e.last_probed_at}
                              staleness="No new measurement is taken between probes — last measured value is shown."
                            >
                              <span>{e.latency_ms}ms</span>
                            </SparkLegend>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                          <SparkLegend
                            metric="Last probe"
                            source="/api/v1/endpoints"
                            windowLabel={windowLabel}
                            updatedAt={e.last_probed_at}
                            staleness="Rows older than the probe cycle are dimmed in tooltips elsewhere."
                          >
                            <TimeAgo at={e.last_probed_at} />
                          </SparkLegend>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 px-1 py-1 text-[11px] text-ink-muted">
            <span className="font-mono">
              Page {safePage} of {totalPages} · showing {pageRows.length} of {sorted.length}
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <label htmlFor="ep-page-size" className="font-mono">
                Per page
              </label>
              <select
                id="ep-page-size"
                value={search.pageSize}
                onChange={(e) => setSearch({ pageSize: Number(e.target.value), page: 1 })}
                className="rounded border border-border bg-card px-1 py-0.5 text-[11px]"
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </span>
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setSearch({ page: Math.max(1, safePage - 1) })}
              className="rounded border border-border bg-card px-2 py-0.5 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setSearch({ page: Math.min(totalPages, safePage + 1) })}
              className="rounded border border-border bg-card px-2 py-0.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortOrder,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sortKey === k;
  const arrow = active ? (sortOrder === "asc" ? "▲" : "▼") : "";
  const alignCls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th className={classNames("px-3 py-2", alignCls)}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={classNames(
          "inline-flex items-center gap-1 uppercase tracking-widest hover:text-ink-strong",
          active ? "text-ink-strong" : "text-ink-muted",
        )}
      >
        {label}
        <span className="text-[8px]">{arrow}</span>
      </button>
    </th>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
      <span className="font-mono uppercase tracking-widest text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-ink/30"
      >
        <option value="">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
