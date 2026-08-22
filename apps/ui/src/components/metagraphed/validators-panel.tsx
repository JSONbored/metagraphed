import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetValidatorsQuery } from "@/lib/metagraphed/queries";
import { RankedRails } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { NeuronTable } from "@/components/metagraphed/neuron-table";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { SponsoredValidatorCallout } from "@/components/metagraphed/sponsored-validator-callout";
import { Panel } from "@/components/metagraphed/primitives";
import { railItems } from "@/lib/metagraphed/rails";

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

  if (validators.length === 0) {
    return (
      <EmptyState
        title="No active validators"
        description="No permitted validators are indexed for this subnet in the current snapshot — the validator set will populate here once the metagraph is captured."
        lastChecked={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {sponsored ? <SponsoredValidatorCallout netuid={netuid} validator={sponsored} /> : null}
      {stakeBars.length > 0 ? (
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-13 text-ink-muted">Validator stake · top {stakeBars.length}</span>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-10 text-ink-muted">
                peak {taoCompact(stakeBars[0]?.value)} τ
              </span>
            </span>
          </div>
          <RankedRails
            items={railItems(stakeBars)}
            formatValue={(v) => `${taoCompact(v)} τ`}
            ariaLabel={`Validator stake, top ${stakeBars.length} by stake`}
            onActivate={(item) => onSelect?.(Number(item.label.slice(1)))}
          />
        </Panel>
      ) : null}

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
