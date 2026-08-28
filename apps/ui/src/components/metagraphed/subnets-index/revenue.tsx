import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  BrandIcon,
  DataTable,
  FactStrip,
  RangeControl,
  type DataTableColumn,
  type FactCells,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { chainRevenueCoverageQuery } from "@/lib/metagraphed/queries";
import {
  REVENUE_WINDOW_OPTIONS,
  directoryEvidenceCoverage,
  revenueHeadlineState,
  revenueProvenanceLabel,
  subsidyMultipleLabel,
} from "@/lib/metagraphed/revenue";
import { formatNumber, formatPct, formatTao, formatUsd } from "@/lib/metagraphed/format";
import type { RevenueWindow, SubnetRevenue } from "@/lib/metagraphed/types";

interface RevenueDirectoryRow extends SubnetRevenue {
  name: string;
}

const REVENUE_COVERAGE_API_PATH = "/api/v1/chain/revenue-coverage";

const COLUMNS: DataTableColumn<RevenueDirectoryRow>[] = [
  {
    key: "subnet",
    label: "Subnet",
    kind: "text",
    value: (row) => row.name,
    render: (row) => (
      <span className="mg-dt-entity">
        <BrandIcon size={20} name={row.name} netuid={row.netuid} decorative />
        <span className="truncate">{row.name}</span>
      </span>
    ),
  },
  {
    key: "revenue_usd",
    label: "External revenue",
    kind: "number",
    value: (row) => row.revenue_usd,
    format: (value) => (typeof value === "number" ? formatUsd(value) : "Not observed"),
  },
  {
    key: "coverage_ratio",
    label: "Revenue coverage",
    kind: "number",
    value: (row) => row.coverage_ratio,
    format: (value) => (typeof value === "number" ? formatPct(value, 1) : "Not observed"),
  },
  {
    key: "subsidy_multiple",
    label: "Subsidy multiple",
    kind: "number",
    value: (row) => row.subsidy_multiple,
    format: (value) => subsidyMultipleLabel(typeof value === "number" ? value : null),
  },
  {
    key: "emission_tao",
    label: "Emitted TAO",
    kind: "number",
    value: (row) => row.emission.tao,
    format: (value) => (typeof value === "number" ? formatTao(value) : "—"),
    demote: true,
  },
  {
    key: "provenance",
    label: "Evidence",
    kind: "text",
    value: (row) => revenueProvenanceLabel(row.provenance),
  },
];

function CoverageFacts({
  observedCount,
  subnetCount,
  loading = false,
}: {
  observedCount?: number | null;
  subnetCount?: number | null;
  loading?: boolean;
}) {
  const readable =
    observedCount != null && subnetCount != null
      ? `${formatNumber(observedCount)} / ${formatNumber(subnetCount)}`
      : "Unavailable";
  const coverage = directoryEvidenceCoverage(observedCount, subnetCount);
  const cells: FactCells = [
    {
      label: "Readable revenue",
      value: readable,
      kind: observedCount != null && subnetCount != null ? undefined : "text",
      loading,
    },
    {
      label: "Evidence coverage",
      value: coverage,
      kind: coverage === "—" ? "text" : undefined,
      loading,
    },
  ];
  return <FactStrip cells={cells} />;
}

/**
 * Network-level context for the detail ledgers. This is deliberately not a
 * leaderboard: subnets without readable revenue stay in the denominator, so
 * the small observed set cannot be mistaken for a complete market ranking.
 */
export function RevenueCoverageSection({ nameOf }: { nameOf: (netuid: number) => string }) {
  const [window, setWindow] = useState<RevenueWindow>("1d");
  const { ref, nearViewport } = useNearViewport<HTMLDivElement>("320px 0px");
  useRegisterApiSource(nearViewport ? [REVENUE_COVERAGE_API_PATH] : []);
  const query = useQuery({
    ...chainRevenueCoverageQuery(window),
    enabled: nearViewport,
    retry: 0,
  });
  const coverage = query.data?.data;
  const coverageError =
    query.error ?? new Error("The revenue coverage response did not include a readable ledger.");
  const observedRows = useMemo(
    () =>
      (coverage?.subnets ?? [])
        .filter((subnet) => revenueHeadlineState(subnet) === "verified")
        .map((subnet) => ({ ...subnet, name: nameOf(subnet.netuid) }))
        .sort((a, b) => (b.revenue_usd ?? 0) - (a.revenue_usd ?? 0)),
    [coverage, nameOf],
  );

  return (
    <AnalyticsSection
      id="revenue"
      name="Revenue evidence"
      question="Which subnets have readable external revenue, not a speculative ranking."
      controls={
        <RangeControl
          label="Revenue window"
          options={REVENUE_WINDOW_OPTIONS}
          value={window}
          onChange={setWindow}
        />
      }
      visual={
        <div ref={ref}>
          {!nearViewport ? (
            <p className="mg-section-empty">Revenue coverage loads as this section approaches.</p>
          ) : query.isPending ? (
            <CoverageFacts loading />
          ) : query.isError || !coverage ? (
            <ErrorState
              error={coverageError}
              onRetry={() => void query.refetch()}
              context="network revenue coverage"
            />
          ) : (
            <CoverageFacts
              observedCount={coverage.observed_count}
              subnetCount={coverage.subnet_count}
            />
          )}
        </div>
      }
      footnote={
        !nearViewport
          ? "deferred below the fold · avoids a large initial evidence payload"
          : query.isPending
            ? "loading network revenue evidence"
            : query.isError || !coverage
              ? "the revenue coverage endpoint could not be read"
              : `${coverage.window_days ?? window.slice(0, -1)}d · ${formatNumber(
                  coverage.observed_count,
                )} of ${formatNumber(coverage.subnet_count)} subnets have readable external revenue`
      }
      empty={false}
    >
      {coverage && observedRows.length > 0 ? (
        <DataTable
          rows={observedRows}
          columns={COLUMNS}
          rowKey={(row) => String(row.netuid)}
          rowHref={(row) => `/subnets/${row.netuid}#revenue`}
          link={RouterLink}
          caption="Subnets with readable external revenue"
          source="subnet-revenue-coverage"
          paginate={false}
          mobile="cards"
          dense
        />
      ) : coverage && !query.isPending && !query.isError ? (
        <p className="m-0 text-13 leading-6 text-ink-muted">
          {(coverage.observed_count ?? 0) > 0
            ? "Reported revenue entries are not ready to display until their response validates."
            : "No subnet has readable external revenue for this window yet."}
        </p>
      ) : null}
    </AnalyticsSection>
  );
}
