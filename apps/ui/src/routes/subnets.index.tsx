import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getTaoMarket } from "@/lib/metagraphed/market.functions";
import { z } from "zod";
import { Network, Radio, Layers, Activity, Coins, Server } from "lucide-react";
import {
  AsyncPanel,
  Chip,
  ColumnCustomizer,
  FilterChipRow,
  FilterSheet,
  FreshnessPill,
  Indicator,
  PanelSkeleton,
  ProvenanceChip,
  QueryBar,
  QueryProgress,
  ReadinessGauge,
  StatusBadge,
  StickyToolbar,
  TableSkeleton,
  useColumnVisibility,
  type ColumnDef,
  type FilterChipItem,
  type HealthStatus,
  PageMasthead,
} from "@/components/metagraphed/primitives";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState } from "@/components/metagraphed/states";
import {
  BrandIcon,
  prefetchBrandIcon,
  TimeAgo,
  HealthPill,
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
  BackToTop,
  SegmentedToggle,
  type SegmentedToggleOption,
  type Density,
  type ViewMode,
} from "@jsonbored/ui-kit";
import { useIsMobile } from "@/hooks/use-mobile";
import { useInView } from "@/hooks/use-in-view";
import { SubnetsHighlights } from "@/components/metagraphed/subnets-highlights";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import {
  ariaSort,
  FilterChip,
  PageSizeSelect,
  ResetFiltersButton,
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
  subnetHistoryQuery,
  subnetTrajectoryQuery,
  metagraphedQueryKey,
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
  alpha_price_tao?: number;
  total_stake_tao?: number;
  alpha_market_cap_tao?: number;
};

