import { useSuspenseQuery } from "@tanstack/react-query";
import { UserPlus, UserMinus, RefreshCw, Users, ShieldCheck } from "lucide-react";
import { subnetTurnoverQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { TableState } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";

function pctStr(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

// Higher retention/stability is better; a churned-away set reads as "down".
function retentionTone(v?: number | null): "ok" | "warn" | "down" | "default" {
  if (v == null) return "default";
  if (v >= 0.9) return "ok";
  if (v >= 0.7) return "warn";
  return "down";
}

function stabilityTone(score?: number | null): "ok" | "warn" | "down" | "default" {
  if (score == null) return "default";
  if (score >= 90) return "ok";
  if (score >= 70) return "warn";
  return "down";
}

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
      <TableState
        variant="empty"
        title="Not enough history to compare"
        description="Validator-set and registration turnover is computed by diffing the window's start and end metagraph snapshots. This will appear once at least two daily snapshots have been captured."
        generatedAt={meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          icon={ShieldCheck}
          eyebrow="Stability score"
          value={t.stability_score ?? "—"}
          hint="/ 100"
          tone={stabilityTone(t.stability_score)}
        />
        <StatTile
          icon={RefreshCw}
          eyebrow="Validator retention"
          value={pctStr(t.validator_retention)}
          hint={`${formatNumber(t.validators_start)} → ${formatNumber(t.validators_end)}`}
          tone={retentionTone(t.validator_retention)}
        />
        <StatTile
          icon={RefreshCw}
          eyebrow="Neuron retention"
          value={pctStr(t.neuron_retention)}
          hint={`${formatNumber(t.neurons_start)} → ${formatNumber(t.neurons_end)}`}
          tone={retentionTone(t.neuron_retention)}
        />
        <StatTile
          icon={UserPlus}
          eyebrow="Validators entered"
          value={formatNumber(t.validators_entered)}
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Validators exited"
          value={formatNumber(t.validators_exited)}
        />
        <StatTile
          icon={Users}
          eyebrow="UIDs deregistered"
          value={formatNumber(t.uids_deregistered)}
        />
      </div>
      {t.start_date && t.end_date ? (
        <p className="font-mono text-[11px] text-ink-muted">
          Compared {t.start_date} → {t.end_date}
          {t.window ? ` (${t.window})` : ""}
        </p>
      ) : null}
    </div>
  );
}
