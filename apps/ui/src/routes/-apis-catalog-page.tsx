import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterInput,
  LoadMore,
  RankedRails,
  Raw,
  SectionNav,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatAbsoluteTime, formatNumber, formatPct } from "@/lib/metagraphed/format";
import { coverageQuery, surfacesInfiniteQuery } from "@/lib/metagraphed/queries";
import type { Surface } from "@/lib/metagraphed/types";
import type { CoverageCounts } from "@/components/metagraphed/apis/apis-logic";
import {
  apisNav,
  catalogHeadlineFacts,
  interfaceCoverage,
} from "@/components/metagraphed/apis/apis-logic";
import { matchesSurfaceFilters } from "@/lib/metagraphed/surface-filters";
import { Route } from "./apis.index";

const API_PATHS = ["/api/v1/surfaces", "/api/v1/coverage"];

function ApiSources() {
  useRegisterApiSource(API_PATHS, ["/metagraph/surfaces.json"]);
  return null;
}

/**
 * The API catalog (#11622) — two sections and nothing else.
 *
 * What went: a `1h 24h 7d 30d` toolbar that drove no query on this page, a
 * Table/Grid toggle, a `Download CSV · Share view` bar the table menu already
 * carries, a per-page select, and the intro paragraph. The hub's tab strip
 * went with them: the four /apis routes are a `SectionNav` now, the same nav
 * every rebuilt page uses for its own sections.
 */
