import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AnalyticsSection,
  CompositionBreakdown,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FilterField,
  FilterInput,
  FilterSelect,
  LoadMore,
  Raw,
  SectionNav,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { coverageQuery, surfacesInfiniteQuery } from "@/lib/metagraphed/queries";
import type { Surface } from "@/lib/metagraphed/types";
import type { CoverageCounts } from "@/components/metagraphed/apis/apis-logic";
import {
  apisNav,
  catalogFacts,
  facet,
  kindSegments,
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

  const feed = useInfiniteQuery({ ...surfacesInfiniteQuery(serverParams), retry: 0 });
  const coverage = useQuery({ ...coverageQuery(), retry: 0 });
  // The kind breakdown is of the WHOLE catalog, not of the current filter: a
  // composition that redraws itself to 100% of one kind whenever that kind is
  // selected is a chart of the filter, not of the network.
  const all = useInfiniteQuery({ ...surfacesInfiniteQuery({ limit: 500 }), retry: 0 });

  const surfaces = useMemo(
    () => (feed.data?.pages ?? []).flatMap((page) => page.data) as Surface[],
    [feed.data],
  );
  const catalogue = useMemo(
    () => (all.data?.pages ?? []).flatMap((page) => page.data) as Surface[],
    [all.data],
  );
  const segments = useMemo(() => kindSegments(catalogue), [catalogue]);
  const kinds = useMemo(() => facet(catalogue, (s) => s.kind), [catalogue]);
  const providers = useMemo(() => facet(catalogue, (s) => s.provider), [catalogue]);
  // `matchesSurfaceFilters` over the server-narrowed rows: re-applying every
  // facet is harmless and keeps the predicate correct however the server
  // answers, and it is where the free-text `q` is actually applied.
  const rows = useMemo(
    () => surfaces.filter((surface) => matchesSurfaceFilters(surface, search)),
    [surfaces, search],
  );

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
    { key: "name", label: "Name", value: (row) => row.name ?? null },
    {
      key: "url",
      label: "URL",
      kind: "link",
      value: (row) => row.url ?? null,
      href: (row) => row.url,
      format: (value) => (typeof value === "string" ? value.replace(/^https?:\/\//, "") : "—"),
    },
    { key: "provider", label: "Provider", width: 150, value: (row) => row.provider ?? null },
    {
      key: "authority",
      label: "Authority",
      kind: "status",
      width: 140,
      value: (row) => (typeof row.authority === "string" ? row.authority : null),
    },
    {
      key: "auth",
      label: "Auth",
      kind: "status",
      width: 100,
      demote: true,
      value: (row) => (row.auth_required == null ? null : row.auth_required ? "required" : "open"),
    },
    {
      key: "curation",
      label: "Curation",
      width: 160,
      demote: true,
      value: (row) => (typeof row.curation_level === "string" ? row.curation_level : null),
    },
    {
      key: "verified",
      label: "Last verified",
      kind: "time",
      width: 130,
      demote: true,
      value: (row) => row.last_verified_at ?? null,
    },
  ];

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        name="APIs"
        sentence={
          <FactSentence>
            Every public interface this registry has verified.{" "}
            {catalogFacts(coverage.data?.data as CoverageCounts | undefined, segments.length, {
              count: formatNumber,
            }).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
        live={{
          updatedAt: (coverage.data?.data.generated_at as string | undefined) ?? null,
          source: "registry",
          onRefresh: () => void coverage.refetch(),
          refreshing: coverage.isFetching,
        }}
      />
      <SectionNav items={apisNav(pathname)} link={RouterLink} />

      <AnalyticsSection
        id="kinds"
        name="By kind"
        question="What kinds of interface the network publishes."
        visual={
          segments.length > 0 ? (
            <CompositionBreakdown
              segments={segments}
              formatValue={(value) => formatNumber(value)}
              legendCols={4}
              ariaLabel="Surfaces by kind"
              source="surface-kind"
              // The legend IS the rank grid -- it already prints rank, key,
              // count and share -- so a second grid beside it would be the
              // same twelve rows twice. A row narrows the catalog below rather
              // than navigating: the table is on this page.
              onActivate={(key) => setSearch({ kind: search.kind === key ? "" : key })}
            />
          ) : null
        }
        footnote="every catalogued surface · registry"
      />

      <AnalyticsSection
        id="catalog"
        name="Catalog"
        question="Every surface this registry has verified."
        visual={
          <DataTable
            id="catalog"
            rows={rows}
            columns={columns}
            rowKey={(row) => row.id}
            caption="Every verified surface"
            link={RouterLink}
            source="surface"
            storageKey="mg-apis-columns"
            loading={feed.isPending}
            search={{
              value: search.q,
              onChange: (q) => setSearch({ q }),
              placeholder: "Name, URL, provider or subnet",
            }}
            filters={
              <>
                <FilterField label="Kind">
                  <FilterSelect
                    value={search.kind}
                    onChange={(event) => setSearch({ kind: event.target.value })}
                  >
                    <option value="">Any kind</option>
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
                <FilterField label="Provider">
                  <FilterSelect
                    value={search.provider}
                    onChange={(event) => setSearch({ provider: event.target.value })}
                  >
                    <option value="">Any provider</option>
                    {providers.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </FilterSelect>
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
        }
        footnote={
          <>
            {`${formatNumber(rows.length)} shown · facets applied server-side · registry `}
            <LoadMore
              hasMore={feed.hasNextPage}
              isLoading={feed.isFetchingNextPage}
              onLoadMore={() => void feed.fetchNextPage()}
              shown={surfaces.length}
              error={feed.error}
            />
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
