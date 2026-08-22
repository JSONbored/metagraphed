import { useNavigate } from "@tanstack/react-router";
import { RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { EmptyState } from "@/components/metagraphed/states";
import { buildStakeFlowRails } from "@/lib/metagraphed/chain-analytics";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import type { ChainStakeFlow, GlobalValidators } from "@/lib/metagraphed/types";

/**
 * The Analytics tab's centerpiece (#8378), as two rails side by side: the
 * top subnets by windowed stake movement (a real flow, from stake-flow) and
 * the top validators by their CURRENT stake in those subnets (from the
 * global validator leaderboard — no endpoint gives windowed flow at
 * validator granularity). The captions say so; the two are different kinds
 * of number.
 */
export function ChainStakeFlowRails({
  stakeFlow,
  validators,
  window,
}: {
  stakeFlow: ChainStakeFlow;
  validators: GlobalValidators;
  window: "7d" | "30d";
}) {
  const navigate = useNavigate();
  const rails = buildStakeFlowRails(stakeFlow, validators);

  if (rails.shownNetuids.length === 0) {
    return (
      <Panel title="Stake flow">
        <EmptyState title="No stake movement in this window" />
      </Panel>
    );
  }

  const netuidOf = new Map<string, number>();
  const subnetItems: RankedRailItem[] = rails.subnets.map((s) => {
    const key = `subnet:${s.netuid}`;
    netuidOf.set(key, s.netuid);
    return {
      key,
      label: `SN${s.netuid}`,
      value: s.grossFlowTao,
      detail: [
        { key: "direction", label: "direction", value: s.direction },
        { key: "net", label: "net flow", value: formatTao(s.netFlowTao) },
        { key: "staked", label: "staked", value: formatTao(s.stakedTao) },
        { key: "unstaked", label: "unstaked", value: formatTao(s.unstakedTao) },
      ],
    };
  });
  const hotkeyOf = new Map<string, string>();
  const validatorItems: RankedRailItem[] = rails.validators.map((v) => {
    const key = `validator:${v.hotkey}`;
    hotkeyOf.set(key, v.hotkey);
    return {
      key,
      label: resolveAddress(v.hotkey).display,
      value: v.stakeInShownTao,
      detail: [
        { key: "subnets", label: "of the subnets shown", value: formatNumber(v.subnetCount) },
      ],
    };
  });

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Panel
        title={`Subnets by ${window} stake movement`}
        caption={`Gross stake moved in the window, top ${rails.subnets.length}.`}
      >
        <RankedRails
          items={subnetItems}
          formatValue={formatTao}
          ariaLabel={`Subnets ranked by ${window} stake movement`}
          source="chain-stake-flow-subnets"
          onActivate={(item) => {
            const netuid = netuidOf.get(item.key);
            if (netuid !== undefined) navigate({ to: "/subnets/$netuid", params: { netuid } });
          }}
        />
      </Panel>
      <Panel
        title="Validators by current stake in those subnets"
        caption="Current holdings, not flow — the leaderboard has no windowed breakdown by validator."
      >
        <RankedRails
          items={validatorItems}
          formatValue={formatTao}
          ariaLabel="Validators ranked by current stake in the subnets shown"
          source="chain-stake-flow-validators"
          onActivate={(item) => {
            const hotkey = hotkeyOf.get(item.key);
            if (hotkey !== undefined) navigate({ to: "/validators/$hotkey", params: { hotkey } });
          }}
        />
      </Panel>
    </div>
  );
}
