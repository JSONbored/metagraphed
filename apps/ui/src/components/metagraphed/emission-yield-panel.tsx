import { FactStrip, FactCell } from "@jsonbored/ui-kit";
import { useSuspenseQuery } from "@tanstack/react-query";
import { chainYieldQuery } from "@/lib/metagraphed/queries";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";

// #3472: network emission-yield summary — the return-rate companion to the
// decentralization scorecard, from the newly-wired chainYieldQuery. Aggregate
// network return (total emission / total stake) split by validator/miner role,
// plus the per-neuron return spread. The data layer is untouched; this only
// consumes the normalized shape via useSuspenseQuery.

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(4)}%`;
}

// Suspense fallback that mirrors the panel's own two 3-tile rows (network/
// validator/miner yield, then median/75th/90th per-neuron return) so the
// skeleton occupies the same height as the loaded content -- matches
// NetworkDecentralizationSkeleton's convention for its sibling section
// immediately above this one on the status page (#6389).
export function EmissionYieldSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px]" />
        ))}
      </div>
      <div>
        <Skeleton className="mb-3 h-3 w-48" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px]" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Network emission-yield summary: aggregate return (total emission over total
 * stake) network-wide and split by validator / miner role, plus the per-neuron
 * return distribution (median and upper-percentile spread). The return-rate
 * companion to the decentralization scorecard, at network scope. Fetches the
 * chain-yield snapshot once and renders a KPI-tile grid.
 *
 * Suspense-driven loading (the Suspense fallback in status.tsx renders
 * EmissionYieldSkeleton) and QueryErrorBoundary-driven errors, matching
 * every sibling section on the status page -- so a fetch error surfaces as a
 * distinct error state rather than being conflated with a legitimately-empty
 * result below (#6389, mirroring #3966's fix for this page's other panels).
 */
export function EmissionYieldPanel() {
  const { data: res } = useSuspenseQuery(chainYieldQuery());
  const y = res?.data;

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
      <FactStrip variant="grid">
        <FactCell
          label="Network yield"
          value={fmtPct(y.network_yield)}
          hint="Emission ÷ total stake"
        />
        <FactCell
          label="Validator yield"
          value={fmtPct(y.validator_yield)}
          hint={`${formatNumber(y.validator_count)} validators`}
        />
        <FactCell
          label="Miner yield"
          value={fmtPct(y.miner_yield)}
          hint={`${formatNumber(y.miner_count)} miners`}
        />
      </FactStrip>

      {dist ? (
        <div>
          <div className="mb-3 text-13 text-ink-muted">Per-neuron return spread</div>
          <FactStrip variant="grid">
            <FactCell
              label="Median"
              value={fmtPct(dist.median)}
              hint={`${formatNumber(dist.count)} neurons`}
            />
            <FactCell label="75th pct" value={fmtPct(dist.p75)} hint="per-neuron return" />
            <FactCell label="90th pct" value={fmtPct(dist.p90)} hint="per-neuron return" />
          </FactStrip>
        </div>
      ) : null}
    </div>
  );
}
