import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { SubnetsSearch } from "./subnets.index";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getTaoMarket } from "@/lib/metagraphed/market.functions";
import { ChevronDown, Coins, Star } from "lucide-react";
import { RangeControl, type RangeOption, EntityHero, FactSentence } from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  PanelSkeleton,
  ProvenanceChip,
  QueryProgress,
  Panel,
} from "@/components/metagraphed/primitives";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { NetworkSubnetLifecycle } from "@/components/metagraphed/network-subnet-lifecycle";
import { EmptyState, Skeleton, StatUnavailable } from "@/components/metagraphed/states";
import { statPhase } from "@/lib/metagraphed/stat-phase";
import {
  BrandIcon,
  prefetchBrandIcon,
  DataTable,
  Provenance,
  BackToTop,
  type DataTableColumn,
  type SortState,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useInView } from "@/hooks/use-in-view";
import { FilterChip, ResetFiltersButton } from "@/components/metagraphed/table-controls";
import { SubnetsSavedViews } from "@/components/metagraphed/subnets-saved-views";
import {
  SubnetsCompareDrawer,
  CompareToggle,
} from "@/components/metagraphed/subnets-compare-drawer";
import {
  SUBNETS_ALL_LIMIT,
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
  formatUsdApprox,
  isStaleFreshness,
  subnetAgeDays,
  formatSubnetAge,
} from "@/lib/metagraphed/format";
import { SubnetCategoryLinks } from "@/components/metagraphed/subnet-category-links";
import { HubSections, hubLede } from "@/components/metagraphed/hub-prose";
import { joinEconomics, joinHealth, matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { API_BASE } from "@/lib/metagraphed/config";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { LeaderboardsSection, LeaderboardsCsvExportMenu } from "./-leaderboards-page";
import { DomainsRollup } from "@/components/metagraphed/domains-rollup";
import { SubnetIndexDirectory } from "@/components/metagraphed/subnet-index-directory";
import type { AgentCatalogSummary, Subnet, SubnetEconomics } from "@/lib/metagraphed/types";
import { cancelIdle, requestIdle } from "@/lib/metagraphed/idle";
import { readKey, readNumber } from "@/lib/metagraphed/read-key";

// #8248: fetch every active subnet in one shot instead of cursor-paginating --
// the whole list (129 rows) renders as one unpaginated table, so there is no
// "Load more" tier anymore. 200 comfortably exceeds the live subnet count
// (verified: GET /api/v1/subnets?limit=200 already returns all 129 with
// next_cursor: null) with headroom for registry growth.

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

/**
 * Which `SubnetRow` field each sortable column ranks by. The table's sort
 * state lives in the URL (`?sort=&order=`) and is applied by `sortBy` over the
 * full fetched set, so the column key and the row field are separate things:
 * the header says "Age", the ranking is by `registered_at_block`.
 *
 * A column absent from this map renders a plain, non-interactive header.
 */
const SUBNET_SORT_FIELD: Record<string, string> = {
  netuid: "netuid",
  name: "name",
  symbol: "symbol",
  curation: "curation_level",
  surfaces: "surfaces_count",
  readiness: "integration_readiness",
  registration: "registration_cost_tao",
  emission: "emission_share",
  alphaPrice: "alpha_price_tao",
  totalStake: "total_stake_tao",
  marketCap: "alpha_market_cap_tao",
  participants: "participants",
  updated: "updated_at",
  health: "health",
  age: "registered_at_block",
};

/**
 * A signed percentage rendered through `formatNumber` — rounded by arithmetic
 * rather than `toFixed`, so every figure on the page goes through the same
 * formatter.
 */
function percentLabel(fraction: number, places = 2): string {
  const factor = 10 ** places;
  const pct = Math.round(fraction * 100 * factor) / factor;
  return `${pct > 0 ? "+" : ""}${formatNumber(pct)}%`;
}

/** `formatTao`'s magnitude tiering, re-labelled with a subnet's own α symbol. */
function formatAlpha(value: number | null | undefined, symbol: string): string {
  const tao = formatTao(value);
  return tao === "—" || symbol === "τ" ? tao : tao.replace(/τ$/, symbol);
}

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
  const search = useSearch({ from: "/subnets/" }) as SubnetsSearch;
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
      search: {},
      replace: true,
    });
  const setSection = (section: "registry" | "rankings") =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, section }),
      resetScroll: false,
    });
  const setWindow = (window: "7d" | "30d") =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, window }),
      replace: true,
      resetScroll: false,
    });
  return (
    <AppShell>
      <EntityHero
        name="Subnets"
        action={
          // The registry table carries its own CSV + copy-link in the table
          // menu; Rankings has no table of its own, so it keeps its export here.
          search.section === "rankings" ? (
            <div className="mg-actions">
              <LeaderboardsCsvExportMenu win={search.window} />
            </div>
          ) : (
            <div className="mg-actions">
              <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
            </div>
          )
        }
        sentence={<FactSentence>{hubLede("/subnets")}</FactSentence>}
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
          <AsyncPanel context="subnets" fallback={<Skeleton className="h-80 w-full" />}>
            <SubnetsTable />
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
          {/* #10300: network-wide registration/deregistration was published
              and rendered nowhere. It belongs beside the registry table --
              "which subnets came and went" is the same question the table
              answers as a snapshot. */}
          <section className="mt-8">
            <h2 className="mb-2 text-11 text-ink-muted">Registration churn</h2>
            <NetworkSubnetLifecycle />
          </section>
          {/* #11204: a flat, prose-shaped A–Z of every subnet. The table above
              now renders every row unpaginated (so it too carries an anchor per
              subnet), but this index survives it — see the component for why it
              is not a duplicate of the table. */}
          <AsyncPanel
            context="subnet index"
            fallback={<PanelSkeleton height="sm" className="mt-8" />}
          >
            <SubnetIndexDirectory />
          </AsyncPanel>
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
            : ["/api/v1/subnets", "/api/v1/domains", "/api/v1/chain/subnet-lifecycle"]
        }
        artifacts={search.section === "rankings" ? undefined : ["/metagraph/subnets.json"]}
      />
      {/*
        #11316 / #11342: REAL anchors, not prose naming a path. Sitemap-only is
        the profile that lands a URL in "Crawled - currently not indexed"
        (#11277), and every faceted page needs an inbound link from the hub it
        filters. The category list is derived from the rendered rows, so a
        category the registry stops deriving stops being linked.
      */}
      <SubnetCategoryLinks />
      <p className="mt-8 text-13 text-ink-muted">
        Looking for the ones you can integrate with?{" "}
        <Link to="/subnets/with-api" className="text-accent-text hover:underline">
          Subnets publishing a machine-readable API spec
        </Link>
        .
      </p>
      {/* Below the table on purpose -- see hub-prose.tsx. */}
      <HubSections path="/subnets" />
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
  const economicsPhase = statPhase(economicsRes);
  const economicsRows = economicsRes.data?.data ?? [];
  const totalStake = economicsRows.reduce((sum, e) => sum + (e.total_stake_alpha ?? 0), 0);
  const generatedAt = coverageRes.data.meta?.generated_at ?? healthRes.data.meta?.generated_at;
  const stale = isStaleFreshness(generatedAt);
  const totalStakeFigure =
    economicsPhase === "pending" ? (
      <Skeleton className="h-4 w-16" />
    ) : economicsPhase === "error" ? (
      <StatUnavailable variant="inline" />
    ) : economicsRows.length === 0 ? (
      "—"
    ) : (
      <>
        <Coins className="size-3.5 text-accent" aria-hidden />
        {formatTao(totalStake)}
      </>
    );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-11 text-ink-muted">
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
          {totalStakeFigure}
        </span>
      </span>
      {stale ? (
        <>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span className="inline-flex items-center rounded border border-health-warn/40 bg-health-warn/10 px-1.5 py-0.5 text-13 text-health-warn">
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
  const search = useSearch({ from: "/subnets/" }) as SubnetsSearch;
  if (domains.length === 0) return null;
  const sorted = [...domains].sort((a, b) => (b.subnet_count ?? 0) - (a.subnet_count ?? 0));
  return (
    <Panel className="mt-6">
      <div className="mb-2 text-13 text-ink-muted">Domains</div>
      <div className="flex flex-wrap gap-2">
        {sorted.map((d) => {
          const active = search.domain === d.domain;
          return (
            <button
              key={d.domain}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    domain: active ? "" : d.domain,
                  }),
                  replace: true,
                })
              }
              aria-pressed={active}
              className={classNames(
                "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-10 transition-colors",
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
}: {
  hidden: boolean;
  onToggle: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      className={classNames(
        "text-13 inline-flex min-h-9 items-center gap-1.5 rounded border px-2 py-1 transition-colors",
        hidden
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border bg-card text-ink-muted hover:text-ink-strong",
      )}
    >
      {/* `.mg-dot` is already the 8x8 round status dot; the Tailwind size +
          radius utilities that used to sit here only fought it. */}
      <span className={classNames("mg-dot", hidden && "bg-accent")} />
      {label}
      {count > 0 ? <span className="text-ink-muted">· {count}</span> : null}
    </button>
  );
}

/**
 * Local mirror of the URL-backed search box, debounced: writing `?q=` on every
 * keystroke changes the list query's key and re-suspends the table mid-word.
 */
function useDebouncedFilter(
  value: string,
  commit: (next: string) => void,
  delayMs = 200,
): [string, (next: string) => void] {
  const [text, setText] = useState(value);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  // A reset button or a back navigation changes the URL from outside; the
  // input follows it rather than fighting it.
  useEffect(() => {
    setText(value);
  }, [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = window.setTimeout(() => commitRef.current(text), delayMs);
    return () => window.clearTimeout(timer);
  }, [text, value, delayMs]);
  return [text, setText];
}

function SubnetsTable() {
  const search = useSearch({ from: "/subnets/" }) as SubnetsSearch;
  const navigate = useNavigate({ from: "/subnets/" });
  // Local trend window powering the per-row Price/Stake/MCap trend figures +
  // tone. Not URL-persisted (view chrome, not a filter over the row set).
  const [trendWindow, setTrendWindow] = useState<"7d" | "30d" | "90d">("7d");

  // #8248: one-shot fetch of every active subnet -- no pagination, no
  // "Load more". /api/v1/subnets supports only q + limit server-side (`sort`
  // returns HTTP 400, `curation`/`health` are ignored) -- everything else is
  // applied client-side over this one page.
  const { data, isFetching } = useSuspenseQuery(
    subnetsQuery({ q: search.q || undefined, limit: SUBNETS_ALL_LIMIT }),
  );

  const watchlist = useWatchlist("subnet");
  const { isWatched, toggle: toggleWatch, count: watchedCount } = watchlist;

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

  // #6270: how many rows the root toggle would drop, surfaced on the toggle
  // itself so it answers "what am I hiding?" before you press it. Counted over
  // the full joined set, independent of the other filters.
  const rootCount = useMemo(
    () => all.filter((s) => s.subnet_type === "root" || s.netuid === 0).length,
    [all],
  );

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const [queryText, setQueryText] = useDebouncedFilter(search.q, (next) => setSearch({ q: next }));

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
        if (search.watched && !isWatched(s.netuid)) return false;
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
      isWatched,
    ],
  );
  // Smarter default: when the user hasn't clicked a column, sort by market cap
  // (descending) so the highest-signal rows land at the top — matches how every
  // real block explorer opens. An explicit `search.sort` always wins.
  const effectiveSort = search.sort || "alpha_market_cap_tao";
  const effectiveOrder: "asc" | "desc" = search.sort ? search.order : "desc";
  const rows = useMemo(
    () => sortBy(filtered, effectiveSort, effectiveOrder, (row, key) => readKey(row, key)),
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
    const handle = requestIdle(() => {
      for (const s of rows)
        prefetchBrandIcon(s.website, 32, {
          iconUrl: s.icon_url,
          repoUrl: s.repo,
          lookup: { netuid: s.netuid },
        });
    });
    return () => cancelIdle(handle);
  }, [rows]);

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

  // #8248: quick-tabs replace the old health-only tone toggle. "All" clears
  // every quick-tab field at once; the other four each own a specific
  // combination of watched/kind/health, chosen to reuse fields the granular
  // filter row (below) already reads/writes -- one source of truth per
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
  const quickTabOptions: RangeOption<QuickTab>[] = [
    { value: "", label: "All" },
    { value: "watched", label: watchedCount > 0 ? `Watched · ${watchedCount}` : "Watched" },
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
    <div className="flex flex-wrap items-center gap-2">
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
      <ExcludeToggle
        hidden={!search.includeRoot}
        onToggle={() => setSearch({ includeRoot: !search.includeRoot })}
        label="Hide root"
        count={rootCount}
      />
    </div>
  );

  // Every column the registry table shows. The long tail (symbol, surfaces,
  // source, profile, reg. cost, market cap, updated, participants, lifecycle)
  // is `demote`d — off until the reader turns it on in the table menu, which
  // persists the choice.
  //
  // Name leads, not UID: `rowHref` puts the row's link on the FIRST visible
  // cell, so whichever column sits there must not carry a link of its own
  // (an <a> inside an <a> is not valid markup, and the inner one wins the
  // click). Leading with the name makes the row link land on the cell a
  // reader would aim at anyway.
  const columns = useMemo<Array<DataTableColumn<SubnetRow>>>(
    () => [
      {
        key: "name",
        label: "Name",
        width: 240,
        sortable: true,
        value: (s) => s.name ?? `Subnet ${s.netuid}`,
        render: (s) => (
          <span className="inline-flex items-center gap-2 font-medium text-ink-strong">
            <BrandIcon
              url={s.website}
              repoUrl={s.repo}
              iconUrl={s.icon_url}
              netuid={s.netuid}
              name={s.name}
              fallback={s.netuid}
              size={20}
            />
            <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
          </span>
        ),
      },
      {
        key: "netuid",
        label: "UID",
        width: 80,
        sortable: true,
        value: (s) => s.netuid,
        format: (value) => String(value).padStart(3, "0"),
      },
      {
        key: "alphaPrice",
        label: "Price (α)",
        kind: "number",
        width: 128,
        sortable: true,
        value: (s) => s.alpha_price_tao ?? null,
        render: (s) => (
          <TrendValue
            netuid={s.netuid}
            field="alpha_price_tao"
            current={s.alpha_price_tao}
            usdPerTao={taoUsd}
            window={trendWindow}
          />
        ),
      },
      {
        key: "priceChange",
        label: `${trendWindow} %`,
        align: "right",
        width: 96,
        // The change is derived per row from the trajectory series, not a
        // field on the row, so there is nothing here to sort or export.
        value: () => null,
        render: (s) => (
          <PctChangeValue netuid={s.netuid} current={s.alpha_price_tao} window={trendWindow} />
        ),
      },
      {
        key: "emission",
        label: "Emission",
        // #8746: stage-1 price share, not TAO received.
        kind: "number",
        width: 109,
        sortable: true,
        value: (s) => (s.emission_share == null ? null : s.emission_share * 100),
        format: (value) =>
          typeof value === "number" ? `${formatNumber(Math.round(value * 1000) / 1000)}%` : "—",
      },
      {
        key: "totalStake",
        demote: true,
        label: "Total stake",
        kind: "number",
        width: 123,
        sortable: true,
        value: (s) => s.total_stake_tao ?? null,
        render: (s) => (
          <TrendValue
            netuid={s.netuid}
            field="total_stake_tao"
            current={s.total_stake_tao}
            window={trendWindow}
            symbol={s.netuid === 0 ? "τ" : (s.symbol ?? "α")}
          />
        ),
      },
      {
        key: "health",
        label: "Health",
        kind: "status",
        width: 118,
        sortable: true,
        value: (s) => s.health ?? null,
      },
      {
        key: "age",
        demote: true,
        label: "Age",
        align: "right",
        width: 120,
        sortable: true,
        // #6643: estimated from the already-fetched registered_at_block/block
        // delta -- no new backend call.
        value: (s) => subnetAgeDays(s.registered_at_block, s.block),
        format: (value) => formatSubnetAge(typeof value === "number" ? value : null),
      },
      {
        key: "marketCap",
        label: "Market cap",
        kind: "number",
        width: 130,
        demote: true,
        sortable: true,
        value: (s) => s.alpha_market_cap_tao ?? null,
        render: (s) => (
          <TrendValue
            netuid={s.netuid}
            field="alpha_market_cap_tao"
            current={s.alpha_market_cap_tao}
            usdPerTao={taoUsd}
            window={trendWindow}
          />
        ),
      },
      {
        key: "registration",
        label: "Reg. cost",
        kind: "number",
        width: 110,
        demote: true,
        sortable: true,
        value: (s) => s.registration_cost_tao ?? null,
        render: (s) => (
          <span
            className={classNames(
              "tabular-nums",
              // #3364: dim the cost only when registration is explicitly
              // closed. `registration_allowed === undefined` (economics entry
              // present but flag absent, or no entry at all) keeps the neutral
              // tone — do NOT read it as "open".
              s.registration_allowed === false ? "text-ink-muted" : "text-ink",
            )}
          >
            {formatTao(s.registration_cost_tao)}
          </span>
        ),
      },
      {
        key: "symbol",
        label: "Symbol",
        width: 90,
        demote: true,
        sortable: true,
        value: (s) => s.symbol ?? null,
      },
      {
        key: "surfaces",
        label: "Surfaces",
        align: "right",
        width: 100,
        demote: true,
        sortable: true,
        value: (s) => s.surfaces_count ?? 0,
        render: (s) => <SurfacesCell subnet={s} />,
      },
      {
        key: "curation",
        label: "Source",
        width: 110,
        demote: true,
        sortable: true,
        value: (s) => s.curation_level ?? null,
        render: (s) => <ProvenanceChip level={s.curation_level} />,
      },
      {
        key: "readiness",
        label: "Profile",
        kind: "number",
        width: 110,
        demote: true,
        sortable: true,
        value: (s) => s.integration_readiness ?? null,
        format: (value) =>
          typeof value === "number" ? `${formatNumber(Math.round(value))}/100` : "—",
      },
      {
        key: "updated",
        label: "Updated",
        kind: "time",
        align: "right",
        width: 120,
        demote: true,
        sortable: true,
        value: (s) => s.updated_at ?? s.freshness ?? null,
      },
      {
        key: "participants",
        label: "Participants",
        kind: "number",
        width: 115,
        demote: true,
        sortable: true,
        value: (s) => s.participants ?? null,
        format: (value) => formatNumber(typeof value === "number" ? value : null),
      },
      {
        key: "lifecycle",
        label: "Lifecycle",
        width: 110,
        demote: true,
        value: (s) => s.lifecycle ?? null,
      },
      {
        key: "watch",
        demote: true,
        label: "Watch",
        width: 60,
        value: (s) => (isWatched(s.netuid) ? "watched" : ""),
        render: (s) => (
          <button
            type="button"
            onClick={() => toggleWatch(s.netuid)}
            aria-pressed={isWatched(s.netuid)}
            aria-label={
              isWatched(s.netuid)
                ? `Remove SN${s.netuid} from watchlist`
                : `Add SN${s.netuid} to watchlist`
            }
            className="mg-tap-target flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong"
          >
            <Star
              className={classNames("size-3.5", isWatched(s.netuid) && "fill-accent text-accent")}
            />
          </button>
        ),
      },
      {
        key: "compare",
        demote: true,
        label: "Compare",
        width: 70,
        value: () => null,
        render: (s) => <CompareToggle netuid={s.netuid} />,
      },
    ],
    [trendWindow, taoUsd, isWatched, toggleWatch],
  );

  const sortedKey = Object.keys(SUBNET_SORT_FIELD).find(
    (key) => SUBNET_SORT_FIELD[key] === effectiveSort,
  );
  const sortState: SortState | null = sortedKey ? { key: sortedKey, dir: effectiveOrder } : null;

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

  return (
    <div id="subnets-list" className="relative">
      <QueryProgress active={isFetching} position="sticky" />
      <DataTable
        caption="Subnets"
        rows={rows}
        columns={columns}
        rowKey={(s) => String(s.netuid)}
        // #11204: a crawler does not run our JavaScript, so every subnet page
        // needs its anchor in the bytes the server sends. `paginate={false}`
        // keeps all 129 rows in the server-rendered HTML; the bounded viewport
        // is what keeps the page short.
        paginate={false}
        rowHref={(s) => `/subnets/${s.netuid}`}
        link={RouterLink}
        storageKey="subnets"
        source="subnet"
        sort={sortState}
        onSort={(next) => {
          const field = next ? SUBNET_SORT_FIELD[next.key] : undefined;
          setSearch({ sort: field ?? "", order: field && next ? next.dir : "asc" });
        }}
        search={{
          value: queryText,
          onChange: setQueryText,
          placeholder: "netuid, name, or symbol",
        }}
        filters={
          <>
            <div className="hidden sm:flex items-center">
              <RangeControl
                options={quickTabOptions}
                value={quickTab}
                onChange={(v: QuickTab) => onQuickTab(v)}
                label="Quick filter"
                className="border-0 bg-transparent"
              />
            </div>
            <RangeControl
              options={[
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
                { value: "90d", label: "90d" },
              ]}
              value={trendWindow}
              onChange={(v: "7d" | "30d" | "90d") => setTrendWindow(v)}
              label="Trend window for row trend figures"
              className="border-0 bg-transparent"
            />
            {secondaryFilters}
          </>
        }
        empty={emptyNode}
      />
    </div>
  );
}

