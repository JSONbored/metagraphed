import { MarkerRail } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { EmptyState } from "@/components/metagraphed/states";
import type { ChainConcentration } from "@/lib/metagraphed/types";

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
    <Panel
      title="Stake & emission concentration"
      caption="Current snapshot, not a trend — the network-wide concentration endpoint has no historical window."
    >
      {!hasData ? (
        <EmptyState title="Not enough data yet" />
      ) : (
        <MarkerRail
          items={[
            { key: "stake", label: "Stake", value: stakeShare == null ? null : stakeShare * 100 },
            {
              key: "emission",
              label: "Emission",
              value: emissionShare == null ? null : emissionShare * 100,
            },
          ]}
          max={100}
          formatValue={(v) => `${v.toFixed(1)}%`}
          columns={{ ratio: "Top 10%", name: "Of", scale: "0–100%" }}
          ariaLabel="Top-10% holder share of stake and emission"
        />
      )}
    </Panel>
  );
}
