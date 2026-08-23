import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetTurnoverQuery } from "@/lib/metagraphed/queries";
import { FactStrip, FactCell } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";

function pctStr(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

// Higher retention/stability is better; a churned-away set reads as "down".
/**
 * Validator-set & registration turnover scorecard for one subnet (#3343): how
 * much the validator set and neuron population rotated across the selected
 * window's start/end neuron_daily snapshots. `comparable: false` (cold store
 * or single-snapshot window) renders the non-comparable empty state instead of
 * zeroed tiles that would read as flawless retention.
 */
export function TurnoverLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetTurnoverQuery(netuid));
  const meta = data.meta;
  const t = data.data;

  if (!t.comparable) {
    return (
      <EmptyState
        title="Not enough history to compare"
        description="Validator-set and registration turnover is computed by diffing the window's start and end metagraph snapshots. This will appear once at least two daily snapshots have been captured."
        lastChecked={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      <FactStrip variant="grid">
        <FactCell label="Stability score" value={t.stability_score ?? "—"} hint="/ 100" />
        <FactCell
          label="Validator retention"
          value={pctStr(t.validator_retention)}
          hint={`${formatNumber(t.validators_start)} → ${formatNumber(t.validators_end)}`}
        />
        <FactCell
          label="Neuron retention"
          value={pctStr(t.neuron_retention)}
          hint={`${formatNumber(t.neurons_start)} → ${formatNumber(t.neurons_end)}`}
        />
        <FactCell label="Validators entered" value={formatNumber(t.validators_entered)} />
        <FactCell label="Validators exited" value={formatNumber(t.validators_exited)} />
        <FactCell label="UIDs deregistered" value={formatNumber(t.uids_deregistered)} />
      </FactStrip>
      {t.start_date && t.end_date ? (
        <p className="text-11 text-ink-muted">
          Compared {t.start_date} → {t.end_date}
          {t.window ? ` (${t.window})` : ""}
        </p>
      ) : null}
    </div>
  );
}
