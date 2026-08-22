import { RankedRails } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { EmptyState } from "@/components/metagraphed/states";
import { formatTao } from "@/lib/metagraphed/format";
import type { ChainIdleStake } from "@/lib/metagraphed/types";
import { railItems } from "@/lib/metagraphed/rails";

const MAX_SHOWN = 8;

/** Also a current snapshot — /api/v1/chain/idle-stake has no `window` param. */
export function ChainIdleStakeSnapshot({ idleStake }: { idleStake: ChainIdleStake }) {
  const top = [...idleStake.subnets]
    .filter((s) => (s.idle_stake_alpha ?? 0) > 0)
    .sort((a, b) => (b.idle_stake_alpha ?? 0) - (a.idle_stake_alpha ?? 0))
    .slice(0, MAX_SHOWN);

  return (
    <Panel
      title="Idle stake by subnet"
      caption={
        idleStake.total_idle_stake_alpha != null
          ? `${formatTao(idleStake.total_idle_stake_alpha)} idle network-wide — current snapshot, top ${top.length} subnets shown.`
          : "Current snapshot — stake registered to a subnet with no corresponding active neuron."
      }
    >
      {top.length === 0 ? (
        <EmptyState title="No idle stake" />
      ) : (
        <RankedRails
          items={railItems(
            top.map((s) => ({
              label: `SN${s.netuid}`,
              value: s.idle_stake_alpha ?? 0,
              href: `/subnets/${s.netuid}`,
            })),
          )}
          formatValue={formatTao}
          ariaLabel="Idle stake by subnet"
        />
      )}
    </Panel>
  );
}
