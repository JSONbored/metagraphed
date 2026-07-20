import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo } from "react";
import { z } from "zod";
import { Network, Radio, Layers, Activity, Coins } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { SubnetsBubbleView } from "@/components/metagraphed/subnets-bubble-view";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import {
  BrandIcon,
  prefetchBrandIcon,
  TimeAgo,
  CurationChip,
  HealthPill,
  PageHero,
  DensityToggle,
  ViewModeToggle,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  ListShell,
  LoadMore,
  StatTile,
  SparkLegend,
  MiniStack,
  Sparkline,
  type Density,
  type ViewMode,
} from "@jsonbored/ui-kit";
import { useIsMobile } from "@/hooks/use-mobile";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import {
  ariaSort,
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { SubnetsSavedViews } from "@/components/metagraphed/subnets-saved-views";
import {
  SubnetsCompareDrawer,
  CompareToggle,
} from "@/components/metagraphed/subnets-compare-drawer";
import {
  subnetsInfiniteQuery,
  coverageQuery,
  healthQuery,
  subnetHealthMapQuery,
  agentCatalogMapQuery,
  economicsQuery,
  economicsTrendsQuery,
} from "@/lib/metagraphed/queries";
import {
  classNames,
  formatNumber,
  formatTao,
  isStaleFreshness,
  subnetAgeDays,
  formatSubnetAge,
} from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import {
  joinEconomics,
  joinHealth,
  matchesQuery,
  sortBy,
  tableSearchSchema,
} from "@/lib/metagraphed/url-state";
import { API_BASE } from "@/lib/metagraphed/config";
import type { AgentCatalogSummary, Subnet, SubnetEconomics } from "@/lib/metagraphed/types";

// #9: a list row enriched with its agent-catalog capability fields (flattened
// from the netuid-keyed catalog map so client-side sort/filter can read them).
type SubnetRow = Subnet & {
  health?: string;
  service_kinds?: string[];
  integration_readiness?: number;
  readiness_tier?: string;
  service_count?: number;
  // #3364: on-chain registration economics joined from /api/v1/economics by
  // netuid so the Registration column (and its sort) can read them off the row.
  registration_cost_tao?: number;
  registration_allowed?: boolean;
  // #3363: live emission share joined from /api/v1/economics by netuid, so the
  // Emission column (and its sort) can read it off the row.
  emission_share?: number;
};

function joinCatalog(
  rows: Array<Subnet & { health?: string }>,
  catalogMap: Record<number, AgentCatalogSummary | undefined>,
): SubnetRow[] {
  return rows.map((s) => {
    const c = catalogMap[s.netuid];
    if (!c) return s;
    return {
      ...s,
      service_kinds: c.service_kinds,
      integration_readiness: c.integration_readiness,
      readiness_tier: c.readiness_tier,
      service_count: c.service_count,
    };
  });
}

export const Route = createFileRoute("/subnets/")({
  validateSearch: tableSearchSchema,
  head: () => ({
    meta: [
      { title: "Subnets — Metagraphed" },
      {
        name: "description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
      { property: "og:title", content: "Subnets — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
    ],
  }),
  component: SubnetsPage,
});

type SubnetsSearch = z.infer<typeof tableSearchSchema>;

/** Server-backed params only — sort/curation/health filters are client-side. */
function subnetsQueryParams(search: SubnetsSearch): { q?: string; limit: number } {
  return {
    q: search.q || undefined,
    limit: search.limit,
  };
}

function SubnetsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filtersActive =
    !!search.q ||
    !!search.sort ||
    !!search.curation ||
    !!search.health ||
    !!search.serviceKind ||
    !!search.readiness ||
    !!search.kind ||
    !!search.stale ||
    !!search.cursor ||
    // #6270: defaults to true, so hiding the root is what makes it "active" —
    // without this the Reset button stays disabled while a filter is applied.
    !search.includeRoot;
  const onReset = () =>
    navigate({
      search: { limit: search.limit, view: search.view } as never,
      replace: true,
    });
  const setView = (v: ViewMode) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, view: v }) as never,
      replace: true,
    });
  const isMobile = useIsMobile();
  const effectiveDensity: Density =
    search.density === "compact" || search.density === "comfortable"
      ? search.density
      : isMobile
        ? "compact"
        : "comfortable";
  const setDensity = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }) as never,
      replace: true,
    });
  const subnetsCsvUrl = buildUrl("/api/v1/subnets", subnetsQueryParams(search));
  return (
    <AppShell>
      <PageHero
        eyebrow="Registry"
        live
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        actions={
          <>
            <ViewModeToggle
              value={search.view}
              onChange={setView}
              options={["table", "grid", "matrix", "bubble"]}
            />
            {search.view === "table" ? (
              <DensityToggle value={effectiveDensity} onChange={setDensity} />
            ) : null}
            <ActionBar>
              <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
              <DownloadCsvButton url={subnetsCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense
          fallback={
            <div className="flex flex-wrap gap-3 mb-6 [&>*]:grow [&>*]:basis-[160px]">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          }
        >
          <SubnetsStatStrip />
        </Suspense>
      </QueryErrorBoundary>
      <SubnetsSavedViews />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SubnetsTable view={search.view} density={effectiveDensity} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/subnets"]} artifacts={["/metagraph/subnets.json"]} />
      <SubnetsCompareDrawer />
    </AppShell>
  );
}

function SubnetsStatStrip() {
  const coverage = useSuspenseQuery(coverageQuery()).data.data ?? {};
  const health = useSuspenseQuery(healthQuery()).data.data ?? {};
  // #6271: the network-wide total-stake series already powers /explorer's
  // "Network economics trend" section (EconomicsTrendsSection's MiniSeries,
  // #3365) via the same GET /api/v1/economics/trends source (subnet_snapshots
  // rollup) -- reused here as a StatTile + Sparkline rather than a static
  // number, matching the issue's own "trend" framing and the existing
  // Alpha-price StatTile+Sparkline precedent in economics-panel.tsx. days[] is
  // newest-first (see explorer.tsx's own chrono = [...days].reverse()).
  const trends = useSuspenseQuery(economicsTrendsQuery()).data.data;
  const stakeSeries = [...trends.days].reverse().map((d) => d.total_stake_tao ?? 0);
  const latestTotalStake = trends.days[0]?.total_stake_tao ?? undefined;
  // Wired to the live /api/v1/coverage shape (same as CoverageFunnel): the older
  // netuids_active/netuids_total/adapter_backed fields are null on the live payload.
  const active =
    (coverage.netuids_active as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const total =
    (coverage.netuids_total as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const adapter =
    (coverage.curation_level_counts as Record<string, number> | undefined)?.["adapter-backed"] ??
    (coverage.adapter_backed as number | undefined);
  // "Manifested surfaces" = total surfaces declared in the registry. The legacy
  // `manifested_count` is hard-0 on the live payload (deprecated) and `??` won't
  // skip a real 0, so it silently zeroed the tile; `surface_count` is the live
  // total. (`curated_overlay_count` is a subnet count — wrong unit for surfaces.)
  const manifested =
    (coverage.surface_count as number | undefined) ??
    (coverage.manifested_count as number | undefined) ??
    (coverage.surfaces_total as number | undefined);
  const ok = health.ok;
  const totalH = health.total;
  const healthyOk = ok != null && totalH != null && totalH > 0 && ok / totalH > 0.9;
  return (
    // Flex-wrap (not grid) so a trailing partial row's tiles stretch to fill
    // the row instead of leaving an orphaned single tile — grid tracks are
    // shared across every row, but flex lines size independently. Same
    // pattern as economics-panel.tsx's own StatTile strip and the stat spine
    // in subnet-masthead.tsx/operational-panel.tsx.
    <div className="flex flex-wrap gap-3 mb-6 [&>*]:grow [&>*]:basis-[160px]">
      <StatTile
        icon={Network}
        eyebrow="Active subnets"
        value={formatNumber(active)}
        hint={total ? `of ${formatNumber(total)}` : undefined}
      />
      <StatTile
        icon={Radio}
        eyebrow="Adapter-backed"
        value={formatNumber(adapter)}
        hint="pilots"
        tone="accent"
      />
      <StatTile icon={Layers} eyebrow="Manifested surfaces" value={formatNumber(manifested)} />
      <StatTile
        icon={Activity}
        eyebrow="Healthy"
        value={ok != null && totalH ? `${formatNumber(ok)}/${formatNumber(totalH)}` : "—"}
        tone={healthyOk ? "ok" : "default"}
      />
      <StatTile
        icon={Coins}
        eyebrow="Total stake"
        value={formatTao(latestTotalStake)}
        hint="network-wide"
        tone="accent"
        chart={
          stakeSeries.length > 1 ? (
            <Sparkline
              values={stakeSeries}
              width={64}
              height={28}
              formatValue={formatTao}
              ariaLabel="Total stake trend"
            />
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Exclude-a-slice toggle for the /subnets list (#6270). Mirrors the /endpoints
 * "Callable only" toggle's shape and accent convention: the accent is lit only
 * while the toggle is NARROWING the list, so the default (everything included)
 * stays visually quiet. `hidden` is the pressed state — the slice is excluded.
 */
function ExcludeToggle({
  hidden,
  onToggle,
  label,
  count,
  title,
}: {
  hidden: boolean;
  onToggle: () => void;
  label: string;
  count: number;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      title={title}
      className={classNames(
        "inline-flex min-h-9 items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
        hidden
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border bg-card text-ink-muted hover:text-ink-strong",
      )}
    >
      <span className={classNames("size-1.5 rounded-full", hidden && "bg-accent")} />
      {label}
      {count > 0 ? <span className="text-ink-muted">· {count}</span> : null}
    </button>
  );
}

function SubnetsTable({ view, density = "comfortable" }: { view: ViewMode; density?: Density }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // /api/v1/subnets supports only q + cursor/limit. `sort` returns HTTP 400, and
  // `curation`/`health` are ignored server-side — so those are applied
  // client-side (filtered/sorted over the fetched pages) and must NOT be sent.
  const baseParams = subnetsQueryParams(search);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error,
    isFetching,
  } = useSuspenseInfiniteQuery(subnetsInfiniteQuery(baseParams, search.cursor));

  // Per-subnet probe health (the list rows don't carry it; join it from
  // /api/v1/health so the Health + Updated columns and the health filter work).
  // Key the `?? {}` fallback off the raw query value so `healthMap` keeps a
  // stable reference across renders — otherwise a fresh `{}` each render would
  // defeat the `all` memo below.
  const healthMapRaw = useSuspenseQuery(subnetHealthMapQuery()).data.data;
  const healthMap = useMemo(() => healthMapRaw ?? {}, [healthMapRaw]);

  // #9: per-subnet agent-catalog capability (service kinds + integration
  // readiness). Joined the same way as health so the capability filter and the
  // Readiness column resolve. Best-effort: subnets with no catalog entry pass
  // through with no capability data (and are simply excluded by the filters).
  const catalogMapRaw = useSuspenseQuery(agentCatalogMapQuery()).data.data;
  const catalogMap = useMemo(() => catalogMapRaw ?? {}, [catalogMapRaw]);

  // #3364/#3363: per-subnet on-chain economics — already fetched once per
  // session for the detail EconomicsPanel, so this reuses that shared cache
  // (no new endpoint, no backend change). Indexed by netuid into a map and
  // joined the same way as health/catalog so the Registration + Emission
  // columns (and their sort) resolve off the row. A missing/failed fetch
  // degrades to an empty map (every cell falls back to "—") rather than
  // breaking the table, mirroring healthMap/catalogMap's fallback.
  const economicsRaw = useSuspenseQuery(economicsQuery()).data.data;
  const economicsMap = useMemo(() => {
    const map: Record<number, SubnetEconomics> = {};
    for (const e of economicsRaw ?? []) map[e.netuid] = e;
    return map;
  }, [economicsRaw]);

  const pages = data.pages as Array<(typeof data.pages)[number] & { cursorInvalid?: boolean }>;
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!lastPage?.cursorInvalid;
  // Join the fetched pages with per-subnet probe health + agent-catalog
  // capability + economics. Memoized on its real inputs so a keystroke/hover
  // that only re-renders the route doesn't re-flatten and re-clone every row.
  const all = useMemo(
    () =>
      joinEconomics(
        joinCatalog(
          joinHealth(
            pages.flatMap((p) => (p.data ?? []) as Subnet[]),
            healthMap,
          ),
          catalogMap,
        ),
        economicsMap,
      ),
    [pages, healthMap, catalogMap, economicsMap],
  );

  // #6270: how many rows each inclusion toggle would drop, surfaced on the
  // toggle itself so it answers "what am I hiding?" before you press it — the
  // same affordance /endpoints' callable toggle gives with directoryCount.
  // Counted over the full joined set, independent of the other filters.
  const rootCount = useMemo(
    () => all.filter((s) => s.subnet_type === "root" || s.netuid === 0).length,
    [all],
  );
  const total = pages[0]?.meta?.pagination?.total ?? pages[0]?.meta?.total;

  // Treat the URL cursor as the immutable starting point for this infinite query.
  // Updating it after fetching more pages changes the query key and drops already
  // accumulated pages.

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const onSort = (field: string) =>
    navigate({
      search: (prev: { sort?: string; order?: "asc" | "desc" }) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "asc" ? "desc" : "asc",
          cursor: "",
        }) as never,
    });

  const filtersActive = !!(
    search.q ||
    search.curation ||
    search.health ||
    search.serviceKind ||
    search.readiness ||
    search.kind ||
    search.stale ||
    search.sort ||
    // #6270: defaults to true (include everything), so it only counts as an
    // active filter once the user has switched it OFF.
    !search.includeRoot
  );

  // Client-side filter + sort (the list API only honors q + cursor/limit).
  // Both are memoized on the joined rows and the exact search params they read,
  // so they only recompute when one of those actually changes — not on every
  // keystroke-driven re-render.
  const filtered = useMemo(
    () =>
      all.filter((s) => {
        if (!matchesQuery([s.netuid, s.name, s.symbol], search.q)) return false;
        if (search.curation && s.curation_level !== search.curation) return false;
        if (search.health && s.health !== search.health) return false;
        // Capability: subnet must expose the selected service kind. Rows with no
        // catalog entry (no service_kinds) are excluded when this filter is set.
        if (search.serviceKind && !(s.service_kinds ?? []).includes(search.serviceKind))
          return false;
        if (search.readiness && s.readiness_tier !== search.readiness) return false;
        // Mega-menu "Has APIs/docs/SSE" links (nav-mega-menu-data.ts). "api"/"sse"
        // are agent-catalog service_kinds; "docs" has no service_kinds entry (a
        // docs page isn't a callable service) so it checks the row's own
        // docs_url instead — this is the one case service_kinds can't answer.
        if (search.kind === "api" && !(s.service_kinds ?? []).includes("subnet-api")) return false;
        if (search.kind === "sse" && !(s.service_kinds ?? []).includes("sse")) return false;
        if (search.kind === "docs" && !s.docs_url) return false;
        // Mega-menu "Stale > 24h" link: same threshold as the label, using the
        // same isStaleFreshness convention as the rest of the app. The list API
        // doesn't emit a `freshness` field on these rows — `updated_at` is what's
        // actually populated (confirmed against the live response).
        if (search.stale && !isStaleFreshness(s.updated_at, 24 * 60 * 60_000)) return false;
        // #6270: root inclusion. Defaults to true, so the unfiltered list is
        // unchanged; switching it off drops the root netuid. Identified by the
        // wire `subnet_type` (netuid 0 is the root subnet by definition, so
        // it's accepted either way).
        if (!search.includeRoot && (s.subnet_type === "root" || s.netuid === 0)) return false;
        return true;
      }),
    [
      all,
      search.q,
      search.curation,
      search.health,
      search.serviceKind,
      search.readiness,
      search.kind,
      search.stale,
      search.includeRoot,
    ],
  );
  const rows = useMemo(
    () =>
      sortBy(
        filtered,
        search.sort,
        search.order,
        (row, key) => (row as Record<string, unknown>)[key],
      ),
    [filtered, search.sort, search.order],
  );

  // Warm the favicon cache for visible rows during idle time so scrolling
  // feels instant. The browser dedupes the eventual <img> request. `rows` is
  // memoized above, so this effect only re-runs when the visible row set
  // actually changes — not on every keystroke/hover-driven re-render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const handle = ric(() => {
      for (const s of rows)
        prefetchBrandIcon(s.website, 32, {
          iconUrl: s.icon_url,
          repoUrl: s.repo,
          lookup: { netuid: s.netuid },
        });
    });
    return () => {
      const cic =
        (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback ??
        window.clearTimeout;
      cic(handle as number);
    };
  }, [rows]);

  const filters = (
    <>
      <SearchInput
        value={search.q}
        onChange={(v) => setSearch({ q: v })}
        placeholder="Search by netuid, name, or symbol"
      />
      <SelectFilter
        label="curation"
        value={search.curation}
        onChange={(v) => setSearch({ curation: v })}
        options={[
          { value: "native", label: "native" },
          { value: "candidate-discovered", label: "candidate" },
          { value: "machine-verified", label: "machine" },
          { value: "maintainer-reviewed", label: "reviewed" },
          { value: "adapter-backed", label: "adapter" },
        ]}
      />
      <SelectFilter
        label="health"
        value={search.health}
        onChange={(v) => setSearch({ health: v })}
        options={[
          { value: "ok", label: "ok" },
          { value: "warn", label: "warn" },
          { value: "down", label: "down" },
          { value: "unknown", label: "unknown" },
        ]}
      />
      <SelectFilter
        label="service"
        value={search.serviceKind}
        onChange={(v) => setSearch({ serviceKind: v })}
        options={[
          { value: "subnet-api", label: "subnet-api" },
          { value: "openapi", label: "openapi" },
          { value: "sse", label: "sse" },
          { value: "data-artifact", label: "data-artifact" },
        ]}
      />
      <SelectFilter
        label="readiness"
        value={search.readiness}
        onChange={(v) => setSearch({ readiness: v })}
        options={[
          { value: "buildable", label: "buildable" },
          { value: "emerging", label: "emerging" },
          { value: "identity-only", label: "identity-only" },
          { value: "dormant", label: "dormant" },
        ]}
      />
      <ExcludeToggle
        hidden={!search.includeRoot}
        onToggle={() => setSearch({ includeRoot: !search.includeRoot })}
        label="Hide root"
        count={rootCount}
        title={
          search.includeRoot
            ? `Showing the root subnet — click to hide ${rootCount} root netuid${rootCount === 1 ? "" : "s"}`
            : "Root subnet hidden — click to show it again"
        }
      />
      <PageSizeSelect value={search.limit} onChange={(n) => setSearch({ limit: n })} />
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No subnets match these filters"
      description={
        filtersActive
          ? "Try clearing one or more filters, or broaden the search."
          : "The registry returned no subnets — the source artifact may be temporarily unavailable."
      }
      action={
        filtersActive
          ? { label: "Reset filters", href: "/subnets" }
          : {
              label: "Open /api/v1/subnets",
              href: `${API_BASE}/api/v1/subnets`,
              external: true,
            }
      }
    />
  );

  const footerNode = (
    <LoadMore
      shown={rows.length}
      total={total}
      hasMore={!!hasNextPage}
      isLoading={isFetchingNextPage}
      onLoadMore={() => fetchNextPage()}
      error={isFetchNextPageError ? (error as Error) : null}
      cursorInvalid={cursorInvalid}
    />
  );

  // #6884: bubble view — an alternate scatter over the same filtered rows.
  if (view === "bubble") {
    return (
      <div>
        <div className="sticky top-14 z-20 -mx-4 md:mx-0 mb-3 bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 border-b border-border md:border md:rounded md:bg-card px-3 py-2 md:p-2.5">
          <div className="flex flex-wrap items-center gap-2">{filters}</div>
        </div>
        {rows.length === 0 && !hasNextPage ? emptyNode : <SubnetsBubbleView rows={rows} />}
        <div className="mt-3">{footerNode}</div>
      </div>
    );
  }

  // Grid / matrix views skip ListShell so they're not boxed in a table card.
  if (view === "grid" || view === "matrix") {
    return (
      <div>
        <div className="sticky top-14 z-20 -mx-4 md:mx-0 mb-3 bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 border-b border-border md:border md:rounded md:bg-card px-3 py-2 md:p-2.5">
          <div className="flex flex-wrap items-center gap-2">{filters}</div>
        </div>
        {rows.length === 0 && !hasNextPage ? (
          emptyNode
        ) : view === "grid" ? (
          <SubnetGrid rows={rows} />
        ) : (
          <SubnetMatrix rows={rows} />
        )}
        <div className="mt-3">{footerNode}</div>
      </div>
    );
  }

  return (
    <div id="subnets-list">
      <ListShell
        filters={filters}
        isEmpty={rows.length === 0 && !hasNextPage}
        isStale={isFetching && !isFetchingNextPage}
        empty={emptyNode}
        cards={rows.map((s) => (
          <Link
            key={s.netuid}
            to="/subnets/$netuid"
            params={{ netuid: s.netuid }}
            className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 min-w-0">
                <BrandIcon
                  url={s.website}
                  repoUrl={s.repo}
                  iconUrl={s.icon_url}
                  netuid={s.netuid}
                  name={s.name}
                  fallback={s.netuid}
                  size={32}
                />
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-ink-muted">
                    #{String(s.netuid).padStart(3, "0")}
                    {s.symbol ? ` · ${s.symbol}` : ""}
                    {" · "}
                    {formatSubnetAge(subnetAgeDays(s.registered_at_block, s.block))}
                  </div>
                  <div className="font-medium text-ink-strong truncate">
                    {s.name ?? `Subnet ${s.netuid}`}
                  </div>
                </div>
              </div>
              <HealthPill state={s.health} />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-muted">
              <span>{formatNumber(s.participants)} participants</span>
              <span>{s.surfaces_count ?? 0} surfaces</span>
              <span>
                <TimeAgo at={s.updated_at ?? s.freshness} />
              </span>
            </div>
            <div className="mt-1.5">
              <CurationChip level={s.curation_level} />
            </div>
          </Link>
        ))}
        table={(() => {
          const compact = density === "compact";
          const cellPad = compact ? "px-3 py-1.5" : "px-4 py-2.5";
          const firstPad = compact ? "pl-3 pr-1 py-1.5" : "pl-4 pr-1 py-2.5";
          const monoSize = compact ? "text-[11px]" : "text-[12px]";
          return (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className={classNames(firstPad, "w-6")} aria-label="Compare" />
                  <th
                    className={cellPad}
                    aria-sort={ariaSort(search.sort === "netuid", search.order)}
                  >
                    <SortHeader
                      label="UID"
                      field="netuid"
                      active={search.sort === "netuid"}
                      order={search.order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={cellPad}
                    aria-sort={ariaSort(search.sort === "name", search.order)}
                  >
                    <SortHeader
                      label="Name"
                      field="name"
                      active={search.sort === "name"}
                      order={search.order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={cellPad}
                    aria-sort={ariaSort(search.sort === "symbol", search.order)}
                  >
                    <SortHeader
                      label="Symbol"
                      field="symbol"
                      active={search.sort === "symbol"}
                      order={search.order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "participants", search.order)}
                  >
                    <SortHeader
                      label="Participants"
                      field="participants"
                      active={search.sort === "participants"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={cellPad}
                    aria-sort={ariaSort(search.sort === "curation_level", search.order)}
                  >
                    <SortHeader
                      label="Curation"
                      field="curation_level"
                      active={search.sort === "curation_level"}
                      order={search.order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "surfaces_count", search.order)}
                  >
                    <SortHeader
                      label="Surfaces"
                      field="surfaces_count"
                      active={search.sort === "surfaces_count"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "integration_readiness", search.order)}
                  >
                    <SortHeader
                      label="Readiness"
                      field="integration_readiness"
                      active={search.sort === "integration_readiness"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "registration_cost_tao", search.order)}
                  >
                    <SortHeader
                      label="Registration"
                      field="registration_cost_tao"
                      active={search.sort === "registration_cost_tao"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th className={cellPad}>Health</th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "emission_share", search.order)}
                  >
                    <SortHeader
                      label="Emission"
                      field="emission_share"
                      active={search.sort === "emission_share"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(search.sort === "updated_at", search.order)}
                  >
                    <SortHeader
                      label="Updated"
                      field="updated_at"
                      active={search.sort === "updated_at"}
                      order={search.order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((s) => (
                  <tr key={s.netuid} className="mg-row-accent hover:bg-surface/40">
                    <td className={classNames(firstPad, "align-middle")}>
                      <CompareToggle netuid={s.netuid} />
                    </td>
                    <td className={classNames(cellPad, "font-mono text-ink-muted", monoSize)}>
                      <EntityHoverCard kind="subnet" netuid={s.netuid}>
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: s.netuid }}
                          className="hover:text-ink-strong"
                        >
                          {String(s.netuid).padStart(3, "0")}
                        </Link>
                      </EntityHoverCard>
                      {/* #6643: age-in-days, estimated from the already-fetched
                        registered_at_block/block delta -- no new backend call. */}
                      <div className="text-[10px] font-sans text-ink-muted/70 whitespace-nowrap">
                        {formatSubnetAge(subnetAgeDays(s.registered_at_block, s.block))}
                      </div>
                    </td>
                    <td className={cellPad}>
                      <EntityHoverCard kind="subnet" netuid={s.netuid}>
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: s.netuid }}
                          className="inline-flex items-center gap-2 font-medium text-ink-strong hover:underline"
                        >
                          <BrandIcon
                            url={s.website}
                            repoUrl={s.repo}
                            iconUrl={s.icon_url}
                            netuid={s.netuid}
                            name={s.name}
                            fallback={s.netuid}
                            size={compact ? 18 : 20}
                          />
                          <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
                        </Link>
                      </EntityHoverCard>
                    </td>
                    <td className={classNames(cellPad, "font-mono text-[11px] text-ink-muted")}>
                      {s.symbol ?? "—"}
                    </td>
                    <td className={classNames(cellPad, "text-right")}>
                      <ParticipantsCell
                        value={s.participants}
                        density={density}
                        updatedAt={s.updated_at ?? s.freshness}
                      />
                    </td>
                    <td className={cellPad}>
                      <CurationChip level={s.curation_level} />
                    </td>
                    <td className={classNames(cellPad, "text-right")}>
                      <SurfacesCell subnet={s} density={density} />
                    </td>
                    <td className={classNames(cellPad, "text-right")}>
                      <ReadinessCell
                        score={s.integration_readiness}
                        tier={s.readiness_tier}
                        kinds={s.service_kinds}
                      />
                    </td>
                    <td
                      className={classNames(
                        cellPad,
                        "text-right font-mono text-[11px] tabular-nums",
                        // #3364: dim the cost only when registration is explicitly
                        // closed. `registration_allowed === undefined` (economics
                        // entry present but flag absent, or no entry at all) keeps
                        // the neutral tone — do NOT read it as "open".
                        s.registration_allowed === false ? "text-ink-muted" : "text-ink",
                      )}
                      title={
                        s.registration_allowed === false
                          ? "Registration currently closed"
                          : s.registration_allowed === true
                            ? "Registration open"
                            : undefined
                      }
                    >
                      {formatTao(s.registration_cost_tao)}
                    </td>
                    <td className={cellPad}>
                      <HealthPill state={s.health} />
                    </td>
                    <td
                      className={classNames(
                        cellPad,
                        "text-right font-mono text-[11px] tabular-nums",
                      )}
                    >
                      <EmissionCell share={s.emission_share} />
                    </td>
                    <td
                      className={classNames(
                        cellPad,
                        "text-right font-mono text-[11px] text-ink-muted",
                      )}
                    >
                      <TimeAgo at={s.updated_at ?? s.freshness} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
        footer={footerNode}
      />
    </div>
  );
}

/* ---------- Grid view ---------- */

function SubnetGrid({ rows }: { rows: Subnet[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((s) => (
        <Link
          key={s.netuid}
          to="/subnets/$netuid"
          params={{ netuid: s.netuid }}
          className="group relative flex flex-col gap-3 rounded border border-border bg-card p-4 mg-hover-lift mg-fade-in"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <BrandIcon
                url={s.website}
                iconUrl={s.icon_url}
                netuid={s.netuid}
                name={s.name}
                fallback={s.netuid}
                size={36}
              />
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  #{String(s.netuid).padStart(3, "0")}
                  {s.symbol ? ` · ${s.symbol}` : ""}
                </div>
                <div className="font-display font-semibold text-ink-strong truncate">
                  {s.name ?? `Subnet ${s.netuid}`}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <CompareToggle netuid={s.netuid} />
              <HealthPill state={s.health} />
            </div>
          </div>

          {(s as { description?: string }).description ? (
            <p className="text-[12px] text-ink-muted leading-relaxed line-clamp-2">
              {(s as { description?: string }).description}
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-border/70">
            <CurationChip level={s.curation_level} />
            <div className="flex items-center gap-3 font-mono text-[10px] text-ink-muted">
              <span title="Participants">{formatNumber(s.participants)}</span>
              <span title="Surfaces">{s.surfaces_count ?? 0} surf</span>
              <TimeAgo at={s.updated_at ?? s.freshness} />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/* ---------- Matrix view ---------- */

const HEALTH_BG: Record<string, string> = {
  ok: "bg-health-ok/90 hover:bg-health-ok",
  warn: "bg-health-warn/80 hover:bg-health-warn",
  // Solid, not /85 like the others (#6407): at /85 no text color clears
  // 4.5:1 against this fill for every health palette (verified against all
  // 3 HEALTH_PALETTES x both themes) -- the small margin needed pushed this
  // one fill to fully opaque. .mg-pulse-cell:hover already provides a scale
  // + outline hover cue independent of fill opacity, so this loses only the
  // (redundant) opacity-based hover tint the other 3 states still get.
  down: "bg-health-down hover:bg-health-down",
  unknown: "bg-health-unknown/40 hover:bg-health-unknown/70",
};

// Netuid-label contrast per health state (#6407): text-white/95 cleared
// 4.5:1 for none of the 4 fills above, across any of the 3 HEALTH_PALETTES.
// ok/warn need fixed dark text in both themes (their fills stay mid-to-high
// lightness in dark mode too); down mirrors subnet-health-matrix.tsx's
// TONE_TEXT (text-paper, which conveniently flips the same direction the
// fill's own effective lightness does between themes); unknown keeps
// text-ink-strong, since its low opacity lets the fill track the
// surrounding card's lightness. Verified 4.5:1+ for every
// state x palette x theme combination.
const HEALTH_TEXT: Record<string, string> = {
  ok: "text-black/95",
  warn: "text-black/95",
  down: "text-paper/95",
  unknown: "text-ink-strong/95",
};

function SubnetMatrix({ rows }: { rows: Subnet[] }) {
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Health matrix · {rows.length} subnets
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-ink-muted">
          <Legend color="bg-health-ok" label="ok" />
          <Legend color="bg-health-warn" label="warn" />
          <Legend color="bg-health-down" label="down" />
          <Legend color="bg-health-unknown" label="unknown" />
        </div>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(2.25rem, 1fr))" }}
      >
        {rows.map((s) => (
          <EntityHoverCard key={s.netuid} kind="subnet" netuid={s.netuid}>
            <Link
              to="/subnets/$netuid"
              params={{ netuid: s.netuid }}
              aria-label={`Subnet ${s.netuid}${s.name ? ` — ${s.name}` : ""}`}
              title={`#${s.netuid}${s.name ? ` · ${s.name}` : ""} · ${s.health ?? "unknown"}`}
              className={classNames(
                "mg-pulse-cell flex aspect-square items-center justify-center rounded-sm font-mono text-[10px] font-medium transition-transform",
                HEALTH_BG[s.health ?? "unknown"] ?? HEALTH_BG.unknown,
                HEALTH_TEXT[s.health ?? "unknown"] ?? HEALTH_TEXT.unknown,
              )}
            >
              {s.netuid}
            </Link>
          </EntityHoverCard>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={classNames("size-2 rounded-sm", color)} />
      {label}
    </span>
  );
}

/* ---------- Row visualization cells ---------- */

const SURFACE_KIND_COLORS: Record<string, string> = {
  api: "var(--accent)",
  openapi: "var(--accent)",
  docs: "var(--health-ok)",
  repo: "var(--ink-strong)",
  dashboard: "var(--health-warn)",
  data: "var(--ink-muted)",
  sdk: "var(--accent)",
  example: "var(--health-ok)",
  sse: "var(--health-warn)",
  rpc: "var(--ink-strong)",
};

function ParticipantsCell({
  value,
  density = "comfortable",
  updatedAt,
}: {
  value?: number;
  density?: Density;
  updatedAt?: string | null;
}) {
  const n = typeof value === "number" ? value : 0;
  const pct = Math.max(0, Math.min(1, n / 256));
  const compact = density === "compact";
  return (
    <SparkLegend
      metric="Participant density"
      source="Live participant count from the on-chain metagraph, scaled against the 256-slot subnet cap."
      windowLabel="live"
      updatedAt={updatedAt ?? null}
      staleness="Reflects the most recent block snapshot; bar disappears when the count is zero or unknown."
      side="left"
    >
      <span className="inline-flex flex-col items-end gap-0.5 min-w-[64px]">
        <span
          className={classNames(
            "font-mono tabular-nums text-ink",
            compact ? "text-[11px]" : "text-[12px]",
          )}
        >
          {formatNumber(value)}
        </span>
        <span
          className={classNames(
            "overflow-hidden rounded-full bg-border/50 w-14",
            compact ? "h-0.5" : "h-1",
          )}
          aria-hidden
        >
          <span className="block h-full bg-accent/70" style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
    </SparkLegend>
  );
}

// #9: integration-readiness score + tier badge, fed by the agent-catalog join.
// Tier drives the colour; the score is the 0–100 integration_readiness. Subnets
// with no catalog entry render a muted dash.
const READINESS_TIER_TONE: Record<string, string> = {
  buildable: "text-health-ok border-health-ok/40",
  emerging: "text-accent-text border-accent/40",
  "identity-only": "text-health-warn border-health-warn/40",
  dormant: "text-ink-muted border-border",
};

function ReadinessCell({
  score,
  tier,
  kinds,
}: {
  score?: number;
  tier?: string;
  kinds?: string[];
}) {
  if (score == null && !tier) {
    return <span className="font-mono text-[11px] text-ink-muted">—</span>;
  }
  const tone = READINESS_TIER_TONE[tier ?? ""] ?? "text-ink-muted border-border";
  return (
    <span
      className="inline-flex flex-col items-end gap-0.5"
      title={kinds && kinds.length ? `Services: ${kinds.join(", ")}` : undefined}
    >
      <span className="font-mono text-[12px] tabular-nums text-ink-strong">
        {score != null ? score : "—"}
      </span>
      {tier ? (
        <span
          className={classNames(
            "inline-flex items-center rounded border px-1 py-0.5 font-mono text-[8px] uppercase tracking-widest",
            tone,
          )}
        >
          {tier}
        </span>
      ) : null}
    </span>
  );
}

// #3363: live emission share as a percentage, matching EconomicsPanel's
// per-subnet StatTile formatting exactly (economics-panel.tsx) for visual
// consistency between the profile tile and this table column.
function EmissionCell({ share }: { share?: number }) {
  return (
    <span className="tabular-nums">{share != null ? `${(share * 100).toFixed(3)}%` : "—"}</span>
  );
}

function SurfacesCell({ subnet, density = "comfortable" }: { subnet: Subnet; density?: Density }) {
  const count = subnet.surfaces_count ?? 0;
  const rec = subnet as unknown as Record<string, unknown>;
  const num = (k: string) => (typeof rec[k] === "number" ? (rec[k] as number) : 0);
  const byKind = (rec.surfaces_by_kind ?? rec.surface_kinds) as Record<string, number> | undefined;
  // Prefer a real per-kind breakdown if the list API ever exposes one; otherwise
  // show the surface-trust composition (official / registry-observed / other) —
  // the list API always carries these counts, so the bar is a meaningful
  // breakdown instead of a flat single-segment placeholder.
  const TRUST_COLORS: Record<string, string> = {
    official: "var(--accent)",
    observed: "var(--ink-muted)",
    other: "var(--border)",
  };
  const official = num("official_surface_count");
  const observed = num("registry_observed_count");
  const trust = [
    { label: "official", value: official },
    { label: "observed", value: observed },
    { label: "other", value: Math.max(0, count - official - observed) },
  ];
  const segments = (
    byKind
      ? Object.entries(byKind).map(([k, v]) => ({
          label: k,
          value: typeof v === "number" ? v : 0,
          color: SURFACE_KIND_COLORS[k.toLowerCase()] ?? "var(--ink-muted)",
        }))
      : trust.map((t) => ({ ...t, color: TRUST_COLORS[t.label] }))
  ).filter((s) => s.value > 0);
  const compact = density === "compact";
  const summary = (
    byKind ? Object.entries(byKind) : (trust.map((t) => [t.label, t.value]) as [string, number][])
  )
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

  return (
    <SparkLegend
      metric={byKind ? "Surface kinds" : "Surface trust"}
      source={`Verified public surfaces for SN${subnet.netuid}${byKind ? ", grouped by kind" : ", by trust tier (official / registry-observed)"}.${summary ? ` — ${summary}` : ""}`}
      windowLabel="latest snapshot"
      updatedAt={subnet.updated_at ?? subnet.freshness ?? null}
      staleness="Unverified candidates are excluded from the count; the bar shows the trust composition of manifested surfaces."
      side="top"
    >
      <span
        className={classNames("flex items-center gap-2", compact ? "min-w-[72px]" : "min-w-[88px]")}
      >
        <span
          className={classNames(
            "font-mono tabular-nums text-ink w-6 text-right",
            compact ? "text-[11px]" : "text-[12px]",
          )}
        >
          {count || "—"}
        </span>
        <span className={classNames("flex-1", compact ? "max-w-[64px]" : "max-w-[80px]")}>
          <MiniStack segments={segments} height={compact ? 4 : 6} />
        </span>
      </span>
    </SparkLegend>
  );
}
