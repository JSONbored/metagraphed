import { useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AnalyticsSection,
  BrandIcon,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  LeaderCards,
  Raw,
  SectionNav,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { factCells } from "@/lib/metagraphed/facts";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import { providersQuery, sourceHealthProvidersQuery } from "@/lib/metagraphed/queries";
import { apisNav } from "@/components/metagraphed/apis/apis-logic";
import {
  facet,
  filterProviders,
  initials,
  providerFacts,
  providerLeaders,
  providerRows,
  type ProviderRow,
} from "@/components/metagraphed/providers/providers-logic";
import { Route } from "./apis.providers";

const API_PATHS = ["/api/v1/providers", "/api/v1/source-health"];
const LEADER_PREVIEW = 3;

function ApiSources() {
  useRegisterApiSource(API_PATHS, ["/metagraph/providers.json"]);
  return null;
}

/**
 * Providers (#11624) — two sections.
 *
 * What went: a Table/Grid toggle over an 11,900px wall of 136 cards, a
 * `Download CSV · Share view` bar the table menu already carries, four count
 * boxes, a `SOURCE HEALTH` line above the table (it is a hero fact), and a
 * search bar outside the table (the table has one).
 */
export function ProvidersPage() {
  const [leadersExpanded, setLeadersExpanded] = useState(false);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/apis/providers" });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  /**
   * `useSuspenseQuery`, so the rows exist in the SERVER-RENDERED HTML.
   *
   * `crawlable-subnet-index.spec.ts` asserts that /apis/providers links to
   * every provider page in the raw response, because a crawler is the reason
   * those 138 detail pages are indexable at all. A client-only `useQuery`
   * ships an empty table to the first paint and to every bot, which is
   * exactly the defect #11204 measured. The source-health join stays
   * client-side: it colours a column and links nothing.
   */
  const providers = useSuspenseQuery(providersQuery());
  const health = useQuery({ ...sourceHealthProvidersQuery(), retry: 0 });

  const rows = useMemo(
    () => providerRows(providers.data?.data, health.data?.data.providers),
    [providers.data, health.data],
  );
  const shown = useMemo(() => filterProviders(rows, search), [rows, search]);
  const kinds = useMemo(() => facet(rows, (row) => row.kind), [rows]);
  const authorities = useMemo(() => facet(rows, (row) => row.authority), [rows]);
  const leaders = useMemo(() => providerLeaders(rows), [rows]);
  const shownLeaders = leadersExpanded ? leaders : leaders.slice(0, LEADER_PREVIEW);

  const columns: DataTableColumn<ProviderRow>[] = [
    {
      key: "name",
      label: "Provider",
      kind: "link",
      width: 240,
      value: (row) => row.displayName,
      href: (row) => `/providers/${row.slug}`,
      render: (row) => (
        <span className="mg-dt-entity">
          {/* 20px, the size every other table cell uses. `BrandIcon` defaults
              to 32, which is the whole content box of a 56px row -- so a row
              with a mark came out 63px tall against 57px for one without, and
              the list rippled down the page (#11696). */}
          <BrandIcon
            size={20}
            iconUrl={row.iconUrl}
            name={row.name}
            providerSlug={row.slug}
            fallback={initials(row.name)}
          />
          {row.displayName}
        </span>
      ),
    },
    { key: "kind", label: "Kind", kind: "status", width: 150, value: (row) => row.kind },
    {
      key: "authority",
      label: "Authority",
      kind: "status",
      width: 170,
      value: (row) => row.authority,
    },

    {
      key: "subnets",
      label: "Subnets",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => row.netuids.length,
    },
    {
      key: "endpoints",
      label: "Endpoints",
      kind: "number",
      align: "right",
      width: 110,
      value: (row) => row.endpoints,
    },
    {
      key: "sources",
      label: "Sources",
      kind: "status",
      width: 130,
      value: (row) => row.sourceStatus,
    },
    {
      key: "surfaces",
      label: "Surfaces",
      kind: "number",
      align: "right",
      width: 110,
      value: (row) => row.surfaces,
    },
  ];

  /**
   * The host and the slug, under the row.
   *
   * The host took 391px of a 1310px table on a 1118px card and pushed Sources
   * off the right edge (#11696). It is a URL: something a reader copies or
   * follows, not something they scan down a column -- and the provider's name
   * in the lead cell already links to its page.
   */
  const providerDetail = (row: ProviderRow) => (
    <dl>
      {row.host ? (
        <div className="mg-raw-row">
          <dt>Host</dt>
          <dd>{row.host}</dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Slug</dt>
        <dd>{row.slug}</dd>
      </div>
    </dl>
  );

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--directory"
        name="Providers"
        sentence={
          <FactSentence>The teams and operators behind these public interfaces.</FactSentence>
        }
        // A STRIP, not chips (#11696). This page's subject is a table, and its
        // headline counts were 11px `Fact` chips inside the sentence -- set
        // smaller than the rows they frame. The lede stays prose.
        cells={
          factCells(
            providerFacts(rows, health.data?.data.summary, {
              count: formatNumber,
            }),
          ) ?? undefined
        }
        live={{
          // The payload's own timestamp, not a row's: /api/v1/providers
          // publishes `generated_at` once at the envelope and the rows carry
          // none, so reading `rows[0]` renders "Updated —" on a page that
          // knows exactly when it was built.
          updatedAt: health.data?.data.generated_at ?? rows[0]?.updatedAt ?? null,
          source: "registry",
          onRefresh: () => void Promise.all([providers.refetch(), health.refetch()]),
          refreshing: providers.isFetching || health.isFetching,
        }}
      />
      <SectionNav items={apisNav(pathname)} link={RouterLink} />

      <AnalyticsSection
        id="leaders"
        name="Leaders"
        question="Who serves the most endpoints."
        visual={
          leaders.length > 0 ? (
            <LeaderCards
              items={shownLeaders}
              featured={LEADER_PREVIEW}
              ariaLabel="Providers by endpoints served"
              source="provider"
            />
          ) : null
        }
        // No delta: `LeaderCards` draws one as a period-over-period change and
        // /api/v1/providers is a snapshot with no previous count to compare
        // against. A delta computed from anything else would look like growth
        // and not be.
        footnote={
          leadersExpanded || leaders.length <= LEADER_PREVIEW ? (
            "endpoints served · registry"
          ) : (
            <button
              type="button"
              className="mg-section-more"
              onClick={() => setLeadersExpanded(true)}
            >
              Show all {leaders.length}
            </button>
          )
        }
      />

      <AnalyticsSection
        id="directory"
        name="Directory"
        question="Every provider, and whether their sources still resolve."
        visual={
          <>
            {health.isError ? (
              <ErrorState
                error={health.error}
                onRetry={() => void health.refetch()}
                context="provider source verification"
              />
            ) : null}
            <DataTable
              id="providers"
              rows={shown}
              columns={columns}
              rowKey={(row) => row.slug}
              caption="Providers"
              rowHref={(row) => `/providers/${row.slug}`}
              link={RouterLink}
              source="provider"
              storageKey="mg-providers-columns"
              expand={providerDetail}
              loading={false}
              // Every row, not a first page of fifty: the crawlable-index gate
              // reads the SERVER-RENDERED HTML and 138 provider pages are
              // indexable only because this page links to them. The bounded
              // viewport still keeps the table one screen tall.
              paginate={false}
              search={{
                value: search.q,
                onChange: (q) => setSearch({ q }),
                placeholder: "Name, slug or host",
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
                  <FilterField label="Authority">
                    <FilterSelect
                      value={search.authority}
                      onChange={(event) => setSearch({ authority: event.target.value })}
                    >
                      <option value="">Any authority</option>
                      {authorities.map((authority) => (
                        <option key={authority} value={authority}>
                          {authority}
                        </option>
                      ))}
                    </FilterSelect>
                  </FilterField>
                </>
              }
              empty="No providers match these filters."
            />
          </>
        }
        footnote={
          health.isPending
            ? `${formatNumber(shown.length)} of ${formatNumber(rows.length)} · verifying sources · registry`
            : health.isError
              ? `${formatNumber(shown.length)} of ${formatNumber(rows.length)} · source verification unavailable · registry`
              : `${formatNumber(shown.length)} of ${formatNumber(
                  rows.length,
                )} · source health from the verification lane · registry`
        }
      />

      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/providers" />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
