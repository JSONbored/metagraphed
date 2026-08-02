import { BarMini } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import { formatTao } from "@/lib/metagraphed/format";
import type { ChainIdleStake } from "@/lib/metagraphed/types";

const MAX_SHOWN = 8;

/** Also a current snapshot — /api/v1/chain/idle-stake has no `window` param. */
export function ChainIdleStakeSnapshot({ idleStake }: { idleStake: ChainIdleStake }) {
  const top = [...idleStake.subnets]
    .filter((s) => (s.idle_stake_alpha ?? 0) > 0)
    .sort((a, b) => (b.idle_stake_alpha ?? 0) - (a.idle_stake_alpha ?? 0))
    .slice(0, MAX_SHOWN);

  return (
    <ChartCard
      title="Idle stake by subnet"
      caption={
        idleStake.total_idle_stake_alpha != null
          ? `${formatTao(idleStake.total_idle_stake_alpha)} idle network-wide — current snapshot, top ${top.length} subnets shown.`
          : "Current snapshot — stake registered to a subnet with no corresponding active neuron."
      }
      updatedAt={idleStake.captured_at}
      height={140}
      empty={top.length === 0}
      emptyLabel="No idle stake"
    >
      <BarMini
        data={top.map((s) => ({ label: `SN${s.netuid}`, value: s.idle_stake_alpha ?? 0 }))}
        formatValue={formatTao}
        ariaLabel="Idle stake by subnet"
      />
    </ChartCard>
  );
}
