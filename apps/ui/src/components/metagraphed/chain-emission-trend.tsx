import { Sparkline } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import type { EconomicsTrendsDay } from "@/lib/metagraphed/types";

const formatShare = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * The one genuinely windowed trend in this tab's "trend row" — a real daily
 * series from /api/v1/economics/trends, unlike the concentration/idle-stake
 * modules alongside it (both point-in-time snapshots; no chain-level history
 * endpoint exists for either).
 */
export function ChainEmissionTrend({
  days,
  window,
}: {
  days: EconomicsTrendsDay[];
  window: string;
}) {
  const points = days
    .filter((d) => d.mean_emission_share != null)
    .map((d) => ({ t: d.snapshot_date, v: d.mean_emission_share as number }));

  return (
    <ChartCard
      title="Mean emission share"
      caption={`Average per-subnet emission share, ${window} — a widening spread means emission is concentrating into fewer subnets.`}
      height={120}
      empty={points.length === 0}
    >
      <Sparkline
        values={points.map((p) => p.v)}
        points={points}
        formatValue={formatShare}
        ariaLabel="Mean emission share over time"
        width={480}
        height={100}
      />
    </ChartCard>
  );
}