// #8248: trend-window % change as its own column, distinct from the value
// shown in the Price column -- same trajectory source TrendValue already reads
// for alpha_price_tao (react-query dedupes the fetch, this isn't a second
// network call), just rendered as a standalone colored figure instead of a
// sub-line under the price.
function PctChangeValue({
  netuid,
  current,
  window: win,
}: {
  netuid: number;
  current?: number;
  window: "7d" | "30d" | "90d";
}) {
  const [cellRef, inView] = useInView<HTMLSpanElement>();
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
    <span ref={cellRef} className={classNames("tabular-nums", toneClass)}>
      {delta == null ? "—" : percentLabel(delta)}
    </span>
  );
}

/* ---------- Row visualization cells ---------- */

const ALPHA_MAX_SUPPLY = 21_000_000;

/**
 * A financial figure with its trend: the current value, the USD equivalent
 * where there is a live TAO price, and the window's % change, toned up/down.
 */
function TrendValue({
  netuid,
  field,
  current,
  window: win,
  usdPerTao,
  symbol,
}: {
  netuid: number;
  field: "alpha_price_tao" | "total_stake_tao" | "alpha_market_cap_tao";
  current?: number;
  window: "7d" | "30d" | "90d";
  usdPerTao?: number;
  symbol?: string;
}) {
  const usesTrajectory = field === "alpha_price_tao" || field === "alpha_market_cap_tao";
  // Trend data is per-netuid (react-query can't dedupe across rows), and a
  // page can hold up to 200 rows — fetch only once a row has actually
  // scrolled into view instead of firing a query for every mounted row.
  const [cellRef, inView] = useInView<HTMLSpanElement>();
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
  const displayValue = last ?? current;
  const usd = formatUsdApprox(displayValue, usdPerTao);
  const pct = tone === "flat" ? null : percentLabel(delta);
  return (
    <span ref={cellRef} className="inline-flex flex-col items-end tabular-nums">
      <span className={toneClass}>{formatAlpha(displayValue, symbol ?? "τ")}</span>
      {usd != null || pct ? (
        <span className="flex items-center justify-end gap-1 text-10 text-ink-muted/80">
          {usd != null ? <span>{usd}</span> : null}
          {pct ? <span className={toneClass}>{pct}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function SurfacesCell({ subnet }: { subnet: Subnet }) {
  const count = subnet.surfaces_count ?? 0;
  const num = (k: string) => readNumber(subnet, k) ?? 0;
  const byKind = (readKey(subnet, "surfaces_by_kind") ?? readKey(subnet, "surface_kinds")) as
    Record<string, number> | undefined;
  // Prefer a real per-kind breakdown if the list API ever exposes one; otherwise
  // show the surface-trust composition (official / registry-observed / other) —
  // the list API always carries these counts, so the bar is a meaningful
  // breakdown instead of a flat single-segment placeholder.
  const official = num("official_surface_count");
  const observed = num("registry_observed_count");
  const trust = [
    { label: "official", value: official },
    { label: "observed", value: observed },
    { label: "other", value: Math.max(0, count - official - observed) },
  ];
  const summary = (
    byKind ? Object.entries(byKind) : (trust.map((t) => [t.label, t.value]) as [string, number][])
  )
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

  return (
    <Provenance
      metric={byKind ? "Surface kinds" : "Surface trust"}
      source={`Verified public surfaces for SN${subnet.netuid}${byKind ? ", grouped by kind" : ", by trust tier (official / registry-observed)"}.${summary ? ` — ${summary}` : ""}`}
      windowLabel="latest snapshot"
      updatedAt={subnet.updated_at ?? subnet.freshness ?? null}
      staleness="Unverified candidates are excluded from the count; the bar shows the trust composition of manifested surfaces."
    >
      <span className="font-mono text-13 tabular-nums text-ink">{count || "—"}</span>
    </Provenance>
  );
}

/**
 * Registry / Rankings switch (#8311). Two sections, so a plain two-button
 * strip rather than a section nav -- there's no overflow to
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
    <RangeControl
      label="Subnets sections"
      options={[
        { value: "registry", label: "Registry" },
        { value: "rankings", label: "Rankings" },
      ]}
      value={section}
      onChange={onChange}
      className="mb-4"
    />
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
        className="mg-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded px-1 py-1 text-13 font-medium text-ink-muted transition-colors hover:text-ink-strong"
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