// Column order + defaults tuned to match the vocabulary of an actual block
// explorer (taostats.io etc.): price + market signal first, registry plumbing
// (source/profile/updated) is opt-in via the column customizer. Renames
// "Curation → Source" and "Readiness → Profile" so headers don't read like
// dev-tool jargon; the underlying filter/sort keys are unchanged.
const SUBNET_COLUMNS: ColumnDef[] = [
  { id: "netuid", label: "UID", required: true },
  { id: "name", label: "Name", required: true },
  { id: "alphaPrice", label: "Price (α)", defaultVisible: true },
  { id: "marketCap", label: "Market cap", defaultVisible: true },
  { id: "emission", label: "Emission" },
  { id: "totalStake", label: "Total stake", defaultVisible: true },
  { id: "participants", label: "Participants" },
  { id: "registration", label: "Reg. cost" },
  { id: "health", label: "Health" },
  { id: "symbol", label: "Symbol", defaultVisible: false },
  { id: "surfaces", label: "Surfaces", defaultVisible: false },
  { id: "curation", label: "Source", defaultVisible: false },
  { id: "readiness", label: "Profile", defaultVisible: false },
  { id: "updated", label: "Updated", defaultVisible: false },
];

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
      <PageMasthead
        live
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        actions={
          <>
            <ViewModeToggle value={search.view} onChange={setView} />
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
      <AsyncPanel
        context="registry highlights"
        fallback={
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
          </div>
        }
        retryQueryKeys={[
          metagraphedQueryKey("health"),
          metagraphedQueryKey("coverage"),
          metagraphedQueryKey("freshness"),
          metagraphedQueryKey("schemas"),
        ]}
      >
        <SubnetsHighlights />
      </AsyncPanel>
      <AsyncPanel
        context="subnets summary"
        fallback={
          <div className="flex flex-wrap gap-3 mb-6 [&>*]:grow [&>*]:basis-[160px]">
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
            <PanelSkeleton height="xs" />
          </div>
        }
      >
        <SubnetsStatStrip />
      </AsyncPanel>
      <SubnetsSavedViews />
      <AsyncPanel
        context="subnets"
        fallback={
          <TableSkeleton
            rows={search.view === "table" ? 10 : 6}
            columns={search.view === "table" ? 8 : 4}
            density={effectiveDensity}
          />
        }
      >
        <SubnetsTable view={search.view} density={effectiveDensity} />
      </AsyncPanel>
      <ApiSourceFooter paths={["/api/v1/subnets"]} artifacts={["/metagraph/subnets.json"]} />
      <SubnetsCompareDrawer />
      <BackToTop />
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
  // Partial/empty API payloads are a normal data state, not a render error.
  // Never let a missing `days` collection take down the whole route.
  const trendDays = trends?.days ?? [];
  const stakeSeries = [...trendDays].reverse().map((d) => d.total_stake_tao ?? 0);
  const latestTotalStake = trendDays[0]?.total_stake_tao ?? undefined;
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
        "mg-type-micro inline-flex min-h-9 items-center gap-1.5 rounded border px-2 py-1 text-[10px] transition-colors",
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
  const columns = useColumnVisibility("subnets", SUBNET_COLUMNS);
  // Local trend window powering the per-row Price/Stake/MCap sparklines +
  // tone. Not URL-persisted (view chrome, not a filter over the row set).
  const [trendWindow, setTrendWindow] = useState<"7d" | "30d" | "90d">("7d");

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
  // Smarter default: when the user hasn't clicked a column, sort by market cap
  // (descending) so the highest-signal rows land at the top — matches how every
  // real block explorer opens. An explicit `search.sort` always wins.
  const effectiveSort = search.sort || "alpha_market_cap_tao";
  const effectiveOrder: "asc" | "desc" = search.sort ? search.order : "desc";
  const rows = useMemo(
    () =>
      sortBy(
        filtered,
        effectiveSort,
        effectiveOrder,
        (row, key) => (row as Record<string, unknown>)[key],
      ),
    [filtered, effectiveSort, effectiveOrder],
  );

  // Live TAO price (USD) — one fetch, cached — so we can render an inline USD
  // conversion beneath alpha-price cells without touching per-row queries.
  const { data: taoMarket } = useQuery({
    queryKey: ["tao-market"],
    queryFn: () => getTaoMarket(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const taoUsd = taoMarket?.price;

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

  // Unified QueryBar-driven filter surface. All filter dropdowns become
  // typeahead popovers; utilities live in the trailing icon cluster; the
  // meta row (count + reset) drops below the shell instead of clogging it.
  const curationOptions = [
    { value: "native", label: "Native" },
    { value: "adapter-backed", label: "Adapter" },
    { value: "maintainer-reviewed", label: "Reviewed" },
    { value: "machine-verified", label: "Machine" },
    { value: "community-seeded", label: "Community" },
    { value: "candidate-discovered", label: "Candidate" },
  ];
  const readinessOptions = [
    { value: "buildable", label: "Buildable" },
    { value: "emerging", label: "Emerging" },
    { value: "identity-only", label: "Identity-only" },
    { value: "dormant", label: "Dormant" },
  ];
  const serviceOptions = [
    { value: "subnet-api", label: "subnet-api" },
    { value: "openapi", label: "openapi" },
    { value: "sse", label: "sse" },
    { value: "data-artifact", label: "data-artifact" },
  ];
  const kindOptions = [
    { value: "api", label: "has API" },
    { value: "sse", label: "has SSE" },
    { value: "docs", label: "has docs" },
  ];

  const activeFilterCount =
    (search.q ? 1 : 0) +
    (search.health ? 1 : 0) +
    (search.curation ? 1 : 0) +
    (search.readiness ? 1 : 0) +
    (search.serviceKind ? 1 : 0) +
    (search.kind ? 1 : 0) +
    (search.stale ? 1 : 0) +
    (!search.includeRoot ? 1 : 0);

  const resultCount = rows.length;
  const totalCount = total ?? all.length;

  // Primary tone selector replaces the row of trigger chips. Health is the
  // one filter people reach for constantly ("what's live? what's broken?"),
  // so it lives inline as a segmented switch; every other filter (Source,
  // Profile, Service, Surface) is opt-in behind a single "Filters" button
  // that opens the same sheet on every viewport — no more chip soup.
  const toneOptions: SegmentedToggleOption<"" | "ok" | "warn" | "down" | "unknown">[] = [
    { value: "", label: "All" },
    { value: "ok", label: "Live" },
    { value: "warn", label: "Warn" },
    { value: "down", label: "Down" },
    { value: "unknown", label: "New" },
  ];

  const secondaryFilters = (
    <div className="flex flex-col gap-3">
      <FilterChip
        label="Source"
        ariaLabel="Filter by curation source"
        placeholder="Any"
        value={search.curation}
        onChange={(v) => setSearch({ curation: v })}
        options={curationOptions}
      />
      <FilterChip
        label="Profile"
        ariaLabel="Filter by profile completeness tier"
        placeholder="Any"
        value={search.readiness}
        onChange={(v) => setSearch({ readiness: v })}
        options={readinessOptions}
      />
      <FilterChip
        label="Service"
        ariaLabel="Filter by service kind"
        placeholder="Any"
        value={search.serviceKind}
        onChange={(v) => setSearch({ serviceKind: v })}
        options={serviceOptions}
      />
      <FilterChip
        label="Surface"
        ariaLabel="Filter by surface kind"
        placeholder="Any"
        value={search.kind}
        onChange={(v) => setSearch({ kind: v })}
        options={kindOptions}
      />
    </div>
  );

  const secondaryFilterCount =
    (search.curation ? 1 : 0) +
    (search.readiness ? 1 : 0) +
    (search.serviceKind ? 1 : 0) +
    (search.kind ? 1 : 0);

  const filters = (
    <div className="flex w-full flex-col gap-0 min-w-0">
      <div className="flex w-full items-center gap-2 min-w-0">
        <QueryBar className="flex-1 min-w-0">
          <QueryBar.Search
            value={search.q}
            onChange={(v) => setSearch({ q: v })}
            placeholder="Search by netuid, name, or symbol"
            shortcut
            debounceMs={200}
          />

          <QueryBar.Divider />
          <div className="hidden sm:flex items-center">
            <SegmentedToggle
              options={toneOptions}
              value={(search.health as "" | "ok" | "warn" | "down" | "unknown") ?? ""}
              onChange={(v: string) => setSearch({ health: v })}
              ariaLabel="Filter by health tone"
              className="border-0 bg-transparent"
            />
          </div>
          <QueryBar.Utility className="ml-auto">
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
            {view === "table" ? (
              <>
                <SegmentedToggle<"7d" | "30d" | "90d">
                  options={[
                    { value: "7d", label: "7d" },
                    { value: "30d", label: "30d" },
                    { value: "90d", label: "90d" },
                  ]}
                  value={trendWindow}
                  onChange={(v) => setTrendWindow(v)}
                  ariaLabel="Trend window for row sparklines"
                  className="border-0 bg-transparent"
                />
                <ColumnCustomizer
                  columns={SUBNET_COLUMNS}
                  isVisible={columns.isVisible}
                  onToggle={columns.toggle}
                  onReset={columns.reset}
                />
              </>
            ) : null}
          </QueryBar.Utility>
        </QueryBar>
        <FilterSheet label="Filters" activeCount={secondaryFilterCount}>
          {secondaryFilters}
        </FilterSheet>
      </div>
      <QueryBar.MetaRow
        count={resultCount}
        total={totalCount}
        noun="subnets"
        activeCount={activeFilterCount}
        onReset={
          activeFilterCount > 0
            ? () =>
                navigate({
                  search: { limit: search.limit, view: search.view } as never,
                  replace: true,
                })
            : undefined
        }
      />
      {(() => {
        const chipItems: FilterChipItem[] = [];
        const labelFor = (opts: { value: string; label: string }[], v: string) =>
          opts.find((o) => o.value === v)?.label ?? v;
        if (search.q) chipItems.push({ id: "q", label: "Search", value: search.q });
        if (search.health)
          chipItems.push({
            id: "health",
            label: "Health",
            value: labelFor(toneOptions as never, search.health),
          });
        if (search.curation)
          chipItems.push({
            id: "curation",
            label: "Source",
            value: labelFor(curationOptions, search.curation),
          });
        if (search.readiness)
          chipItems.push({
            id: "readiness",
            label: "Profile",
            value: labelFor(readinessOptions, search.readiness),
          });
        if (search.serviceKind)
          chipItems.push({
            id: "serviceKind",
            label: "Service",
            value: labelFor(serviceOptions, search.serviceKind),
          });
        if (search.kind)
          chipItems.push({
            id: "kind",
            label: "Surface",
            value: labelFor(kindOptions, search.kind),
          });
        if (search.stale) chipItems.push({ id: "stale", label: "Stale", value: "only" });
        if (!search.includeRoot)
          chipItems.push({ id: "includeRoot", label: "Root", value: "hidden" });
        const clearKey = (id: string) => {
          switch (id) {
            case "q":
              setSearch({ q: "" });
              break;
            case "health":
              setSearch({ health: "" });
              break;
            case "curation":
              setSearch({ curation: "" });
              break;
            case "readiness":
              setSearch({ readiness: "" });
              break;
            case "serviceKind":
              setSearch({ serviceKind: "" });
              break;
            case "kind":
              setSearch({ kind: "" });
              break;
            case "stale":
              setSearch({ stale: "" });
              break;
            case "includeRoot":
              setSearch({ includeRoot: true });
              break;
          }
        };
        return (
          <FilterChipRow
            items={chipItems}
            onRemove={clearKey}
            onClearAll={
              chipItems.length > 1
                ? () =>
                    navigate({
                      search: { limit: search.limit, view: search.view } as never,
                      replace: true,
                    })
                : undefined
            }
          />
        );
      })()}
    </div>
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

  // Grid / matrix views skip ListShell so they're not boxed in a table card.
  if (view === "grid" || view === "matrix") {
    return (
      <div>
        <StickyToolbar className="mb-3">{filters}</StickyToolbar>
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
    <div id="subnets-list" className="relative">
      <QueryProgress active={isFetching && !isFetchingNextPage} position="sticky" />
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
              <div className="grid grid-cols-[auto_minmax(88px,1fr)] items-center gap-3">
                <ProvenanceChip level={s.curation_level} />
                <ReadinessGauge
                  score={s.integration_readiness}
                  tier={s.readiness_tier}
                  details={s.service_kinds}
                  compact
                  className="justify-self-end"
                />
              </div>
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
              <thead>
                <tr>
                  <th
                    className={classNames(firstPad, "mg-subnets-sticky-head w-6")}
                    aria-label="Compare"
                  />
                  <th
                    className={classNames(cellPad, "mg-subnets-sticky-head")}
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
                    className={classNames(cellPad, "mg-subnets-sticky-head")}
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
                  {columns.isVisible("symbol") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head")}
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
                  ) : null}
                  {columns.isVisible("participants") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
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
                  ) : null}
                  {columns.isVisible("curation") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head")}
                      aria-sort={ariaSort(search.sort === "curation_level", search.order)}
                      title="Source: how this subnet's registry entry was curated — native chain data, machine-verified, maintainer-reviewed, adapter-backed, community-seeded, or an unverified candidate."
                    >
                      <SortHeader
                        label="Source"
                        field="curation_level"
                        active={search.sort === "curation_level"}
                        order={search.order}
                        onSort={onSort}
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("surfaces") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "surfaces_count", search.order)}
                      title="Verified public surfaces registered for this subnet (APIs, docs, dashboards, data artifacts, SSE streams)."
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
                  ) : null}
                  {columns.isVisible("readiness") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "integration_readiness", search.order)}
                      title="Profile: how complete this subnet's public-interface profile is (buildable → emerging → identity-only → dormant), based on registered surfaces and evidence."
                    >
                      <SortHeader
                        label="Profile"
                        field="integration_readiness"
                        active={search.sort === "integration_readiness"}
                        order={search.order}
                        onSort={onSort}
                        align="right"
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("registration") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "registration_cost_tao", search.order)}
                      title="Current recycle/burn cost (in TAO) to register a new UID on this subnet. Dimmed when registration is closed."
                    >
                      <SortHeader
                        label="Reg. cost"
                        field="registration_cost_tao"
                        active={search.sort === "registration_cost_tao"}
                        order={search.order}
                        onSort={onSort}
                        align="right"
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("health") ? (
                    <th
                      className={classNames(
                        cellPad,
                        "mg-subnets-sticky-head mg-type-micro text-[10px] text-ink-muted font-normal text-left",
                      )}
                    >
                      Health
                    </th>
                  ) : null}
                  {columns.isVisible("emission") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
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
                  ) : null}
                  {columns.isVisible("alphaPrice") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "alpha_price_tao", search.order)}
                    >
                      <SortHeader
                        label="Alpha price"
                        field="alpha_price_tao"
                        active={search.sort === "alpha_price_tao"}
                        order={search.order}
                        onSort={onSort}
                        align="right"
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("totalStake") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "total_stake_tao", search.order)}
                    >
                      <SortHeader
                        label="Total stake"
                        field="total_stake_tao"
                        active={search.sort === "total_stake_tao"}
                        order={search.order}
                        onSort={onSort}
                        align="right"
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("marketCap") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                      aria-sort={ariaSort(search.sort === "alpha_market_cap_tao", search.order)}
                    >
                      <SortHeader
                        label="Market cap"
                        field="alpha_market_cap_tao"
                        active={search.sort === "alpha_market_cap_tao"}
                        order={search.order}
                        onSort={onSort}
                        align="right"
                      />
                    </th>
                  ) : null}
                  {columns.isVisible("updated") ? (
                    <th
                      className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
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
                  ) : null}
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
                    {columns.isVisible("symbol") ? (
                      <td className={classNames(cellPad, "font-mono text-[11px] text-ink-muted")}>
                        {s.symbol ?? "—"}
                      </td>
                    ) : null}
                    {columns.isVisible("participants") ? (
                      <td className={classNames(cellPad, "text-right")}>
                        <ParticipantsCell
                          value={s.participants}
                          density={density}
                          updatedAt={s.updated_at ?? s.freshness}
                        />
                      </td>
                    ) : null}
                    {columns.isVisible("curation") ? (
                      <td className={cellPad}>
                        <ProvenanceChip level={s.curation_level} />
                      </td>
                    ) : null}
                    {columns.isVisible("surfaces") ? (
                      <td className={classNames(cellPad, "text-right")}>
                        <SurfacesCell subnet={s} density={density} />
                      </td>
                    ) : null}
                    {columns.isVisible("readiness") ? (
                      <td className={classNames(cellPad, "text-right")}>
                        <ReadinessGauge
                          score={s.integration_readiness}
                          tier={s.readiness_tier}
                          details={s.service_kinds}
                          compact={compact}
                        />
                      </td>
                    ) : null}
                    {columns.isVisible("registration") ? (
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
                    ) : null}
                    {columns.isVisible("health") ? (
                      <td className={cellPad}>
                        <HealthPill state={s.health} />
                      </td>
                    ) : null}
                    {columns.isVisible("emission") ? (
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono text-[11px] tabular-nums",
                        )}
                      >
                        <EmissionCell share={s.emission_share} />
                      </td>
                    ) : null}
                    {columns.isVisible("alphaPrice") ? (
                      <FinancialTrendCell
                        netuid={s.netuid}
                        field="alpha_price_tao"
                        current={s.alpha_price_tao}
                        digits={4}
                        compact={compact}
                        usdPerTao={taoUsd}
                        window={trendWindow}
                      />
                    ) : null}
                    {columns.isVisible("totalStake") ? (
                      <FinancialTrendCell
                        netuid={s.netuid}
                        field="total_stake_tao"
                        current={s.total_stake_tao}
                        compact={compact}
                        window={trendWindow}
                        symbol={s.netuid === 0 ? "τ" : (s.symbol ?? "α")}
                      />
                    ) : null}
                    {columns.isVisible("marketCap") ? (
                      <FinancialTrendCell
                        netuid={s.netuid}
                        field="alpha_market_cap_tao"
                        current={s.alpha_market_cap_tao}
                        compact={compact}
                        usdPerTao={taoUsd}
                        window={trendWindow}
                      />
                    ) : null}
                    {columns.isVisible("updated") ? (
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono text-[11px] text-ink-muted",
                        )}
                      >
                        <TimeAgo at={s.updated_at ?? s.freshness} />
                      </td>
                    ) : null}
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
                <div className="mg-type-micro text-[10px] text-ink-muted">
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
              <StatusBadge status={(s.health ?? "unknown") as HealthStatus} />
            </div>
          </div>

          {(s as { description?: string }).description ? (
            <p className="text-[12px] text-ink-muted leading-relaxed line-clamp-2">
              {(s as { description?: string }).description}
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-border/70">
            <Chip
              tone={
                s.curation_level === "native" ||
                s.curation_level === "maintainer-reviewed" ||
                s.curation_level === "machine-verified" ||
                s.curation_level === "adapter-backed"
                  ? "accent"
                  : "muted"
              }
              label="curation"
            >
              {s.curation_level ?? "unknown"}
            </Chip>
            <div className="flex items-center gap-3">
              <Indicator
                icon={Layers}
                label="uids"
                value={formatNumber(s.participants)}
                title="Registered UIDs"
              />
              <Indicator
                icon={Server}
                label="surfaces"
                value={s.surfaces_count ?? 0}
                title="Verified public surfaces"
              />
              <FreshnessPill updatedAt={s.updated_at ?? s.freshness} />
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
        <div className="mg-type-micro text-[10px] text-ink-muted">
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

function FinancialCell({
  value,
  digits = 2,
  compact = false,
  usdPerTao,
}: {
  value?: number;
  digits?: number;
  compact?: boolean;
  usdPerTao?: number;
}) {
  const usd = value != null && usdPerTao != null ? value * usdPerTao : undefined;
  const fmtUsd = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `$${(n / 1_000).toFixed(1)}K`
        : `$${n.toFixed(2)}`;
  return (
    <td
      className={classNames(
        compact ? "px-3 py-1.5" : "px-4 py-2.5",
        "text-right font-mono text-[11px] tabular-nums text-ink",
      )}
    >
      <div>
        {value == null
          ? "—"
          : `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} τ`}
      </div>
      {usd != null ? <div className="text-[10px] text-ink-muted/80">{fmtUsd(usd)}</div> : null}
    </td>
  );
}

// Per-row financial cell with a tone-colored value + sparkline over the
// selected window. Data source depends on the field:
//   - total_stake_tao       → /subnets/{n}/history (daily snapshots)
//   - alpha_price_tao       → /subnets/{n}/trajectory (daily price)
//   - alpha_market_cap_tao  → trajectory price × 21_000_000 alpha cap
// React Query dedupes each underlying request across rows/cells.
const ALPHA_MAX_SUPPLY = 21_000_000;

function FinancialTrendCell({
  netuid,
  field,
  current,
  window: win,
  digits = 2,
  compact = false,
  usdPerTao,
  symbol,
}: {
  netuid: number;
  field: "alpha_price_tao" | "total_stake_tao" | "alpha_market_cap_tao";
  current?: number;
  window: "7d" | "30d" | "90d";
  digits?: number;
  compact?: boolean;
  usdPerTao?: number;
  symbol?: string;
}) {
  const usesTrajectory = field === "alpha_price_tao" || field === "alpha_market_cap_tao";
  // Trend data is per-netuid (react-query can't dedupe across rows), and a
  // page can hold up to 200 rows — fetch only once a row has actually
  // scrolled into view instead of firing a query for every mounted row.
  const [cellRef, inView] = useInView<HTMLTableCellElement>();
  const historyRes = useQuery({
    ...subnetHistoryQuery(netuid, win),
    enabled: inView && !usesTrajectory,
    staleTime: 60_000,
  });
  const trajectoryRes = useQuery({
    ...subnetTrajectoryQuery(netuid),
    enabled: inView && usesTrajectory,
    staleTime: 60_000,
  });

  const series: number[] = useMemo(() => {
    if (usesTrajectory) {
      const points = trajectoryRes.data?.data?.points ?? [];
      const days = win === "7d" ? 7 : win === "30d" ? 30 : 90;
      const windowed = points.slice(-days);
      const priced = windowed
        .map((p) => (typeof p.alpha_price_tao === "number" ? p.alpha_price_tao : NaN))
        .filter((n) => Number.isFinite(n)) as number[];
      return field === "alpha_market_cap_tao" ? priced.map((p) => p * ALPHA_MAX_SUPPLY) : priced;
    }
    const points = historyRes.data?.data?.points ?? [];
    return points
      .map((p) => {
        const raw = (p as Record<string, unknown>)[field];
        return typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
      })
      .filter((n) => Number.isFinite(n)) as number[];
  }, [usesTrajectory, trajectoryRes.data, historyRes.data, win, field]);

  const last = series.length ? series[series.length - 1] : current;
  const first = series.length ? series[0] : undefined;
  const delta = first != null && last != null && first !== 0 ? (last - first) / first : 0;
  const tone: "up" | "down" | "flat" =
    series.length < 2 || Math.abs(delta) < 0.0005 ? "flat" : delta > 0 ? "up" : "down";
  const toneClass =
    tone === "up" ? "text-health-ok" : tone === "down" ? "text-health-down" : "text-ink";
  const strokeVar =
    tone === "up"
      ? "var(--health-ok)"
      : tone === "down"
        ? "var(--health-down)"
        : "var(--ink-muted)";
  const displayValue = last ?? current;
  const usd = displayValue != null && usdPerTao != null ? displayValue * usdPerTao : undefined;
  const fmtUsd = (n: number) =>
    n >= 1_000_000_000
      ? `$${(n / 1_000_000_000).toFixed(2)}B`
      : n >= 1_000_000
        ? `$${(n / 1_000_000).toFixed(2)}M`
        : n >= 1_000
          ? `$${(n / 1_000).toFixed(1)}K`
          : `$${n.toFixed(2)}`;
  const pct = tone === "flat" ? null : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`;
  const unit = symbol ?? "τ";
  const fmtVal = (n: number) => {
    const compactNum =
      n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(2)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(1)}K`
          : n.toLocaleString(undefined, { maximumFractionDigits: digits });
    return `${compactNum} ${unit}`;
  };
  return (
    <td
      ref={cellRef}
      className={classNames(
        compact ? "px-3 py-1.5" : "px-4 py-2.5",
        "text-right font-mono text-[11px] tabular-nums",
      )}
    >
      <div className="flex items-center justify-end gap-2">
        {series.length > 1 ? (
          <Sparkline
            values={series}
            width={compact ? 44 : 56}
            height={compact ? 14 : 18}
            color={strokeVar}
            fill={false}
            interactive={false}
            ariaLabel={`${field} ${win} trend`}
          />
        ) : null}
        <div className="min-w-0">
          <div className={toneClass}>{displayValue == null ? "—" : fmtVal(displayValue)}</div>
          {usd != null || pct ? (
            <div className="text-[10px] text-ink-muted/80 flex items-center justify-end gap-1">
              {usd != null ? <span>{fmtUsd(usd)}</span> : null}
              {pct ? (
                <span className={toneClass} title={`${win} change`}>
                  {pct}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </td>
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
