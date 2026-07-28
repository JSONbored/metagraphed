import { BarMini } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import type { ChainConcentration } from "@/lib/metagraphed/types";

const formatShare = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * A CURRENT snapshot, not a trend — /api/v1/chain/concentration has no
 * `window` param and no history at the chain level (only per-subnet history
 * exists, GET /subnets/{netuid}/concentration/history). Said explicitly in
 * the caption rather than dressed up as a line chart it isn't.
 */
export function ChainConcentrationSnapshot({
  concentration,
}: {
  concentration: ChainConcentration;
}) {
  const stakeShare = concentration.stake?.top_10pct_share;
  const emissionShare = concentration.emission?.top_10pct_share;
  const hasData = stakeShare != null || emissionShare != null;

  return (
    <ChartCard
      title="Stake & emission concentration"
      caption="Current snapshot, not a trend — the network-wide concentration endpoint has no historical window."
      updatedAt={concentration.captured_at}
      height={120}
      empty={!hasData}
    >
      <BarMini
        data={[
          { label: "Stake", value: stakeShare ?? 0 },
          { label: "Emission", value: emissionShare ?? 0 },
        ]}
        max={1}
        formatValue={formatShare}
        ariaLabel="Top-10% holder share of stake and emission"
      />
    </ChartCard>
  );
}
