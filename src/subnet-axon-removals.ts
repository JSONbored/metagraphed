// Per-subnet axon-removal activity, DERIVED from daily metagraph state (#10805).
//
// This route used to read the account_events `AxonInfoRemoved` stream. That
// event has zero occurrences in the complete pallet-level stream, genesis to
// head, so the card could only ever be a zero -- and its D1 loader was already
// dead code, reachable from its own tests and nothing else, because the handler
// passed `null` and never called it.
//
// It now answers from `neuron_daily`, through the shared transition definition
// in src/axon-reachability-changes.ts. `removals` counts ONLY miners that
// stopped announcing; a deregistration and a move to an unroutable address are
// carried separately in `changes`, because neither removed anything. Over 38
// days network-wide that split is 105 / 1,915 / 166 -- reporting the sum as
// removals is wrong by 95%.

import {
  axonChangesCoverage,
  axonChangesDerivation,
  axonChangesObservedAt,
  emptyAxonChangeBreakdown,
  type AxonChangeSubnetAggregate,
  type AxonChangesCoverage,
} from "./axon-reachability-changes.ts";
import { roundDp } from "./lib/stats.ts";

type Row = Record<string, unknown>;

// Supported windows (label -> days) + default, matching the sibling routes.
export const SUBNET_AXON_REMOVALS_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const DEFAULT_SUBNET_AXON_REMOVALS_WINDOW = "7d";

// A non-negative whole count from a COUNT() cell (number, numeric string, or
// null), defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Average removals per remover -- how often the same miner stopped announcing
// after re-announcing. No removers means no defined intensity (null), not a
// divide-by-zero and not a zero.
function removalsPerRemover(removals: number, removers: number): number | null {
  if (removers <= 0) return null;
  return roundDp(removals / removers);
}

/**
 * Shape one subnet's card from its folded per-kind aggregate.
 *
 * `removals` IS `stopped_announcing`, and only that. The other two kinds sit
 * in `changes`, stated rather than summed in, so a consumer cannot make the
 * mistake the old contract invited.
 *
 * NOTHING READ IS NOT ZERO. When no coverage is supplied -- the tier declined
 * -- `start_date` is null and every count is 0. A real read always carries
 * dates, so the two are distinguishable without the `degraded` flag this used
 * to need.
 */
export function buildSubnetAxonRemovals(
  aggregate: AxonChangeSubnetAggregate | null | undefined,
  netuid: unknown,
  {
    window,
    coverage,
  }: { window?: unknown; coverage?: AxonChangesCoverage } = {},
): Row {
  const changes = aggregate?.changes ?? emptyAxonChangeBreakdown();
  const distinctRemovers = toCount(aggregate?.distinct_removers);
  const removals = changes.stopped_announcing;
  const resolved = coverage ?? axonChangesCoverage(null, null, null, null);
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: axonChangesObservedAt(resolved.end_date),
    ...resolved,
    distinct_removers: distinctRemovers,
    removals,
    removals_per_remover: removalsPerRemover(removals, distinctRemovers),
    changes,
    derivation: axonChangesDerivation(),
  };
}
