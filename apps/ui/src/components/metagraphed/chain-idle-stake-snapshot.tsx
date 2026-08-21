import { BarMini } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import { formatTao } from "@/lib/metagraphed/format";
import type { ChainIdleStake } from "@/lib/metagraphed/types";

const MAX_SHOWN = 8;
const RANK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

/** Also a current snapshot — /api/v1/chain/idle-stake has no `window` param. */
export function ChainIdleStakeSnapshot({ idleStake }: { idleStake: ChainIdleStake }) {
  const top = [...idleStake.subnets]
    .filter((s) => (s.idle_stake_alpha ?? 0) > 0)
    .sort((a, b) => (b.idle_stake_alpha ?? 0) - (a.idle_stake_alpha ?? 0))
    .slice(0, MAX_SHOWN);

  return (
    <ChartCard
      variant="data"
      title="Idle stake"
      caption={
        idleStake.total_idle_stake_alpha != null
          ? `${formatTao(idleStake.total_idle_stake_alpha)} across the network. Top ${top.length} subnets are shown in this current snapshot.`
          : "Stake registered to a subnet without a corresponding active neuron. Current snapshot."
      }
      updatedAt={idleStake.captured_at}
      height={236}
      empty={top.length === 0}
      emptyLabel="No idle stake"
    >
      <BarMini
        data={top.map((s, index) => ({
          label: `SN${s.netuid}`,
          value: s.idle_stake_alpha ?? 0,
          color: RANK_COLORS[index % RANK_COLORS.length],
        }))}
        formatValue={formatTao}
        ariaLabel="Idle stake by subnet"
      />
    </ChartCard>
  );
}
