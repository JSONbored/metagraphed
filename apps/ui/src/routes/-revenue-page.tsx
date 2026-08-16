import { useMemo } from "react";
import type { RevenueSearch } from "./revenue";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Chip, StatTile } from "@jsonbored/ui-kit";
import { Route } from "./revenue";
import { chainRevenueCoverageQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
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

/**
 * #10478: every subnet's coverage, in one table.
 *
 * THE ORDERING IS WHERE THIS PAGE CAN DO HARM. Sorting `null` as `0` would rank
 * 127 subnets as the worst performers on the network — a claim about each of
 * them at once, and one the data does not support. So unmeasured subnets are
 * never ranked: they sit in their own group below the table, labelled as what
 * they are. The rule lives in coverage-leaderboard-model.ts, where it is tested.
 *
 * The provenance filter shows every tier by default, with counts, because the
 * count is how a reader learns the headline-eligible set is two subnets wide.
 */

const TH = "px-4 py-3 text-left mg-type-caption text-ink-muted";

function ProvenanceCell({ provenance }: { provenance: string | null }) {
  const eligible = HEADLINE_TIERS.has(provenance ?? "");
  return <Chip tone={eligible ? "accent" : "muted"}>{tierLabel(provenance)}</Chip>;
}

function SubnetCell({ row }: { row: CoverageRow }) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: row.netuid }}
      className="font-mono mg-type-caption text-ink-strong hover:text-accent hover:underline"
    >
      SN{row.netuid}
      {row.name ? <span className="ml-2 font-sans text-ink-muted">{row.name}</span> : null}
    </Link>
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

  if (q.isError) {
    return <ErrorState error={q.error} onRetry={() => q.refetch()} context="revenue coverage" />;
  }
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;

  const sortField = COVERAGE_SORT_FIELDS.includes(search.sort)
    ? search.sort
    : ("revenue_usd" as CoverageSortField);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          eyebrow="Subnets measured"
          value={String(measured.length)}
          hint="With an observable external revenue figure"
        />
        <StatTile
          eyebrow="Not observed"
          value={String(notObserved.length)}
          hint="No readable public figure — not measured, not judged"
        />
        <StatTile
          eyebrow="Headline-eligible"
          value={String(rows.filter((r) => HEADLINE_TIERS.has(r.provenance ?? "")).length)}
          hint="Chain-verified or probe-derived"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mg-type-caption text-ink-muted">Provenance</span>
        <button
          type="button"
          onClick={() => navigate({ search: (p) => ({ ...p, provenance: "" }) })}
          className={`rounded-full border px-3 py-1 mg-type-caption ${
            search.provenance ? "border-border/80 text-ink-muted" : "border-accent text-ink-strong"
          }`}
        >
          All ({rows.length})
        </button>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() =>
              navigate({
                search: (p) => ({ ...p, provenance: option.value }),
              })
            }
            className={`rounded-full border px-3 py-1 mg-type-caption ${
              search.provenance === option.value
                ? "border-accent text-ink-strong"
                : "border-border/80 text-ink-muted"
            }`}
          >
            {tierLabel(option.value === "none" ? null : option.value)} ({option.count})
            {option.headlineEligible ? " ★" : ""}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border/80">
        <table className="w-full min-w-[52rem]">
          <thead>
            <tr className="border-b border-border/80">
              <th className={TH} aria-sort={ariaSort(sortField === "netuid", search.dir)}>
                <SortHeader
                  label="Subnet"
                  field="netuid"
                  active={sortField === "netuid"}
                  order={search.dir}
                  onSort={onSort}
                />
              </th>
              <th className={TH}>Provenance</th>
              <th
                className={`${TH} text-right`}
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
                className={`${TH} text-right`}
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
                className={`${TH} text-right`}
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
                className={`${TH} text-right`}
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
          <tbody>
            {measured.map((row) => (
              <tr key={row.netuid} className="border-b border-border/40">
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
      </div>

      {notObserved.length > 0 ? (
        <div className="space-y-2">
          {/* Visually distinct and OUTSIDE the ranked table, because ordering
              these by a figure nobody measured is the defect this page exists
              not to have. */}
          <Panel as="div" dense bodyClassName="mg-type-caption text-ink-muted">
            {notObservedNote(notObserved.length, rows.length)}
          </Panel>
          <div className="flex flex-wrap gap-2">
            {notObserved.map((row) => (
              <span key={row.netuid} className="rounded-full border border-border/60 px-3 py-1">
                <SubnetCell row={row} />
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <Link
        to="/docs/$"
        params={{ _splat: "revenue-coverage" }}
        className="mg-type-caption text-accent hover:underline"
      >
        How the ratio is derived, and what it does not mean
      </Link>
    </div>
  );
}
