import { useMemo } from "react";
import type { RevenueSearch } from "./revenue";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Chip, DataTable, FactStrip, FactCell, type SortState } from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { Route } from "./revenue";
import { chainRevenueCoverageQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
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

function ProvenanceCell({ provenance }: { provenance: string | null }) {
  const eligible = HEADLINE_TIERS.has(provenance ?? "");
  return <Chip tone={eligible ? "accent" : "muted"}>{tierLabel(provenance)}</Chip>;
}

function SubnetCell({ row }: { row: CoverageRow }) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: row.netuid }}
      className="font-mono text-13 text-ink-strong hover:text-accent hover:underline"
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
  // DataTable hands back `null` on the third click; this board always ranks by
  // something, so an unsorted state falls back to the default field.
  const onSort = (next: SortState | null) => {
    const field = (
      next && COVERAGE_SORT_FIELDS.includes(next.key as CoverageSortField)
        ? next.key
        : "revenue_usd"
    ) as CoverageSortField;
    const dir = next && field === next.key ? next.dir : "desc";
    navigate({ search: (prev) => ({ ...prev, sort: field, dir }) });
  };

  if (q.isError) {
    return <ErrorState error={q.error} onRetry={() => q.refetch()} context="revenue coverage" />;
  }
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;

  const sortField = COVERAGE_SORT_FIELDS.includes(search.sort)
    ? search.sort
    : ("revenue_usd" as CoverageSortField);

  return (
    <div className="space-y-6">
      <FactStrip variant="grid">
        <FactCell
          label="Subnets measured"
          value={String(measured.length)}
          hint="With an observable external revenue figure"
        />
        <FactCell
          label="Not observed"
          value={String(notObserved.length)}
          hint="No readable public figure — not measured, not judged"
        />
        <FactCell
          label="Headline-eligible"
          value={String(rows.filter((r) => HEADLINE_TIERS.has(r.provenance ?? "")).length)}
          hint="Chain-verified or probe-derived"
        />
      </FactStrip>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-13 text-ink-muted">Provenance</span>
        <button
          type="button"
          onClick={() => navigate({ search: (p) => ({ ...p, provenance: "" }) })}
          className={`rounded border px-3 py-1 text-13 ${
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
            className={`rounded border px-3 py-1 text-13 ${
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

      <DataTable
        rows={measured}
        rowKey={(row) => String(row.netuid)}
        caption="Revenue coverage"
        source="revenue-coverage"
        link={RouterLink}
        rowHref={(row) => `/subnets/${row.netuid}`}
        sort={{ key: sortField, dir: search.dir }}
        onSort={onSort}
        empty="No subnet in this provenance tier has an observable revenue figure."
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (_value, row) => `SN${row.netuid}${row.name ? ` ${row.name}` : ""}`,
          },
          {
            key: "provenance",
            label: "Provenance",
            value: (row) => tierLabel(row.provenance),
            render: (row) => <ProvenanceCell provenance={row.provenance} />,
          },
          {
            key: "emission_usd",
            label: "Emission",
            kind: "number",
            sortable: true,
            value: (row) => row.emission_usd ?? null,
            format: (_value, row) => usdLabel(row.emission_usd) ?? "—",
          },
          {
            key: "revenue_usd",
            label: "Revenue",
            kind: "number",
            sortable: true,
            value: (row) => row.revenue_usd ?? null,
            format: (_value, row) => usdLabel(row.revenue_usd) ?? "—",
          },
          {
            key: "coverage_ratio",
            label: "Coverage",
            kind: "number",
            sortable: true,
            value: (row) => row.coverage_ratio ?? null,
            format: (_value, row) => coverageLabel(row.coverage_ratio),
          },
          {
            key: "subsidy_multiple",
            label: "Subsidy",
            kind: "number",
            sortable: true,
            value: (row) => row.subsidy_multiple ?? null,
            format: (_value, row) => subsidyLabel(row.subsidy_multiple),
          },
        ]}
      />

      {notObserved.length > 0 ? (
        <div className="space-y-2">
          {/* Visually distinct and OUTSIDE the ranked table, because ordering
              these by a figure nobody measured is the defect this page exists
              not to have. */}
          <Panel bodyClassName="text-13 text-ink-muted">
            {notObservedNote(notObserved.length, rows.length)}
          </Panel>
          <div className="flex flex-wrap gap-2">
            {notObserved.map((row) => (
              <span key={row.netuid} className="rounded border border-border/60 px-3 py-1">
                <SubnetCell row={row} />
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <Link
        to="/docs/$"
        params={{ _splat: "revenue-coverage" }}
        className="text-13 text-accent hover:underline"
      >
        How the ratio is derived, and what it does not mean
      </Link>
    </div>
  );
}
