import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { getTaoMarket } from "@/lib/metagraphed/market.functions";
import { ChevronDown, Coins, Layers, Server, Star } from "lucide-react";
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
  Panel,
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
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import {
  ariaSort,
  FilterChip,
  ResetFiltersButton,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { SubnetsSavedViews } from "@/components/metagraphed/subnets-saved-views";
import {
  SubnetsCompareDrawer,
  CompareToggle,
} from "@/components/metagraphed/subnets-compare-drawer";
import {
  subnetsQuery,
  coverageQuery,
  healthQuery,
  subnetHealthMapQuery,
  agentCatalogMapQuery,
  economicsQuery,
  subnetHistoryQuery,
  subnetTrajectoryQuery,
  domainsQuery,
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
import { joinEconomics, joinHealth, matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { API_BASE } from "@/lib/metagraphed/config";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { LeaderboardsSection, LeaderboardsCsvExportMenu } from "./-leaderboards-page";
import { DomainsRollup } from "@/components/metagraphed/domains-rollup";
import type { AgentCatalogSummary, Subnet, SubnetEconomics } from "@/lib/metagraphed/types";

// #8248: fetch every active subnet in one shot instead of cursor-paginating --
// the whole list (129 rows) is virtualized client-side, so there is no
// "Load more" tier anymore. 200 comfortably exceeds the live subnet count
// (verified: GET /api/v1/subnets?limit=200 already returns all 129 with
// next_cursor: null) with headroom for registry growth.
const ALL_ROWS_LIMIT = 200;

// #8362: the mobile card branch (unlike the desktop table) isn't virtualized
// -- it's a plain map over every filtered/sorted row, so all 129 cards
// mounted up front on a phone. Cap the initial mount and grow in the same
// increment via the existing LoadMore affordance; search/filter/sort still
// run over the full `rows` set, only the mounted slice is capped.
const MOBILE_CARD_STEP = 30;

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
// #8248: column diet. Default set matches the issue's 8 named columns
// (star/Subnet/Price+spark are structural, not toggleable); the long tail
// (Symbol/Surfaces/Source/Profile/Reg. cost/Market cap/Updated) stays
// available via the column customizer, just off by default. PARTICIPANTS is
// gone outright, not hidden -- it read 256 for essentially every row (the
// registered-UID cap, not a real signal) and had no customizer escape hatch
// worth keeping for a column that carries zero information.
const SUBNET_COLUMNS: ColumnDef[] = [
  { id: "netuid", label: "UID", required: true },
  { id: "name", label: "Name", required: true },
  { id: "alphaPrice", label: "Price (α)", defaultVisible: true },
  { id: "priceChange", label: "24h/7d %", defaultVisible: true },
  { id: "emission", label: "Emission", defaultVisible: true },
  { id: "totalStake", label: "Total stake", defaultVisible: true },
  { id: "health", label: "Health", defaultVisible: true },
  { id: "age", label: "Age", defaultVisible: true },
  { id: "marketCap", label: "Market cap", defaultVisible: false },
  { id: "registration", label: "Reg. cost", defaultVisible: false },
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

export function SubnetsPage() {
  const search = useSearch({ from: "/subnets/" });
  const navigate = useNavigate({ from: "/subnets/" });
  const filtersActive =
    !!search.q ||
    !!search.sort ||
    !!search.curation ||
    !!search.health ||
    !!search.serviceKind ||
    !!search.readiness ||
    !!search.kind ||
    !!search.stale ||
    !!search.domain ||
    !!search.watched ||
    // #6270: defaults to true, so hiding the root is what makes it "active" —
    // without this the Reset button stays disabled while a filter is applied.
    !search.includeRoot;
  const onReset = () =>
    navigate({
      search: { view: search.view } as never,
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
  const setSection = (section: "registry" | "rankings") =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, section }) as never,
      resetScroll: false,
    });
  const setWindow = (window: "7d" | "30d") =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, window }) as never,
      replace: true,
      resetScroll: false,
    });
  const subnetsCsvUrl = buildUrl("/api/v1/subnets", { limit: ALL_ROWS_LIMIT });
  return (
    <AppShell>
      <PageMasthead
        live
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        actions={
          <>
            {search.section === "registry" ? (
              <>
                <ViewModeToggle value={search.view} onChange={setView} />
                {search.view === "table" ? (
                  <DensityToggle value={effectiveDensity} onChange={setDensity} />
                ) : null}
              </>
            ) : null}
            <ActionBar>
              {search.section === "rankings" ? (
                <LeaderboardsCsvExportMenu win={search.window} />
              ) : (
                <>
                  <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
                  <DownloadCsvButton url={subnetsCsvUrl} bare />
                </>
              )}
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      {/* #8248: masthead trim -- the old nine meta-cards (SubnetsHighlights +
          a 5-tile SubnetsStatStrip) pushed the table ~1,700px down on mobile
          and led with an incident card, before any actionable content. Ops
          signals (incidents/drift/pilot counts) now live only on their owning
          pages (/apis/endpoints, /status); this page keeps at most 4 inline
          facts a reader of a SUBNET list actually wants first. */}
      {/* #8311: /leaderboards folded in here. Every board ranks subnets, so a
          separate top-level route for them was an IA accident. A section tab
          rather than a `view` mode -- see subnets.index.tsx for why. */}
      <SectionTabs section={search.section} onChange={setSection} />

      {search.section === "rankings" ? (
        <LeaderboardsSection win={search.window} onWindowChange={setWindow} />
      ) : (
        <>
          <AsyncPanel
            context="subnets summary"
            fallback={<PanelSkeleton height="xs" className="mb-4" />}
          >
            <SubnetsCompactStats />
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
          <AsyncPanel
            context="domains rollup"
            fallback={<PanelSkeleton height="sm" className="mt-6" />}
          >
            <SubnetsDomainsRollup />
          </AsyncPanel>
          {/* #8311: /domains folded in. The chips above are a filter; this is
              the taxonomy itself -- members, stake, emission share and
              within-domain concentration per domain. Collapsed by default so
              it costs nothing to the reader who came for the table, and its
              query doesn't fire until opened. */}
          <SubnetsDomainsTaxonomy />
        </>
      )}
      <ApiSourceFooter
        paths={
          search.section === "rankings"
            ? [
                "/api/v1/registry/leaderboards",
                "/api/v1/chain/weights",
                "/api/v1/chain/deregistrations",
                "/api/v1/economics",
              ]
            : ["/api/v1/subnets", "/api/v1/domains"]
        }
        artifacts={search.section === "rankings" ? undefined : ["/metagraph/subnets.json"]}
      />
      <SubnetsCompareDrawer />
      <BackToTop />
    </AppShell>
  );
}

