import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetValidatorsQuery } from "@/lib/metagraphed/queries";
import {
  TableState,
  RealtimeFreshness,
  BarMini,
  TreemapMini,
  type TreemapMiniDatum,
} from "@jsonbored/ui-kit";
import { NeuronTable } from "@/components/metagraphed/neuron-table";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { SponsoredValidatorCallout } from "@/components/metagraphed/sponsored-validator-callout";
import { TopShareCaption } from "@/components/metagraphed/top-share-caption";
import { Panel } from "@/components/metagraphed/primitives";

const TOP_N = 10;

/**
 * Top-validator stake distribution + leaderboard for one subnet. Reads the
 * pre-filtered /validators set (permitted neurons, already stake-ranked) and
 * reuses the shared NeuronTable. Rows drill into the per-UID snapshot.
 */
export function ValidatorsTableLoader({
  netuid,
  onSelect,
  selectedUid,
}: {
  netuid: number;
  onSelect?: (uid: number) => void;
  selectedUid?: number | null;
}) {
  const { data } = useSuspenseQuery(subnetValidatorsQuery(netuid));
  const meta = data.meta;
  const validators = data.data.validators;
  const sponsored = validators.find((v) => v.featured && v.hotkey);

  const stakeBars = useMemo(() => {
    return [...validators]
      .filter((v) => typeof v.stake_tao === "number" && v.stake_tao > 0)
      .sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0))
      .slice(0, TOP_N)
      .map((v) => ({
        label: `#${v.uid}`,
        value: Number((v.stake_tao ?? 0).toFixed(0)),
        color: "var(--accent)",
      }));
  }, [validators]);

  // Same top-N stake-ranked set as `stakeBars`, but sized by area so the
  // concentration of stake across the leading validators reads at a glance —
  // a complement to the ranked bar list, not a replacement. Shares are derived
  // client-side from the values already in hand (no network-wide total exists
  // on the payload).
  const stakeTiles = useMemo<TreemapMiniDatum[]>(
    () => stakeBars.map((b) => ({ label: b.label, value: b.value, color: b.color })),
    [stakeBars],
  );

  if (validators.length === 0) {
    return (
      <TableState
        variant="empty"
        title="No active validators"
        description="No permitted validators are indexed for this subnet in the current snapshot — the validator set will populate here once the metagraph is captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  const freshness = <RealtimeFreshness at={meta?.generated_at} />;

  return (
    <div className="space-y-4">
      {sponsored ? <SponsoredValidatorCallout netuid={netuid} validator={sponsored} /> : null}
      {stakeBars.length > 0 ? (
        <Panel as="div" dense>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mg-type-micro text-ink-muted">
              Validator stake · top {stakeBars.length}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <span className="font-mono text-[10px] text-ink-muted">
                peak {taoCompact(stakeBars[0]?.value)} τ
              </span>
              {freshness}
            </span>
          </div>
          <BarMini data={stakeBars} />
          {stakeTiles.length > 1 ? (
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 mg-type-micro text-ink-muted">
                Stake dominance
                <TopShareCaption n={stakeTiles.length} />
              </div>
              <TreemapMini
                data={stakeTiles}
                formatValue={(v) => `${taoCompact(v)} τ`}
                ariaLabel={`Validator stake dominance across the top ${stakeTiles.length} validators, sized by stake share`}
              />
            </div>
          ) : null}
        </Panel>
      ) : (
        <div className="flex items-center justify-end">{freshness}</div>
      )}

      <NeuronTable
        netuid={netuid}
        rows={validators}
        variant="validator"
        defaultField="stake_tao"
        onSelect={onSelect}
        selectedUid={selectedUid}
      />
    </div>
  );
}
