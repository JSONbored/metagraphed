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
      variant="data"
      title="Stake and emission concentration"
      caption="How much of each sits with the top 10% of holders. This is a current network snapshot, not a trend."
      updatedAt={concentration.captured_at}
      height={156}
      empty={!hasData}
    >
      <BarMini
        data={[
          { label: "Stake", value: stakeShare ?? 0, color: "var(--chart-1)" },
          { label: "Emission", value: emissionShare ?? 0, color: "var(--chart-4)" },
        ]}
        max={1}
        formatValue={formatShare}
        ariaLabel="Top-10% holder share of stake and emission"
      />
    </ChartCard>
  );
}
