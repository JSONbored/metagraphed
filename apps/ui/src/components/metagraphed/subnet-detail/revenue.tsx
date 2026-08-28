import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  FactStrip,
  RangeControl,
  SectionHead,
  type DataTableColumn,
  type FactCells,
} from "@jsonbored/ui-kit";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { subnetRevenueQuery } from "@/lib/metagraphed/queries";
import {
  REVENUE_WINDOW_OPTIONS,
  revenueEvidenceFootnote,
  revenueHeadlineState,
  revenueProvenanceLabel,
  revenueSourcePeriods,
  revenueSourceStatus,
  subsidyMultipleLabel,
} from "@/lib/metagraphed/revenue";
import { formatPct, formatTao, formatUsd } from "@/lib/metagraphed/format";
import type { RevenueSource, RevenueWindow, SubnetRevenue } from "@/lib/metagraphed/types";
import { ErrorState } from "@/components/metagraphed/states";

const SOURCE_COLUMNS: DataTableColumn<RevenueSource>[] = [
  { key: "surface_id", label: "Source", kind: "identifier", value: (row) => row.surface_id },
  {
    key: "contributes",
    label: "Headline",
    kind: "text",
    value: (row) => revenueSourceStatus(row),
  },
  {
    key: "amount_usd",
    label: "Revenue in window",
    kind: "number",
    value: (row) => row.amount_usd,
    format: (value) => (typeof value === "number" ? formatUsd(value) : "Not observed"),
  },
  {
    key: "periods",
    label: "Periods",
    kind: "text",
    value: (row) => revenueSourcePeriods(row),
  },
  {
    key: "provenance",
    label: "Evidence",
    kind: "text",
    value: (row) => revenueProvenanceLabel(row.provenance),
  },
  {
    key: "excluded_reason",
    label: "Why excluded",
    kind: "text",
    value: (row) => row.excluded_reason ?? "—",
    demote: true,
  },
];

function RevenueLedger({
  revenue,
  loading = false,
}: {
  revenue?: SubnetRevenue;
  loading?: boolean;
}) {
  const state = revenueHeadlineState(revenue);
  const reported = state === "verified";
  const coverage =
    reported && revenue?.coverage_ratio != null
      ? formatPct(revenue.coverage_ratio, 1)
      : state === "not-observed"
        ? "Not observed"
        : state === "not-verified"
          ? "Not verified"
          : "Unavailable";
  const subsidy =
    reported && revenue?.subsidy_multiple != null
      ? subsidyMultipleLabel(revenue.subsidy_multiple)
      : state === "not-observed"
        ? "Not applicable"
        : state === "not-verified"
          ? "Not verified"
          : "Unavailable";
  const cells: FactCells = [
    {
      label: "External revenue",
      value: reported
        ? formatUsd(revenue?.revenue_usd)
        : state === "not-observed"
          ? "Not observed"
          : state === "not-verified"
            ? "Not verified"
            : "Unavailable",
      kind: reported ? undefined : "text",
      loading,
    },
    {
      label: "Emitted TAO",
      value: formatTao(revenue?.emission.tao),
      loading,
    },
    {
      label: "Revenue coverage",
      value: coverage,
      kind: reported && revenue?.coverage_ratio != null ? undefined : "text",
      loading,
    },
    {
      label: "Subsidy multiple",
      value: subsidy,
      kind: reported && revenue?.subsidy_multiple != null ? undefined : "text",
      loading,
    },
    {
      label: "Evidence",
      value:
        state === "not-verified"
          ? "Awaiting validation"
          : revenueProvenanceLabel(revenue?.provenance ?? null),
      kind: "text",
      loading,
    },
  ];

  return (
    <div className="space-y-4" aria-live="polite">
      <FactStrip cells={cells} />
      {!loading && state === "not-observed" ? (
        <p className="m-0 text-13 leading-6 text-ink-muted">
          No readable external revenue has been observed for this window.
        </p>
      ) : null}
      {!loading && state === "not-verified" ? (
        <p className="m-0 text-13 leading-6 text-ink-muted">
          A reported value is withheld until the response validates.
        </p>
      ) : null}
    </div>
  );
}

/**
 * External-revenue evidence stays below the primary price and emission read.
 * It starts only as the section approaches the viewport, because the result is
 * useful context rather than a dependency of the hero or the main price chart.
 */
export function RevenueSection({ netuid }: { netuid: number }) {
  const [window, setWindow] = useState<RevenueWindow>("1d");
  const { ref, nearViewport } = useNearViewport<HTMLDivElement>("320px 0px");
  const sourcePath = `/api/v1/subnets/${netuid}/revenue`;
  useRegisterApiSource(nearViewport ? [sourcePath] : []);
  const query = useQuery({
    ...subnetRevenueQuery(netuid, window),
    enabled: nearViewport,
    retry: 0,
  });
  const revenue = query.data?.data.revenue;
  const revenueError =
    query.error ?? new Error("The revenue response did not include a complete evidence ledger.");

  return (
    <section id="revenue" className="mg-revenue-evidence" aria-labelledby="revenue-heading">
      <SectionHead
        id="revenue-heading"
        name="Revenue evidence"
        question="Readable external revenue against the TAO directed here."
        controls={
          <RangeControl
            label="Revenue window"
            options={REVENUE_WINDOW_OPTIONS}
            value={window}
            onChange={setWindow}
          />
        }
      />
      <div className="mg-section-visual" ref={ref}>
        {!nearViewport ? (
          <p className="mg-section-empty">Revenue evidence loads as this section approaches.</p>
        ) : query.isPending ? (
          <RevenueLedger loading />
        ) : query.isError || !revenue ? (
          <ErrorState
            error={revenueError}
            onRetry={() => void query.refetch()}
            context="revenue evidence"
          />
        ) : (
          <RevenueLedger revenue={revenue} />
        )}
      </div>
      {revenue?.sources.length ? (
        <div className="mg-revenue-evidence-sources">
          <DataTable
            rows={revenue.sources}
            columns={SOURCE_COLUMNS}
            rowKey={(source) => source.surface_id}
            caption={`Subnet ${netuid} revenue sources`}
            source={`sn-${netuid}-revenue-source`}
            paginate={false}
            mobile="cards"
            dense
          />
        </div>
      ) : null}
      <p className="mg-section-note">
        {!nearViewport
          ? "deferred below the fold · avoids an extra initial page request"
          : query.isPending
            ? "loading revenue evidence"
            : query.isError || !revenue
              ? "the revenue endpoint could not be read"
              : revenueEvidenceFootnote(revenue, window)}
      </p>
    </section>
  );
}
