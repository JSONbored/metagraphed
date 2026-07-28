import { StatTile } from "@jsonbored/ui-kit";
import { computeRegistrationCostStats } from "@/lib/metagraphed/chain-analytics";
import { formatTao } from "@/lib/metagraphed/format";
import type { SubnetEconomics } from "@/lib/metagraphed/types";

/**
 * Burn (registration cost) chips from the bulk /api/v1/economics endpoint —
 * the only bulk-friendly source for this. There is no bulk "recycled totals"
 * endpoint in the current API (recycled is per-subnet only, GET
 * /subnets/{netuid}/recycled) and no bulk registration-count-trend endpoint
 * either; both would need one call per subnet (~129), blowing this tab's
 * 6-request budget. Scoped out — see the #8378 scope-note comment.
 */
export function ChainRegistrationEconomics({ subnets }: { subnets: SubnetEconomics[] }) {
  const stats = computeRegistrationCostStats(subnets);
  if (stats.count === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile eyebrow="Lowest registration cost" value={formatTao(stats.minTao)} />
      <StatTile eyebrow="Median registration cost" value={formatTao(stats.medianTao)} />
      <StatTile eyebrow="Highest registration cost" value={formatTao(stats.maxTao)} />
    </div>
  );
}
