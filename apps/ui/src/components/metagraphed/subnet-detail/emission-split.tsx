import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  RankGrid,
  SeriesPaletteRegistry,
  StackedColumns,
  type RankGridItem,
} from "@jsonbored/ui-kit";
import {
  subnetEmissionSplitHistoryQuery,
  subnetEmissionSplitQuery,
} from "@/lib/metagraphed/queries";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import {
  declaredSplitRows,
  EMISSION_SERIES,
  emissionColumns,
  emissionTotals,
  trailing,
  windowDays,
  type Window,
} from "./subnet-detail-logic";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { ErrorState } from "@/components/metagraphed/states";

/**
 * Section 2 — where the day's emission actually lands.
 *
 * Absolute alpha, not shares: a subnet whose validator share holds steady
 * while its total emission halves has not "stayed the same", and a
 * normalised chart says it did.
 */
export function EmissionSplitSection({
  netuid,
  window,
  children,
}: {
  netuid: number;
  window: Window;
  children?: ReactNode;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetEmissionSplitHistoryQuery(netuid, window),
    retry: 0,
  });
  // The split the chain declares (MET-7365), beside the split it was paid.
  const declared = useQuery({ ...subnetEmissionSplitQuery(netuid), retry: 0 });
  const declaredSplit = declared.data?.data.split ?? null;
  const declaredItems: RankGridItem[] = declaredSplitRows(declaredSplit).map((row) => ({
    key: `declared-${row.key}`,
    label: row.label,
    share: formatPct(row.share, 1),
  }));
  const hydrated = useHydrated();
  const loading = !hydrated || isPending;
  const showLoading = hydrated && isPending;
  // Assigned here, not left to the chart: the legend renders the same
  // swatches and must resolve them from the same slot table.
  const registry = useMemo(() => {
    const created = new SeriesPaletteRegistry();
    created.assign([...EMISSION_SERIES]);
    return created;
  }, []);
  const palette = registry.palette();
  const columns = emissionColumns(trailing(data?.data.points ?? [], windowDays(window)));
  const totals = emissionTotals(columns);

  const legend: RankGridItem[] = totals.map((total) => ({
    key: total.key,
    label: total.label,
    value: `${taoCompact(total.value)} α`,
    share: `${formatPct(total.share, 1)}`,
    swatch: palette.colorOf(total.key),
  }));

  return (
    <AnalyticsSection
      id="emission-split"
      name="Value flow"
      question="Where daily emission goes and what external revenue is evidenced."
      visual={
        showLoading ? (
          <StackedColumns
            id={`sn-${netuid}-split`}
            columns={[]}
            seriesOrder={[...EMISSION_SERIES]}
            registry={registry}
            formatValue={(v) => `${taoCompact(v)} α`}
            ariaLabel={`Subnet ${netuid} daily emission by recipient`}
            columnSource={`sn-${netuid}-split-day`}
            loading
            loadingColumns={windowDays(window)}
          />
        ) : isError ? (
          <ErrorState
            error={error}
            onRetry={() => void refetch()}
            context={`${window} emission recipients`}
          />
        ) : columns.length > 0 ? (
          <StackedColumns
            id={`sn-${netuid}-split`}
            columns={columns}
            seriesOrder={[...EMISSION_SERIES]}
            registry={registry}
            formatValue={(v) => `${taoCompact(v)} α`}
            ariaLabel={`Subnet ${netuid} daily emission by recipient`}
            columnSource={`sn-${netuid}-split-day`}
          />
        ) : null
      }
      legend={
        showLoading ? (
          <RankGrid
            items={[]}
            cols={4}
            ariaLabel="Emission by recipient class"
            source={`sn-${netuid}-split`}
            loading
            loadingItems={4}
          />
        ) : legend.length > 0 ? (
          <RankGrid
            items={legend}
            cols={4}
            ariaLabel="Emission by recipient class"
            source={`sn-${netuid}-split`}
          />
        ) : null
      }
      footnote={
        loading
          ? `Loading ${window} emission recipients · chain-direct`
          : isError
            ? "chain-direct · retry the affected record above"
            : `${window} · owner cut, validator dividends, miner incentive and burn, chain-direct`
      }
      after={
        <>
          {declaredItems.length > 0 ? (
            <RankGrid
              items={declaredItems}
              cols={4}
              ariaLabel="Emission split the chain declares"
              source={`sn-${netuid}-declared-split`}
            />
          ) : null}
          {declaredSplit ? (
            <p className="text-11 text-ink-muted">
              {declaredSplit.is_default
                ? "Declared split: the runtime default (owner 18%, validators 41%, miners the rest)"
                : "Declared split: set by this subnet"}
              {` · since block ${formatNumber(declaredSplit.valid_from)}`}
              {declared.data?.data.stage ? ` · ${declared.data.data.stage.replace("_", " ")}` : ""}
              {declared.data?.data.epoch_consensus === "null" ? " · null consensus" : ""}
              {" · chain-direct"}
            </p>
          ) : null}
          {children}
        </>
      }
    />
  );
}