export function ApisCatalogPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/apis" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  /**
   * The facet filters go to the SERVER; only the free-text one stays here.
   *
   * /api/v1/surfaces takes kind, provider, netuid, auth_required, public_safe
   * and rate_limited, and the catalog is 3,391 rows deep — so filtering a
   * loaded prefix client-side would answer "14 openapi surfaces" from whatever
   * happened to be fetched, which is the shape of the #3975 bug in a new
   * place. It has no text search, so `q` is the one filter that must be
   * applied to the rows in hand, and the caption says how many are in hand.
   */
  const serverParams: Record<string, string | number> = { limit: 200 };
  if (search.kind) serverParams.kind = search.kind;
  if (search.provider) serverParams.provider = search.provider;
  if (search.netuid) serverParams.netuid = search.netuid;
  if (search.public_safe) serverParams.public_safe = "true";
  if (search.auth === "required") serverParams.auth_required = "true";
  if (search.auth === "none") serverParams.auth_required = "false";
  if (search.rate_limited) serverParams.rate_limited = "true";

  const coverage = useQuery({ ...coverageQuery(), retry: 0 });
  // Wait for the coverage instrument above this section to settle before
  // observing the catalog. Otherwise its shorter first-frame skeleton can
  // briefly put the catalog in view and start a 200-row read that the final
  // layout leaves below the fold.
  const { ref: catalogRef, nearViewport: catalogNearViewport } = useNearViewport(
    "0px 0px",
    !coverage.isPending,
  );
  const feed = useInfiniteQuery({
    ...surfacesInfiniteQuery(serverParams),
    enabled: catalogNearViewport,
    retry: 0,
  });
  const coverageData = coverage.data?.data as CoverageCounts | undefined;

  const surfaces = useMemo(
    () => (feed.data?.pages ?? []).flatMap((page) => page.data) as Surface[],
    [feed.data],
  );
  const coverageRows = useMemo(
    () =>
      interfaceCoverage(
        coverageData?.completeness?.dimension_coverage,
        coverageData?.chain_subnet_count,
      ),
    [coverageData],
  );
  // `matchesSurfaceFilters` over the server-narrowed rows: re-applying every
  // facet is harmless and keeps the predicate correct however the server
  // answers, and it is where the free-text `q` is actually applied.
  const rows = useMemo(
    () => surfaces.filter((surface) => matchesSurfaceFilters(surface, search)),
    [surfaces, search],
  );
  const refreshAll = () => {
    void Promise.all([coverage.refetch(), ...(catalogNearViewport ? [feed.refetch()] : [])]);
  };

  const columns: DataTableColumn<Surface>[] = [
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      width: 110,
      value: (row) => row.netuid ?? null,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "kind", label: "Kind", kind: "status", width: 130, value: (row) => row.kind ?? null },
    {
      // The name LEADS and links; the URL is under the row. Two identifier
      // columns side by side took 946px of a 1400px table on a 1118px card,
      // and the reader lost Provider and Authority off the right edge to a
      // horizontal scroll nothing announced (#11696).
      key: "name",
      label: "Name",
      kind: "link",
      width: 380,
      value: (row) => row.name ?? null,
      href: (row) => row.url,
    },
    { key: "provider", label: "Provider", width: 150, value: (row) => row.provider ?? null },
    {
      key: "authority",
      label: "Authority",
      kind: "status",
      width: 140,
      value: (row) => (typeof row.authority === "string" ? row.authority : null),
    },
  ];

  /** The URL and the three fields a reader checks once, under the row. */
  const surfaceDetail = (row: Surface) => (
    <dl>
      {row.url ? (
        <div className="mg-raw-row">
          <dt>URL</dt>
          <dd>{row.url}</dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Auth</dt>
        <dd>
          {row.auth_required == null ? "—" : row.auth_required ? "a key is required" : "open"}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Curation</dt>
        <dd>{typeof row.curation_level === "string" ? row.curation_level : "—"}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last verified</dt>
        <dd>{row.last_verified_at ? formatAbsoluteTime(row.last_verified_at) : "not verified"}</dd>
      </div>
    </dl>
  );

  const rawRows: RawRow[] = [
    ...API_PATHS.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
    // Probe one surface on demand. The table above reports what the last
    // scheduled probe found; this is how a reader checks a surface RIGHT NOW,
    // which is the question a stale "verified 6h ago" cell provokes.
    {
      label: "surfaces/{surface_id}/verify",
      value: `${API_BASE}/api/v1/surfaces/{surface_id}/verify`,
    },
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--directory"
        name="APIs"
        sentence={<FactSentence>Every public interface this registry has verified.</FactSentence>}
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(
            catalogHeadlineFacts(
              coverageData,
              coverageRows.length,
              coverage.isPending ? "pending" : coverage.isError ? "error" : "ready",
              { count: formatNumber },
            ),
          ) ?? undefined
        }
        live={{
          updatedAt: (coverageData?.generated_at as string | undefined) ?? null,
          source: "registry",
          onRefresh: refreshAll,
          refreshing: feed.isFetching || coverage.isFetching,
        }}
      />
      <SectionNav items={apisNav(pathname)} link={RouterLink} />

      <AnalyticsSection
        id="coverage"
        name="Interface coverage"
        question="How widely each public interface type is published."
        visual={
          coverage.isPending ? (
            <RankedRails
              items={[]}
              formatValue={(value) => `${formatNumber(value)} subnets`}
              columns={{
                value: "Subnets",
                name: "Interface",
                track: "Share of network",
              }}
              ariaLabel="Subnet coverage by public interface type"
              source="interface-coverage"
              loading
              loadingRows={7}
            />
          ) : coverage.isError ? (
            <ErrorState
              error={coverage.error}
              onRetry={() => void coverage.refetch()}
              context="published interface coverage"
            />
          ) : coverageRows.length > 0 ? (
            <RankedRails
              items={coverageRows.map((row) => ({
                ...row,
                detail: [
                  { key: "subnets", label: "Subnets", value: formatNumber(row.value) },
                  {
                    key: "coverage",
                    label: "Network coverage",
                    value: formatPct(row.share),
                  },
                ],
              }))}
              formatValue={(value) =>
                `${formatNumber(value)} / ${formatNumber(coverageData?.chain_subnet_count ?? 0)}`
              }
              max={coverageData?.chain_subnet_count}
              columns={{
                value: "Subnets",
                name: "Interface",
                track: "Share of network",
              }}
              ariaLabel="Subnet coverage by public interface type"
              source="interface-coverage"
            />
          ) : null
        }
        empty={coverage.isPending ? false : "No public interface coverage is published."}
        // Methodology does not change with query state. Keeping this note
        // stable also avoids replacing a short loading sentence with a
        // two-line settled sentence after the rails resolve on mobile.
        footnote="of all chain subnets · one subnet may publish more than one interface · registry"
      />

      <AnalyticsSection
        id="catalog"
        name="Catalog"
        question="Every surface this registry has verified."
        visualRef={catalogRef}
        visual={
          !catalogNearViewport ? (
            <p className="mg-section-empty">
              Verified interface rows load as this section approaches.
            </p>
          ) : (
            <DataTable
              id="catalog"
              rows={rows}
              columns={columns}
              rowKey={(row) => row.id}
              caption="Every verified surface"
              link={RouterLink}
              source="surface"
              storageKey="mg-apis-columns"
              expand={surfaceDetail}
              loading={feed.isPending}
              error={
                feed.isError ? (
                  <ErrorState
                    error={feed.error}
                    onRetry={() => void feed.refetch()}
                    context="verified interfaces"
                  />
                ) : undefined
              }
              search={{
                value: search.q,
                onChange: (q) => setSearch({ q }),
                placeholder: "Name, provider or subnet",
              }}
              filters={
                <>
                  <FilterField label="Kind">
                    <FilterInput
                      value={search.kind}
                      onChange={(event) => setSearch({ kind: event.target.value })}
                      placeholder="e.g. subnet-api"
                      leadingIcon={false}
                      aria-label="Surface kind"
                    />
                  </FilterField>
                  <FilterField label="Provider">
                    <FilterInput
                      value={search.provider}
                      onChange={(event) => setSearch({ provider: event.target.value })}
                      placeholder="provider slug"
                      leadingIcon={false}
                      aria-label="Surface provider"
                    />
                  </FilterField>
                  <FilterField label="Subnet">
                    <FilterInput
                      value={search.netuid}
                      onChange={(event) => setSearch({ netuid: event.target.value })}
                      placeholder="netuid"
                      inputMode="numeric"
                      leadingIcon={false}
                      aria-label="Subnet netuid"
                    />
                  </FilterField>
                </>
              }
              empty="No surfaces match these filters."
            />
          )
        }
        footnote={
          <>
            {!catalogNearViewport
              ? "deferred below the fold · verified interface rows start only as this section approaches "
              : feed.isPending
                ? "Loading verified interfaces · registry "
                : feed.isError
                  ? "Verified interfaces are temporarily unavailable · registry "
                  : `${formatNumber(rows.length)} shown · facets applied server-side · registry `}
            {/* A cursor feed has no terminal range to repeat beneath the table. */}
            {feed.hasNextPage || (feed.error && surfaces.length > 0) ? (
              <LoadMore
                hasMore={feed.hasNextPage}
                isLoading={feed.isFetchingNextPage}
                onLoadMore={() => void feed.fetchNextPage()}
                shown={surfaces.length}
                error={feed.error}
              />
            ) : null}
          </>
        }
      />

      {/* #11320: below the data on purpose -- see hub-prose.tsx. The hero's
          blurb went; this did not, because it is what makes the page an answer
          to a category query rather than a table with a title. */}
      <HubSections path="/apis" />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
