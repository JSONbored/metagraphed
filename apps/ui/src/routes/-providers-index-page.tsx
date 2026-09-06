import { useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticsSection,
  BrandIcon,
  CopyableCode,
  DataTable,
  EntityHero,
  FactSentence,
  FilterField,
  FilterSelect,
  LeaderCards,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { ApiNavigation } from "@/components/metagraphed/apis/api-navigation";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ErrorState } from "@/components/metagraphed/states";
import { factCells } from "@/lib/metagraphed/facts";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";
import { formatNumber } from "@/lib/metagraphed/format";
import { providersQuery, sourceHealthProvidersQuery } from "@/lib/metagraphed/queries";
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
    <dl className="[&>.mg-raw-row]:grid-cols-1! [&>.mg-raw-row]:gap-1! sm:[&>.mg-raw-row]:grid-cols-[180px_minmax(0,1fr)]!">
      {row.host ? (
        <div className="mg-raw-row">
          <dt>Host</dt>
          <dd className="min-w-0">
            <CopyableCode
              value={row.host}
              label="provider URL"
              truncate={false}
              className="min-h-11 [&>span:first-child]:sr-only"
            />
          </dd>
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
          // Registry publication metadata dates this catalog capture.
          // Source-health observations have their own independent clock.
          updatedAt: recordModifiedAt(providers.data.meta) ?? null,
          source: "registry",
          onRefresh: () => void Promise.all([providers.refetch(), health.refetch()]),
          refreshing: providers.isFetching || health.isFetching,
        }}
      />
      <ApiNavigation />

      <AnalyticsSection
        id="directory"
        name="Directory"
        question="Every provider, and whether their sources still resolve."
        visual={
          <>
            {providers.isRefetchError ? (
              <ErrorState
                error={providers.error}
                onRetry={() => void providers.refetch()}
                context="provider registry refresh"
              />
            ) : null}
            {health.isError ? (
              <ErrorState
                error={health.error}
                onRetry={() => void health.refetch()}
                context="provider source verification"
              />
            ) : null}
            <div className="mb-4 grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label className="col-span-2 grid min-w-0 gap-2 text-11 text-ink-muted lg:col-span-1">
                Search providers
                <input
                  type="search"
                  placeholder="Name, slug or host"
                  className="min-h-11 w-full border border-border bg-canvas px-3 text-13 text-ink-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                  value={search.q}
                  onChange={(event) => void setSearch({ q: event.target.value })}
                />
              </label>
              {(
                [
                  ["kind", "Kind", kinds],
                  ["authority", "Authority", authorities],
                ] as const
              ).map(([key, label, values]) => (
                <FilterField
                  key={key}
                  label={label}
                  className="min-w-0 gap-2 [&>span]:not-sr-only [&>span]:text-11 [&>span]:text-ink-muted"
                >
                  <FilterSelect
                    className="min-h-11 w-full min-w-0 appearance-auto!"
                    value={search[key]}
                    onChange={(event) => void setSearch({ [key]: event.target.value })}
                  >
                    <option value="">Any {label.toLowerCase()}</option>
                    {search[key] && !values.includes(search[key]) ? (
                      <option value={search[key]}>{search[key]}</option>
                    ) : null}
                    {values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </FilterSelect>
                </FilterField>
              ))}
            </div>
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
              className="max-lg:[&_.mg-dt-expansion>td]:px-4! [&_td[data-mobile-lead=true]]:before:hidden [&_.mg-dt-status]:self-start [&_.mg-dt-disclosure]:min-h-11 [&_.mg-dt-disclosure]:min-w-11 [&_.mg-dt-menu-trigger]:min-h-11 [&_.mg-dt-menu-trigger]:min-w-11"
              mobile="cards"
              compactMobileLabels
              empty={
                <span>
                  No providers match these filters.{" "}
                  <button
                    type="button"
                    className="min-h-11 text-accent underline"
                    onClick={() => void setSearch({ q: "", kind: "", authority: "" })}
                  >
                    Reset filters
                  </button>
                </span>
              }
            />
          </>
        }
        footnote={
          health.isPending
            ? `${formatNumber(shown.length)} matching of ${formatNumber(rows.length)} loaded providers · verifying sources · registry`
            : health.isError
              ? `${formatNumber(shown.length)} matching of ${formatNumber(rows.length)} loaded providers · source verification unavailable · registry`
              : `${formatNumber(shown.length)} matching of ${formatNumber(
                  rows.length,
                )} loaded providers · source health from the verification lane · registry`
        }
      />

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
              className="mg-section-more min-h-11"
              onClick={() => setLeadersExpanded(true)}
            >
              Show all {leaders.length}
            </button>
          )
        }
      />

      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/providers" />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
