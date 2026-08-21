import { useMemo } from "react";
import type { RevenueSearch } from "./revenue";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Chip,
  DefinitionList,
  ListShell,
  MetaStrip,
  MetricGrid,
  StatTile,
} from "@jsonbored/ui-kit";
import { Route } from "./revenue";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  DataPageCanvas,
  DataPageDisclosure,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  FilterSelect,
  GhostButton,
  Panel,
} from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState, EmptyState } from "@/components/metagraphed/states";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import { chainRevenueCoverageQuery } from "@/lib/metagraphed/queries";
import {
  COVERAGE_SORT_FIELDS,
  HEADLINE_TIERS,
  notObservedNote,
  partitionAndSort,
  provenanceOptions,
  toCoverageRows,
  type CoverageRow,
  type CoverageSortField,
} from "@/lib/metagraphed/coverage-leaderboard-model";
import {
  coverageLabel,
  subsidyLabel,
  tierLabel,
  usdLabel,
} from "@/lib/metagraphed/revenue-panel-model";

const TABLE_HEAD = "mg-table-head-pinned px-4 py-2.5 text-left mg-type-label text-ink-muted";
const MOBILE_SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "revenue_usd:desc", label: "Revenue · high to low" },
  { value: "revenue_usd:asc", label: "Revenue · low to high" },
  { value: "coverage_ratio:desc", label: "Coverage · high to low" },
  { value: "coverage_ratio:asc", label: "Coverage · low to high" },
  { value: "subsidy_multiple:desc", label: "Subsidy · high to low" },
  { value: "subsidy_multiple:asc", label: "Subsidy · low to high" },
  { value: "emission_usd:desc", label: "Emission · high to low" },
  { value: "emission_usd:asc", label: "Emission · low to high" },
  { value: "netuid:asc", label: "Subnet ID · low to high" },
  { value: "netuid:desc", label: "Subnet ID · high to low" },
];

function ProvenanceCell({ provenance }: { provenance: string | null }) {
  const eligible = HEADLINE_TIERS.has(provenance ?? "");
  return <Chip tone={eligible ? "accent" : "muted"}>{tierLabel(provenance)}</Chip>;
}

function SubnetCell({ row, compact = false }: { row: CoverageRow; compact?: boolean }) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: row.netuid }}
      className={
        compact
          ? "block truncate font-mono mg-type-caption text-ink-strong hover:text-accent hover:underline"
          : "font-mono mg-type-caption text-ink-strong hover:text-accent hover:underline"
      }
      title={row.name ? `SN${row.netuid} · ${row.name}` : `SN${row.netuid}`}
    >
      SN{row.netuid}
      {row.name ? <span className="ml-2 font-sans text-ink-muted">{row.name}</span> : null}
    </Link>
  );
}

/**
 * The touch view has the same truth conditions as the wide table, but leads
 * with the two decisions people make on a small screen: which subnet, and how
 * much observed revenue covers its emission. Supporting figures stay present
 * without forcing a six-column table into a horizontal gesture.
 */
function RevenueCard({ row }: { row: CoverageRow }) {
  return (
    <Panel as="article" dense>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SubnetCell row={row} compact />
          <p className="mt-1 mg-type-data text-ink-muted">Observed external revenue</p>
        </div>
        <ProvenanceCell provenance={row.provenance} />
      </div>
      <DefinitionList
        layout="grid"
        className="mt-4"
        items={[
          { term: "Revenue", detail: usdLabel(row.revenue_usd) ?? "—" },
          { term: "Coverage", detail: coverageLabel(row.coverage_ratio) },
          { term: "Emission", detail: usdLabel(row.emission_usd) ?? "—" },
          { term: "Subsidy", detail: subsidyLabel(row.subsidy_multiple) },
        ]}
      />
    </Panel>
  );
}

