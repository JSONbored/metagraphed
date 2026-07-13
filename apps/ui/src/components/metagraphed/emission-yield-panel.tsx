import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Server, Users, Coins } from "lucide-react";
import { chainYieldQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";

// #3472: network emission-yield summary — the return-rate companion to the
// decentralization scorecard, from the newly-wired chainYieldQuery. Aggregate
// network return (total emission / total stake) split by validator/miner role,
// plus the per-neuron return spread. The data layer is untouched; this only
// consumes the normalized shape via useQuery.

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(4)}%`;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

/**
 * Network emission-yield summary: aggregate return (total emission over total
 * stake) network-wide and split by validator / miner role, plus the per-neuron
 * return distribution (median and upper-percentile spread). The return-rate
 * companion to the decentralization scorecard, at network scope. Fetches the
 * chain-yield snapshot once and renders a KPI-tile grid.
 */
export function EmissionYieldPanel() {
  const { data: res, isPending } = useQuery(chainYieldQuery());
  const y = res?.data;

  if (isPending && !y) {
    return <Notice>Loading network emission yield…</Notice>;
  }

  if (!y || y.neuron_count === 0) {
    return (
      <EmptyState
        title="No network emission-yield metrics"
        description="Chain-wide emission yield (total emission over total stake, split by validator/miner role) and the per-neuron return spread are computed from the metagraph snapshot and will appear here once captured."
        lastChecked={res?.meta?.generated_at}
      />
    );
  }

  const dist = y.distribution;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          icon={TrendingUp}
          eyebrow="Network yield"
          value={fmtPct(y.network_yield)}
          hint="Emission ÷ total stake"
          tone="accent"
        />
        <StatTile
          icon={Server}
          eyebrow="Validator yield"
          value={fmtPct(y.validator_yield)}
          hint={`${formatNumber(y.validator_count)} validators`}
        />
        <StatTile
          icon={Users}
          eyebrow="Miner yield"
          value={fmtPct(y.miner_yield)}
          hint={`${formatNumber(y.miner_count)} miners`}
        />
      </div>

      {dist ? (
        <div>
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Per-neuron return spread
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              icon={Coins}
              eyebrow="Median"
              value={fmtPct(dist.median)}
              hint={`${formatNumber(dist.count)} neurons`}
            />
            <StatTile
              icon={Coins}
              eyebrow="75th pct"
              value={fmtPct(dist.p75)}
              hint="per-neuron return"
            />
            <StatTile
              icon={Coins}
              eyebrow="90th pct"
              value={fmtPct(dist.p90)}
              hint="per-neuron return"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
