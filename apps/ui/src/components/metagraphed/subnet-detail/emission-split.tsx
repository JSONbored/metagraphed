import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  RankGrid,
  SeriesPaletteRegistry,
  StackedColumns,
  type RankGridItem,
} from "@jsonbored/ui-kit";
import { subnetEmissionSplitHistoryQuery } from "@/lib/metagraphed/queries";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import {
  EMISSION_SERIES,
  emissionColumns,
  emissionTotals,
  trailing,
  windowDays,
  type Window,
} from "./subnet-detail-logic";

/**
 * Section 2 — where the day's emission actually lands.
 *
 * Absolute alpha, not shares: a subnet whose validator share holds steady
 * while its total emission halves has not "stayed the same", and a
 * normalised chart says it did.
 */
export function EmissionSplitSection({ netuid, window }: { netuid: number; window: Window }) {
  const { data } = useQuery({
    ...subnetEmissionSplitHistoryQuery(netuid, window),
    retry: 0,
  });
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
    share: `${(total.share * 100).toFixed(1)}%`,
    swatch: palette.colorOf(total.key),
  }));

  return (
    <AnalyticsSection
      id="emission-split"
      name="Emission split"
      question="Where the daily emission goes."
      visual={
        columns.length > 0 ? (
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
        legend.length > 0 ? (
          <RankGrid
            items={legend}
            cols={4}
            ariaLabel="Emission by recipient class"
            source={`sn-${netuid}-split`}
          />
        ) : null
      }
      footnote={`${window} · owner cut, validator dividends, miner incentive and burn, chain-direct`}
    />
  );
}