export function RevenuePage() {
  const search = Route.useSearch() as RevenueSearch;
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useQuery(chainRevenueCoverageQuery());

  const rows = useMemo(() => toCoverageRows(q.data?.data?.subnets), [q.data?.data?.subnets]);
  const options = useMemo(() => provenanceOptions(rows), [rows]);
  const { measured, notObserved } = useMemo(
    () =>
      partitionAndSort(rows, search.sort, search.dir, {
        provenance: search.provenance,
      }),
    [rows, search.sort, search.dir, search.provenance],
  );

  // `field` is the route's own sort union, not `string`, and `prev` is
  // inferred. Both used to be widened by hand, which meant the reducer
  // returned an object the route's search schema would have rejected -- and
  // nothing checked it, because the route's search types did not resolve.
  const onSort = (field: CoverageSortField) =>
    navigate({
      search: (prev) => ({
        ...prev,
        sort: field,
        dir: prev.sort === field && prev.dir === "desc" ? "asc" : "desc",
      }),
    });

  const sortField = COVERAGE_SORT_FIELDS.includes(search.sort)
    ? search.sort
    : ("revenue_usd" as CoverageSortField);
  const headlineEligible = rows.filter((row) => HEADLINE_TIERS.has(row.provenance ?? "")).length;
  const hasLoadedData = !q.isLoading && !q.isError;

  const filters = (
    <div className="flex w-full flex-wrap items-center gap-2 py-2">
      <span className="mr-1 mg-type-label text-ink-muted">Evidence</span>
      <GhostButton
        size="sm"
        appearance="terminal"
        tone={search.provenance ? "default" : "accent"}
        aria-pressed={!search.provenance}
        onClick={() => navigate({ search: (prev) => ({ ...prev, provenance: "" }) })}
      >
        All <span className="text-ink-muted">{rows.length}</span>
      </GhostButton>
      {options.map((option) => {
        const selected = search.provenance === option.value;
        return (
          <GhostButton
            key={option.value}
            size="sm"
            appearance="terminal"
            tone={selected ? "accent" : "default"}
            aria-pressed={selected}
            onClick={() =>
              navigate({
                search: (prev) => ({ ...prev, provenance: option.value }),
              })
            }
          >
            {tierLabel(option.value === "none" ? null : option.value)}
            <span className="text-ink-muted">{option.count}</span>
            {option.headlineEligible ? <span aria-label="headline eligible">★</span> : null}
          </GhostButton>
        );
      })}
      <label className="flex min-w-[13rem] flex-1 flex-col gap-1 lg:hidden">
        <span className="mg-type-caption text-ink-muted">Sort observed rows</span>
        <FilterSelect
          aria-label="Sort coverage leaderboard"
          value={`${sortField}:${search.dir}`}
          onChange={(event) => {
            const [field, dir] = event.target.value.split(":");
            if (!COVERAGE_SORT_FIELDS.includes(field as CoverageSortField)) return;
            navigate({
              search: (prev) => ({
                ...prev,
                sort: field as CoverageSortField,
                dir: dir === "asc" ? "asc" : "desc",
              }),
            });
          }}
        >
          {MOBILE_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      </label>
    </div>
  );

  const emptyNode = (
    <EmptyState
      title="No observed figures in this view"
      description="Try another evidence tier. Subnets without an observable external-revenue figure remain separate and never receive a rank."
    />
  );

  return (
    <AppShell>
      <DataPageStage>
        <DataPageHero
          variant="directory"
          id="revenue-coverage-title"
          eyebrow="Network economics"
          live
          title="Revenue coverage."
          description="Observable external revenue, set against the TAO each subnet receives in emission."
          summary={
            hasLoadedData ? (
              <MetaStrip
                items={[
                  { label: "Measured", value: measured.length },
                  { label: "Not observed", value: notObserved.length },
                  { label: "Headline-ready", value: headlineEligible },
                ]}
              />
            ) : undefined
          }
          footer={
            <>
              <span>Absence is not zero — only observed figures are ranked.</span>
              <Link
                to="/docs/$"
                params={{ _splat: "revenue-coverage" }}
                className="text-accent hover:text-ink-strong hover:underline"
              >
                Methodology
              </Link>
            </>
          }
        />

        <DataPageCanvas>
          <DataPageModule
            kind="question"
            title="What is measured"
            caption="Publicly observable external revenue is the entry condition; the coverage ratio is never inferred from a missing figure."
          >
            {q.isLoading ? (
              <Skeleton className="h-28 w-full" />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} context="revenue coverage" />
            ) : (
              <MetricGrid cols={{ base: 1, sm: 3 }} gap="sm">
                <StatTile
                  eyebrow="Measured"
                  value={String(measured.length)}
                  hint="observable figure"
                />
                <StatTile
                  eyebrow="Not observed"
                  value={String(notObserved.length)}
                  hint="separate, never ranked"
                />
                <StatTile
                  eyebrow="Headline-ready"
                  value={String(headlineEligible)}
                  hint="verified or probe-derived"
                  tone="accent"
                />
              </MetricGrid>
            )}
          </DataPageModule>

          {!q.isError ? (
            <DataPageModule
              kind="question"
              title="Coverage leaderboard"
              caption="Sort the observed set by revenue, emission, coverage, or subsidy. A missing value is not a score."
            >
              {q.isLoading ? (
                <Skeleton className="h-96 w-full" />
              ) : (
                <ListShell
                  presentation="canvas"
                  responsiveAt="lg"
                  filters={filters}
                  isEmpty={measured.length === 0}
                  empty={emptyNode}
                  cards={measured.map((row) => (
                    <RevenueCard key={row.netuid} row={row} />
                  ))}
                  table={
                    <table className="w-full min-w-[52rem] text-left text-sm">
                      <thead>
                        <tr>
                          <th
                            className={TABLE_HEAD}
                            aria-sort={ariaSort(sortField === "netuid", search.dir)}
                          >
                            <SortHeader
                              label="Subnet"
                              field="netuid"
                              active={sortField === "netuid"}
                              order={search.dir}
                              onSort={onSort}
                            />
                          </th>
                          <th className={TABLE_HEAD}>Evidence</th>
                          <th
                            className={`${TABLE_HEAD} text-right`}
                            aria-sort={ariaSort(sortField === "emission_usd", search.dir)}
                          >
                            <SortHeader
                              label="Emission"
                              field="emission_usd"
                              active={sortField === "emission_usd"}
                              order={search.dir}
                              onSort={onSort}
                              align="right"
                            />
                          </th>
                          <th
                            className={`${TABLE_HEAD} text-right`}
                            aria-sort={ariaSort(sortField === "revenue_usd", search.dir)}
                          >
                            <SortHeader
                              label="Revenue"
                              field="revenue_usd"
                              active={sortField === "revenue_usd"}
                              order={search.dir}
                              onSort={onSort}
                              align="right"
                            />
                          </th>
                          <th
                            className={`${TABLE_HEAD} text-right`}
                            aria-sort={ariaSort(sortField === "coverage_ratio", search.dir)}
                          >
                            <SortHeader
                              label="Coverage"
                              field="coverage_ratio"
                              active={sortField === "coverage_ratio"}
                              order={search.dir}
                              onSort={onSort}
                              align="right"
                            />
                          </th>
                          <th
                            className={`${TABLE_HEAD} text-right`}
                            aria-sort={ariaSort(sortField === "subsidy_multiple", search.dir)}
                          >
                            <SortHeader
                              label="Subsidy"
                              field="subsidy_multiple"
                              active={sortField === "subsidy_multiple"}
                              order={search.dir}
                              onSort={onSort}
                              align="right"
                            />
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {measured.map((row) => (
                          <tr key={row.netuid} className="mg-row-accent hover:bg-surface/40">
                            <td className="px-4 py-3">
                              <SubnetCell row={row} />
                            </td>
                            <td className="px-4 py-3">
                              <ProvenanceCell provenance={row.provenance} />
                            </td>
                            <td className="px-4 py-3 text-right mg-type-data tabular-nums text-ink">
                              {usdLabel(row.emission_usd) ?? "—"}
                            </td>
                            <td className="px-4 py-3 text-right mg-type-data tabular-nums text-ink">
                              {usdLabel(row.revenue_usd) ?? "—"}
                            </td>
                            <td className="px-4 py-3 text-right mg-type-data tabular-nums text-ink">
                              {coverageLabel(row.coverage_ratio)}
                            </td>
                            <td className="px-4 py-3 text-right mg-type-data tabular-nums text-ink">
                              {subsidyLabel(row.subsidy_multiple)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  }
                />
              )}
            </DataPageModule>
          ) : null}

          {hasLoadedData && notObserved.length > 0 ? (
            <DataPageModule
              kind="operations"
              title="Not observed"
              caption={notObservedNote(notObserved.length, rows.length)}
            >
              <DataPageDisclosure label={`Show ${notObserved.length} unmeasured subnets`}>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-2 pb-1 sm:grid-cols-3 lg:grid-cols-4">
                  {notObserved.map((row) => (
                    <li key={row.netuid} className="min-w-0 border-l border-border pl-2">
                      <SubnetCell row={row} compact />
                    </li>
                  ))}
                </ul>
              </DataPageDisclosure>
            </DataPageModule>
          ) : null}
        </DataPageCanvas>
      </DataPageStage>
    </AppShell>
  );
}
