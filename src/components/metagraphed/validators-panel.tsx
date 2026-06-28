import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetValidatorsQuery } from "@/lib/metagraphed/queries";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import { TableState } from "@/components/metagraphed/table-state";
import { NeuronTable, taoCompact } from "@/components/metagraphed/neuron-table";

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
      <TableState
        variant="empty"
        title="No active validators"
        description="No permitted validators are indexed for this subnet in the current snapshot — the validator set will populate here once the metagraph is captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {stakeBars.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Validator stake · top {stakeBars.length}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              peak {taoCompact(stakeBars[0]?.value)} τ
            </span>
          </div>
          <BarMini data={stakeBars} />
        </div>
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