// #8248: masthead trim -- Active / Healthy / Total stake / freshness (only
// when late), inline, no cards. Active + Healthy read the same
// coverage/health sources SubnetsHighlights used; the "Healthy" figure is
// endpoint-level (probed surfaces), matching the header ribbon's own
// "endpoints up N/M" convention, not a subnet count.
function SubnetsCompactStats() {
  const coverageRes = useSuspenseQuery(coverageQuery());
  const healthRes = useSuspenseQuery(healthQuery());
  const coverage = coverageRes.data.data ?? {};
  const health = healthRes.data.data ?? {};
  const active =
    (coverage.netuids_active as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const total =
    (coverage.netuids_total as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const ok = health.ok as number | undefined;
  const totalH = health.total as number | undefined;
  // #3363-adjacent: total stake summed from the same live economics rows the
  // table's Total stake column reads, so the masthead figure and the column
  // total can never diverge from a second source.
  const economicsRes = useQuery(economicsQuery());
  const totalStake = (economicsRes.data?.data ?? []).reduce(
    (sum, e) => sum + (e.total_stake_tao ?? 0),
    0,
  );
  const generatedAt = coverageRes.data.meta?.generated_at ?? healthRes.data.meta?.generated_at;
  const stale = isStaleFreshness(generatedAt);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 mg-type-data text-ink-muted">
      <span>
        <span className="font-medium text-ink-strong">{formatNumber(active)}</span> active
        {total ? ` of ${formatNumber(total)}` : ""}
      </span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <span>
        Healthy{" "}
        <span className="font-medium text-ink-strong">
          {ok != null && totalH ? `${formatNumber(ok)}/${formatNumber(totalH)}` : "—"}
        </span>
      </span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <span>
        Total stake{" "}
        <span className="inline-flex items-center gap-1 font-medium text-ink-strong">
          <Coins className="size-3.5 text-accent" aria-hidden />
          {formatTao(totalStake)}
        </span>
      </span>
      {stale ? (
        <>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span className="inline-flex items-center rounded border border-health-warn/40 bg-health-warn/10 px-1.5 py-0.5 mg-type-caption text-health-warn">
            Data may be stale
          </span>
        </>
      ) : null}
    </div>
  );
}

// #8248: compact domains rollup below the table (from the nav-consolidation
// issue's domains-integration note). Each chip is both a summary and a
// filter trigger -- clicking a domain narrows the table to its member
// netuids via the same `domain` search param the filter-chip row clears.
function SubnetsDomainsRollup() {
  const { data } = useSuspenseQuery(domainsQuery());
  const domains = data.data ?? [];
  const navigate = useNavigate({ from: "/subnets/" });
  const search = useSearch({ from: "/subnets/" });
  if (domains.length === 0) return null;
  const sorted = [...domains].sort((a, b) => (b.subnet_count ?? 0) - (a.subnet_count ?? 0));
  return (
    <Panel as="div" dense className="mt-6">
      <div className="mb-2 mg-type-caption text-ink-muted">Domains</div>
      <div className="flex flex-wrap gap-2">
        {sorted.map((d) => {
          const active = search.domain === d.domain;
          return (
            <button
              key={d.domain}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) =>
                    ({ ...prev, domain: active ? "" : d.domain }) as never,
                  replace: true,
                })
              }
              aria-pressed={active}
              className={classNames(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 mg-type-data-sm transition-colors",
                active
                  ? "border-accent/60 bg-accent/10 text-ink-strong"
                  : "border-border bg-card text-ink-muted hover:text-ink-strong",
              )}
            >
              <span className="font-medium">{d.domain}</span>
              <span className="text-ink-muted">{d.subnet_count ?? d.netuids.length}</span>
              {d.total_stake_tao != null ? (
                <span className="text-ink-muted">· {formatTao(d.total_stake_tao)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Panel>
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
        "mg-type-caption inline-flex min-h-9 items-center gap-1.5 rounded border px-2 py-1 transition-colors",
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
  const search = useSearch({ from: "/subnets/" });
  const navigate = useNavigate({ from: "/subnets/" });
  const columns = useColumnVisibility("subnets", SUBNET_COLUMNS);
  // Local trend window powering the per-row Price/Stake/MCap sparklines +
  // tone. Not URL-persisted (view chrome, not a filter over the row set).
  const [trendWindow, setTrendWindow] = useState<"7d" | "30d" | "90d">("7d");

  // #8248: one-shot fetch of every active subnet -- no pagination, no
  // "Load more". /api/v1/subnets supports only q + limit server-side (`sort`
  // returns HTTP 400, `curation`/`health` are ignored) -- everything else is
  // applied client-side over this one page.
  const { data, isFetching } = useSuspenseQuery(
    subnetsQuery({ q: search.q || undefined, limit: ALL_ROWS_LIMIT }),
  );

  const watchlist = useWatchlist("subnet");

  // Per-subnet probe health (the list rows don't carry it; join it from
  // /api/v1/health so the Health + Updated columns and the health filter work).
  // Key the `?? {}` fallback off the raw query value so `healthMap` keeps a
  // stable reference across renders — otherwise a fresh `{}` each render would
  // defeat the `all` memo below.
  // #8226: plain (non-suspending) query on purpose. This is an optional join,
  // not core list data -- health is one of the routes `isMainnetOnlyApiPath`
  // blocklists outright on a non-mainnet network (see workers/api.ts), and the
  // surrounding comments already document the intended "missing/failed fetch
  // degrades to an empty map" behavior. useSuspenseQuery contradicted that:
  // a failure here threw up through the table's single AsyncPanel and took
  // the entire table -- including the always-succeeding, always-real
  // subnetsQuery list below -- down with it.
  const healthMapRaw = useQuery(subnetHealthMapQuery()).data?.data;
  const healthMap = useMemo(() => healthMapRaw ?? {}, [healthMapRaw]);

  // #9/#8226: per-subnet agent-catalog capability (service kinds + integration
  // readiness). Joined the same way as health so the capability filter and the
  // Readiness column resolve. Best-effort: subnets with no catalog entry pass
  // through with no capability data (and are simply excluded by the filters).
  // Plain query, same reasoning as healthMapRaw above.
  const catalogMapRaw = useQuery(agentCatalogMapQuery()).data?.data;
  const catalogMap = useMemo(() => catalogMapRaw ?? {}, [catalogMapRaw]);

  // #3364/#3363/#8226: per-subnet on-chain economics — already fetched once per
  // session for the detail EconomicsPanel, so this reuses that shared cache
  // (no new endpoint, no backend change). Indexed by netuid into a map and
  // joined the same way as health/catalog so the Registration + Emission
  // columns (and their sort) resolve off the row. A missing/failed fetch
  // degrades to an empty map (every cell falls back to "—") rather than
  // breaking the table, mirroring healthMap/catalogMap's fallback. Plain
  // query, same reasoning as healthMapRaw above.
  const economicsRaw = useQuery(economicsQuery()).data?.data;
  const economicsMap = useMemo(() => {
    const map: Record<number, SubnetEconomics> = {};
    for (const e of economicsRaw ?? []) map[e.netuid] = e;
    return map;
  }, [economicsRaw]);

  // Join the fetched rows with per-subnet probe health + agent-catalog
  // capability + economics. Memoized on its real inputs so a keystroke/hover
  // that only re-renders the route doesn't re-flatten and re-clone every row.
  const all = useMemo(
    () =>
      joinEconomics(
        joinCatalog(joinHealth((data.data ?? []) as Subnet[], healthMap), catalogMap),
        economicsMap,
      ),
    [data.data, healthMap, catalogMap, economicsMap],
  );

  // #6270: how many rows each inclusion toggle would drop, surfaced on the
  // toggle itself so it answers "what am I hiding?" before you press it — the
  // same affordance /endpoints' callable toggle gives with directoryCount.
  // Counted over the full joined set, independent of the other filters.
  const rootCount = useMemo(
    () => all.filter((s) => s.subnet_type === "root" || s.netuid === 0).length,
    [all],
  );
  const total = data.meta?.pagination?.total ?? data.meta?.total ?? all.length;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
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
    search.domain ||
    search.watched ||
    // #6270: defaults to true (include everything), so it only counts as an
    // active filter once the user has switched it OFF.
    !search.includeRoot
  );

  // Client-side filter + sort (the list API only honors q + cursor/limit).
  // Both are memoized on the joined rows and the exact search params they read,
  // so they only recompute when one of those actually changes — not on every
  // keystroke-driven re-render.
  // #8248: domain membership lookup for the domains-rollup chip filter.
  // Non-suspending join, same reasoning as healthMap/catalogMap above.
  const domainsRaw = useQuery(domainsQuery()).data?.data;
  const domainNetuids = useMemo(() => {
    const found = (domainsRaw ?? []).find((d) => d.domain === search.domain);
    return found ? new Set(found.netuids) : null;
  }, [domainsRaw, search.domain]);

  const filtered = useMemo(
    () =>
      all.filter((s) => {
        if (!matchesQuery([s.netuid, s.name, s.symbol], search.q)) return false;
        if (search.curation && s.curation_level !== search.curation) return false;
        // "Unhealthy" is a quick-tab sentinel (warn OR down) distinct from an
        // exact health-value match, which the Filters-sheet toggle still uses.
        if (search.health === "unhealthy") {
          if (s.health !== "warn" && s.health !== "down") return false;
        } else if (search.health && s.health !== search.health) {
          return false;
        }
        // Capability: subnet must expose the selected service kind. Rows with no
        // catalog entry (no service_kinds) are excluded when this filter is set.
        if (search.serviceKind && !(s.service_kinds ?? []).includes(search.serviceKind))
          return false;
        if (search.readiness && s.readiness_tier !== search.readiness) return false;
        // Mega-menu "Has APIs/docs/SSE" links (nav-mega-menu-data.ts), also the
        // "Has API" quick-tab. "api"/"sse" are agent-catalog service_kinds;
        // "docs" has no service_kinds entry (a docs page isn't a callable
        // service) so it checks the row's own docs_url instead — the one case
        // service_kinds can't answer.
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
        // #8248: domains-rollup chip filter.
        if (domainNetuids && !domainNetuids.has(s.netuid)) return false;
        // #8248: Watched quick-tab -- localStorage watchlist, not a server field.
        if (search.watched && !watchlist.isWatched(s.netuid)) return false;
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
      domainNetuids,
      search.watched,
      watchlist,
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

  // #8362: how many of `rows` are mounted as mobile cards. Reset to the
  // initial step whenever the user actually changes a search/filter/sort
  // input -- deliberately NOT keyed off `rows` itself, since `rows` also
  // gets a new array reference whenever the background health/catalog/
  // economics joins resolve or refetch (see `all`'s memo above), which would
  // silently snap the count back to 30 on every join update, including
  // right after a "Load more" click.
  const [mobileCardLimit, setMobileCardLimit] = useState(MOBILE_CARD_STEP);
  useEffect(() => {
    setMobileCardLimit(MOBILE_CARD_STEP);
  }, [
    search.q,
    search.curation,
    search.health,
    search.serviceKind,
    search.readiness,
    search.kind,
    search.stale,
    search.includeRoot,
    search.watched,
    search.domain,
    effectiveSort,
    effectiveOrder,
  ]);
  const mobileRows = useMemo(() => rows.slice(0, mobileCardLimit), [rows, mobileCardLimit]);

  // #8248: virtualize the table body -- all 129+ rows are fetched/filtered/
  // sorted in full above (no server pagination left), but only the rows
  // actually in view are ever mounted as real DOM `<tr>`s. Kept as genuine
  // table rows (not absolutely-positioned or div-based) via the padding-row
  // technique: two spacer `<tr>`s stand in for the space above/below the
  // rendered slice, so `<thead>` sticky positioning and column alignment
  // both keep working exactly as before. Called unconditionally (before the
  // grid/matrix early return below) since hooks can't be conditional --
  // grid/matrix renders just never read `rowVirtualizer`'s output.
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => (density === "compact" ? 37 : 49),
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

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
    (search.domain ? 1 : 0) +
    (search.watched ? 1 : 0) +
    (!search.includeRoot ? 1 : 0);

  const resultCount = rows.length;
  const totalCount = total ?? all.length;

  // #8248: quick-tabs replace the old health-only tone toggle. "All" clears
  // every quick-tab field at once; the other four each own a specific
  // combination of watched/kind/health, chosen to reuse fields the granular
  // Filters-sheet (below) already reads/writes -- one source of truth per
  // field, never a second parallel filter state.
  type QuickTab = "" | "watched" | "api" | "unhealthy" | "new";
  const quickTab: QuickTab = search.watched
    ? "watched"
    : search.kind === "api"
      ? "api"
      : search.health === "unhealthy"
        ? "unhealthy"
        : search.health === "unknown"
          ? "new"
          : "";
  const quickTabOptions: SegmentedToggleOption<QuickTab>[] = [
    { value: "", label: "All" },
    { value: "watched", label: watchlist.count > 0 ? `Watched · ${watchlist.count}` : "Watched" },
    { value: "api", label: "Has API" },
    { value: "unhealthy", label: "Unhealthy" },
    { value: "new", label: "New" },
  ];
  const onQuickTab = (v: QuickTab) => {
    setSearch({
      watched: v === "watched",
      kind: v === "api" ? "api" : search.kind === "api" ? "" : search.kind,
      health:
        v === "unhealthy"
          ? "unhealthy"
          : v === "new"
            ? "unknown"
            : search.health === "unhealthy" || search.health === "unknown"
              ? ""
              : search.health,
    });
  };

  const secondaryFilters = (
    <div className="flex flex-col gap-3">
      <FilterChip
        label="Health"
        ariaLabel="Filter by exact health state"
        placeholder="Any"
        value={search.health === "unhealthy" ? "" : search.health}
        onChange={(v) => setSearch({ health: v })}
        options={[
          { value: "ok", label: "Live" },
          { value: "warn", label: "Warn" },
          { value: "down", label: "Down" },
          { value: "unknown", label: "New" },
        ]}
      />
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
    (search.health && search.health !== "unhealthy" ? 1 : 0) +
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
              options={quickTabOptions}
              value={quickTab}
              onChange={(v: QuickTab) => onQuickTab(v)}
              ariaLabel="Quick filter"
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
            {view === "table" ? (
              <>
                <SegmentedToggle<"7d" | "30d" | "90d">
                  options={[
                    { value: "7d", label: "7d" },
                    { value: "30d", label: "30d" },
                    { value: "90d", label: "90d" },
                  ]}
                  value={trendWindow}
                  onChange={(v: "7d" | "30d" | "90d") => setTrendWindow(v)}
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
                  search: { view: search.view } as never,
                  replace: true,
                })
            : undefined
        }
      />
      {(() => {
        const chipItems: FilterChipItem[] = [];
        const labelFor = (opts: { value: string; label: string }[], v: string) =>
          opts.find((o) => o.value === v)?.label ?? v;
        const healthLabels = [
          { value: "ok", label: "Live" },
          { value: "warn", label: "Warn" },
          { value: "down", label: "Down" },
          { value: "unknown", label: "New" },
          { value: "unhealthy", label: "Unhealthy" },
        ];
        if (search.q) chipItems.push({ id: "q", label: "Search", value: search.q });
        if (search.health)
          chipItems.push({
            id: "health",
            label: "Health",
            value: labelFor(healthLabels, search.health),
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
        if (search.domain) chipItems.push({ id: "domain", label: "Domain", value: search.domain });
        if (search.watched) chipItems.push({ id: "watched", label: "Watched", value: "only" });
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
            case "domain":
              setSearch({ domain: "" });
              break;
            case "watched":
              setSearch({ watched: false });
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
                      search: { view: search.view } as never,
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

  // Grid / matrix views skip ListShell so they're not boxed in a table card.
  if (view === "grid" || view === "matrix") {
    return (
      <div>
        <StickyToolbar className="mb-3">{filters}</StickyToolbar>
        {rows.length === 0 ? (
          emptyNode
        ) : view === "grid" ? (
          <SubnetGrid rows={rows} watchlist={watchlist} />
        ) : (
          <SubnetMatrix rows={rows} />
        )}
      </div>
    );
  }

  return (
    <div id="subnets-list" className="relative">
      <QueryProgress active={isFetching} position="sticky" />
      <ListShell
        filters={filters}
        isEmpty={rows.length === 0}
        isStale={isFetching}
        empty={emptyNode}
        cards={[
          ...mobileRows.map((s) => (
            <Link
              key={s.netuid}
              to="/subnets/$netuid"
              params={{ netuid: s.netuid }}
              className="relative block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  watchlist.toggle(s.netuid);
                }}
                aria-pressed={watchlist.isWatched(s.netuid)}
                aria-label={
                  watchlist.isWatched(s.netuid) ? "Remove from watchlist" : "Add to watchlist"
                }
                className="mg-tap-target absolute right-2 top-2 rounded p-1 text-ink-muted hover:text-ink-strong"
              >
                <Star
                  className={classNames(
                    "size-4",
                    watchlist.isWatched(s.netuid) && "fill-accent text-accent",
                  )}
                />
              </button>
              <div className="flex items-center gap-3 min-w-0 pr-8">
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
                  <div className="mg-type-data text-ink-muted">
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
              {/* #8248: lead mobile cards with the 3 facts a reader actually
                compares subnets by -- price, emission share, health -- in
                place of the old participants/surfaces/updated registry-
                plumbing row. */}
              <div className="mt-2 grid grid-cols-3 gap-2 mg-type-data">
                <div>
                  <div className="mg-type-caption text-ink-muted">Price</div>
                  <div className="tabular-nums text-ink-strong">
                    {s.alpha_price_tao != null ? `${s.alpha_price_tao.toFixed(4)} τ` : "—"}
                  </div>
                </div>
                <div>
                  <div className="mg-type-caption text-ink-muted">Emission</div>
                  <div className="tabular-nums text-ink-strong">
                    {s.emission_share != null ? `${(s.emission_share * 100).toFixed(2)}%` : "—"}
                  </div>
                </div>
                <div>
                  <div className="mg-type-caption text-ink-muted">Health</div>
                  <HealthPill state={s.health} />
                </div>
              </div>
            </Link>
          )),
          rows.length > MOBILE_CARD_STEP ? (
            <LoadMore
              key="mobile-card-load-more"
              shown={mobileRows.length}
              total={rows.length}
              hasMore={mobileCardLimit < rows.length}
              isLoading={false}
              onLoadMore={() => setMobileCardLimit((prev) => prev + MOBILE_CARD_STEP)}
            />
          ) : null,
        ]}
        table={(() => {
          const compact = density === "compact";
          const cellPad = compact ? "px-3 py-1.5" : "px-4 py-2.5";
          const firstPad = compact ? "pl-3 pr-1 py-1.5" : "pl-4 pr-1 py-2.5";
          const monoSize = compact ? "mg-type-data" : "mg-type-caption";
          return (
            // #8248: bounded, internally-scrolling virtualized region -- this
            // div (not the page) is the sticky-header containing block and
            // the scroll viewport react-virtual measures against. Nested one
            // level inside ListShell's own `.mg-table-scroll` horizontal-
            // scroll wrapper, so it doesn't interact with that wrapper's
            // existing page-sticky CSS override (#subnets-list
            // div:has(> .mg-table-scroll) { overflow: visible }), which only
            // ever targeted `.mg-table-scroll`'s own ancestors.
            <div ref={tableScrollRef} className="max-h-[70vh] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th
                      className={classNames(firstPad, "mg-subnets-sticky-head w-6")}
                      aria-label="Watch"
                    />
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
                    {columns.isVisible("priceChange") ? (
                      <th
                        className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                        title={`Alpha price change over the selected trend window (${trendWindow})`}
                      >
                        <span className="mg-type-caption font-normal text-ink-muted">
                          {trendWindow} %
                        </span>
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
                    {columns.isVisible("health") ? (
                      <th
                        className={classNames(
                          cellPad,
                          "mg-subnets-sticky-head mg-type-micro text-ink-muted font-normal text-left",
                        )}
                      >
                        Health
                      </th>
                    ) : null}
                    {columns.isVisible("age") ? (
                      <th
                        className={classNames(cellPad, "mg-subnets-sticky-head text-right")}
                        aria-sort={ariaSort(search.sort === "registered_at_block", search.order)}
                        title="Time since this subnet's registration block."
                      >
                        <SortHeader
                          label="Age"
                          field="registered_at_block"
                          active={search.sort === "registered_at_block"}
                          order={search.order}
                          onSort={onSort}
                          align="right"
                        />
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {/* #8248: top spacer -- stands in for the height of every row
                    above the rendered slice, so real `<tr>`s never need
                    absolute positioning (which would drop them out of table
                    row-group layout and break column alignment). */}
                  {virtualPaddingTop > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={20} style={{ height: virtualPaddingTop }} />
                    </tr>
                  ) : null}
                  {virtualRows.map((vRow) => {
                    const s = rows[vRow.index];
                    return (
                      <tr
                        key={s.netuid}
                        data-index={vRow.index}
                        ref={rowVirtualizer.measureElement}
                        className="mg-row-accent hover:bg-surface/40"
                      >
                        <td className={classNames(firstPad, "align-middle")}>
                          <button
                            type="button"
                            onClick={() => watchlist.toggle(s.netuid)}
                            aria-pressed={watchlist.isWatched(s.netuid)}
                            aria-label={
                              watchlist.isWatched(s.netuid)
                                ? `Remove SN${s.netuid} from watchlist`
                                : `Add SN${s.netuid} to watchlist`
                            }
                            className="mg-tap-target flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong"
                          >
                            <Star
                              className={classNames(
                                "size-3.5",
                                watchlist.isWatched(s.netuid) && "fill-accent text-accent",
                              )}
                            />
                          </button>
                        </td>
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
                          <div className="mg-type-caption font-sans text-ink-muted/70 whitespace-nowrap">
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
                          <td className={classNames(cellPad, "mg-type-data text-ink-muted")}>
                            {s.symbol ?? "—"}
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
                              "text-right mg-type-data tabular-nums",
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
                        {columns.isVisible("emission") ? (
                          <td
                            className={classNames(cellPad, "text-right mg-type-data tabular-nums")}
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
                        {columns.isVisible("priceChange") ? (
                          <PctChangeCell
                            netuid={s.netuid}
                            current={s.alpha_price_tao}
                            window={trendWindow}
                            compact={compact}
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
                              "text-right mg-type-data text-ink-muted",
                            )}
                          >
                            <TimeAgo at={s.updated_at ?? s.freshness} />
                          </td>
                        ) : null}
                        {columns.isVisible("health") ? (
                          <td className={cellPad}>
                            <HealthPill state={s.health} />
                          </td>
                        ) : null}
                        {columns.isVisible("age") ? (
                          <td
                            className={classNames(
                              cellPad,
                              "text-right mg-type-data tabular-nums text-ink-muted",
                            )}
                          >
                            {formatSubnetAge(subnetAgeDays(s.registered_at_block, s.block))}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                  {virtualPaddingBottom > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={20} style={{ height: virtualPaddingBottom }} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          );
        })()}
      />
    </div>
  );
}

// #8248: 24h/7d trend-window % change as its own column, distinct from the
// value shown in the Price column -- same trajectory source FinancialTrendCell
// already reads for alpha_price_tao (react-query dedupes the fetch, this
// isn't a second network call), just rendered as a standalone colored-text
// figure instead of a sub-line under the price.
function PctChangeCell({
  netuid,
  current,
  window: win,
  compact,
}: {
  netuid: number;
  current?: number;
  window: "7d" | "30d" | "90d";
  compact: boolean;
}) {
  const [cellRef, inView] = useInView<HTMLTableCellElement>();
  const trajectoryRes = useQuery({
    ...subnetTrajectoryQuery(netuid),
    enabled: inView,
    staleTime: 60_000,
  });
  const points = trajectoryRes.data?.data?.points ?? [];
  const days = win === "7d" ? 7 : win === "30d" ? 30 : 90;
  const priced = points
    .slice(-days)
    .map((p) => (typeof p.alpha_price_tao === "number" ? p.alpha_price_tao : NaN))
    .filter((n) => Number.isFinite(n));
  const first = priced[0];
  const last = priced.length ? priced[priced.length - 1] : current;
  const delta = first != null && last != null && first !== 0 ? (last - first) / first : null;
  const toneClass =
    delta == null || Math.abs(delta) < 0.0005
      ? "text-ink-muted"
      : delta > 0
        ? "text-health-ok"
        : "text-health-down";
  return (
    <td
      ref={cellRef}
      className={classNames(
        compact ? "px-3 py-1.5" : "px-4 py-2.5",
        "text-right mg-type-data tabular-nums",
        toneClass,
      )}
    >
      {delta == null ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`}
    </td>
  );
}

/* ---------- Grid view ---------- */

function SubnetGrid({
  rows,
  watchlist,
}: {
  rows: Subnet[];
  watchlist: ReturnType<typeof useWatchlist>;
}) {
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
                <div className="mg-type-caption text-ink-muted">
                  #{String(s.netuid).padStart(3, "0")}
                  {s.symbol ? ` · ${s.symbol}` : ""}
                </div>
                <div className="font-display font-semibold text-ink-strong truncate">
                  {s.name ?? `Subnet ${s.netuid}`}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  watchlist.toggle(s.netuid);
                }}
                aria-pressed={watchlist.isWatched(s.netuid)}
                aria-label={
                  watchlist.isWatched(s.netuid) ? "Remove from watchlist" : "Add to watchlist"
                }
                className="mg-tap-target rounded p-1 text-ink-muted hover:text-ink-strong"
              >
                <Star
                  className={classNames(
                    "size-3.5",
                    watchlist.isWatched(s.netuid) && "fill-accent text-accent",
                  )}
                />
              </button>
              <CompareToggle netuid={s.netuid} />
              <StatusBadge status={(s.health ?? "unknown") as HealthStatus} />
            </div>
          </div>

          {(s as { description?: string }).description ? (
            <p className="mg-type-caption text-ink-muted leading-relaxed line-clamp-2">
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
    <Panel as="div" dense>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="mg-type-caption text-ink-muted">Health matrix · {rows.length} subnets</div>
        <div className="flex items-center gap-3 mg-type-data-sm text-ink-muted">
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
                "mg-pulse-cell flex aspect-square items-center justify-center rounded mg-type-data-sm font-medium transition-transform",
                HEALTH_BG[s.health ?? "unknown"] ?? HEALTH_BG.unknown,
                HEALTH_TEXT[s.health ?? "unknown"] ?? HEALTH_TEXT.unknown,
              )}
            >
              {s.netuid}
            </Link>
          </EntityHoverCard>
        ))}
      </div>
    </Panel>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={classNames("size-2 rounded", color)} />
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
        "text-right mg-type-data tabular-nums",
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
            <div className="mg-type-data-sm text-ink-muted/80 flex items-center justify-end gap-1">
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
            compact ? "mg-type-data" : "mg-type-caption",
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

/**
 * Registry / Rankings switch (#8311). Two sections, so a plain two-button
 * strip rather than the ProfileTabs machinery -- there's no overflow to
 * manage and no per-tab URL segment.
 */
function SectionTabs({
  section,
  onChange,
}: {
  section: "registry" | "rankings";
  onChange: (s: "registry" | "rankings") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Subnets sections"
      className="mb-4 flex items-center gap-1 border-b border-border"
    >
      {(
        [
          ["registry", "Registry"],
          ["rankings", "Rankings"],
        ] as const
      ).map(([id, label]) => {
        const active = section === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={classNames(
              "relative min-h-11 px-3 py-2 mg-type-caption-lg font-medium transition-colors mg-focus-ring",
              active
                ? "text-ink-strong after:absolute after:inset-x-2 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-accent after:content-['']"
                : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The full domain taxonomy, absorbed from the retired /domains route (#8311).
 * Collapsed by default: the reader who came for the subnet table shouldn't pay
 * for it, and a closed <details> never mounts its child, so the domains query
 * doesn't fire until it's opened.
 */
function SubnetsDomainsTaxonomy() {
  const [open, setOpen] = useState(false);
  return (
    <section id="domains" className="mt-6 scroll-mt-24">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="domains-taxonomy"
        className="mg-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded px-1 py-1 mg-type-caption font-medium text-ink-muted transition-colors hover:text-ink-strong"
      >
        <ChevronDown
          className={classNames("size-3.5 transition-transform", open && "rotate-180")}
        />
        {open ? "Hide" : "Show"} the domain taxonomy
      </button>
      {open ? (
        <div id="domains-taxonomy" className="mt-2">
          <AsyncPanel context="domain taxonomy" fallback={<PanelSkeleton height="md" />}>
            <DomainsRollup />
          </AsyncPanel>
        </div>
      ) : null}
    </section>
  );
}
