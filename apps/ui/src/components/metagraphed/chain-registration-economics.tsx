import { computeRegistrationCostStats } from "@/lib/metagraphed/chain-analytics";
import { formatTao } from "@/lib/metagraphed/format";
import type { SubnetEconomics } from "@/lib/metagraphed/types";

/**
 * Burn (registration cost) chips from the bulk /api/v1/economics endpoint —
 * the only bulk-friendly source for this. There is no bulk "recycled totals"
 * endpoint in the current API (recycled is per-subnet only, GET
 * /subnets/{netuid}/recycled) and no bulk registration-count-trend endpoint
 * either; both would need one call per netuid (~129), blowing this tab's
 * 6-request budget. Scoped out — see the #8378 scope-note comment.
 */
export function ChainRegistrationEconomics({ subnets }: { subnets: SubnetEconomics[] }) {
  const stats = computeRegistrationCostStats(subnets);
  if (stats.count === 0) return null;

  return (
    <dl className="mg-data-measure-grid mg-data-measure-grid--3">
      <Metric label="lowest entry cost" value={formatTao(stats.minTao)} />
      <Metric label="median entry cost" value={formatTao(stats.medianTao)} />
      <Metric label="highest entry cost" value={formatTao(stats.maxTao)} />
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mg-data-measure">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
