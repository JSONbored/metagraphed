// Network-wide axon reachability changes, DERIVED from daily metagraph state
// (#10805).
//
// This route used to read the account_events `AxonInfoRemoved` stream, which
// has zero occurrences in the complete pallet-level stream, genesis to head --
// so it answered a permanent zero on every scope, in every window.
//
// It now answers from `neuron_daily`, through the shared transition definition
// in src/axon-reachability-changes.ts. `removals` counts ONLY miners that
// stopped announcing. A deregistration (the UID changed hands) and a move to
// an unroutable address (the miner is still announcing) are carried in
// `changes` instead, because neither removed anything: over 38 days
// network-wide the split is 105 / 1,915 / 166.
//
// THE LEADERBOARD RANKS BY REMOVALS, NOT BY TOTAL. Ranking by total puts
// SN126's 160 moves above every genuine withdrawal on the network, which is
// precisely the misreading this family exists to prevent.

import { roundDp, median, percentile } from "./lib/stats.ts";
import { clampRowLimit } from "../workers/request-params.ts";
import {
  axonChangesCoverage,
  axonChangesDerivation,
  axonChangesObservedAt,
  emptyAxonChangeBreakdown,
  rankAxonChangeSubnets,
  sumAxonChangeBreakdowns,
  type AxonChangeBreakdown,
  type AxonChangeSubnetAggregate,
  type AxonChangesCoverage,
  type AxonChangesDerivation,
} from "./axon-reachability-changes.ts";

export const CHAIN_AXON_REMOVALS_LIMIT_DEFAULT = 20;
export const CHAIN_AXON_REMOVALS_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics
// window set (7d/30d, default 7d). Kept next to the loader so the MCP tool's input
// schema and runtime validation cannot drift from the endpoint.
export const CHAIN_AXON_REMOVALS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_AXON_REMOVALS_WINDOW = "7d";

// Round a removals-per-remover ratio to a stable precision (2dp). Always finite and
// non-negative here (events / distinct hotkeys, with the divisor guarded below).

// A non-negative whole count from a COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Average AxonInfoRemoved events per distinct hotkey — the subnet's re-teardown intensity (1.0
// means each remover removed once; higher means hotkeys removed an axon repeatedly after
// re-announcing). A subnet with no removers has no defined intensity (null), not a divide-by-zero.
function removalsPerRemover(removals: number, removers: number): number | null {
  if (removers <= 0) return null;
  return roundDp(removals / removers);
}

export interface IntensityDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
}

// Spread of the per-subnet re-teardown intensity across every subnet with removal activity:
// count, mean, and min / p25 / p50 / p75 / p90 / max. Null when no subnet saw a removal.
function intensityDistribution(values: number[]): IntensityDistribution | null {
  /* v8 ignore next -- defensive: only called with one value per subnet, and the builder returns
     the empty block (distribution null) before this runs when there are no subnets */
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: roundDp(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25)!,
    p50: roundDp(median(ascending)!),
    p75: percentile(ascending, 75)!,
    p90: percentile(ascending, 90)!,
    max: ascending[ascending.length - 1],
  };
}

export interface ChainAxonRemovalsNetwork {
  distinct_removers: number;
  removals: number;
  removals_per_remover: number | null;
}

export interface ChainAxonRemovalsSubnet {
  netuid: number;
  distinct_removers: number;
  removals: number;
  /** Null when nobody stopped announcing on this subnet. */
  removals_per_remover: number | null;
  changes: AxonChangeBreakdown;
}

export interface ChainAxonRemovalsResult extends AxonChangesCoverage {
  schema_version: 1;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainAxonRemovalsNetwork;
  intensity_distribution: IntensityDistribution | null;
  subnets: ChainAxonRemovalsSubnet[];
  /** The full three-way split, network-wide. */
  changes: AxonChangeBreakdown;
  derivation: AxonChangesDerivation;
}

/**
 * Shape the network-wide scorecard from the folded per-subnet aggregates.
 *
 * `subnets` is ranked by REMOVALS (miners that stopped announcing), then by
 * total, then by netuid -- see the module header for why total alone is the
 * wrong key. `subnet_count` and the distribution span every subnet with a
 * change, so the spread stays network-wide even when `limit` truncates.
 *
 * NOTHING READ IS NOT ZERO: with no coverage the dates are null and every
 * count is 0, which is how a declined tier is told apart from a quiet network.
 */
export function buildChainAxonRemovals(
  aggregates: readonly AxonChangeSubnetAggregate[] | null | undefined,
  {
    window,
    limit = CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
    coverage,
    networkDistinctRemovers,
  }: {
    window?: string | null;
    limit?: number;
    coverage?: AxonChangesCoverage;
    /**
     * Distinct hotkeys that stopped announcing anywhere in the window.
     *
     * NOT the sum of the per-subnet counts: one hotkey that stopped on three
     * subnets is one remover. Only the caller's own network-wide COUNT
     * DISTINCT can say, so an absent value is 0 rather than a guess.
     */
    networkDistinctRemovers?: unknown;
  } = {},
): ChainAxonRemovalsResult {
  const list = (aggregates ?? []).filter(Boolean);
  const normalizedLimit = clampRowLimit(
    limit,
    CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
    CHAIN_AXON_REMOVALS_LIMIT_MAX,
  );
  const resolved = coverage ?? axonChangesCoverage(null, null, null, null);
  const ranked = rankAxonChangeSubnets(list);
  const networkChanges = sumAxonChangeBreakdowns(list);
  const networkRemovers = toCount(networkDistinctRemovers);

  const subnets: ChainAxonRemovalsSubnet[] = ranked.map((entry) => ({
    netuid: entry.netuid,
    distinct_removers: entry.distinct_removers,
    removals: entry.changes.stopped_announcing,
    // Null where nobody stopped -- a subnet whose changes are all moves has no
    // teardown intensity, and 0 would claim it measured one.
    removals_per_remover: removalsPerRemover(
      entry.changes.stopped_announcing,
      entry.distinct_removers,
    ),
    changes: entry.changes,
  }));

  // Only subnets that actually had a removal have an intensity; folding in the
  // move-only subnets as zeroes would drag the distribution toward a teardown
  // rate nobody exhibited.
  const intensities = subnets
    .map((subnet) => subnet.removals_per_remover)
    .filter((value): value is number => typeof value === "number");

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: axonChangesObservedAt(resolved.end_date),
    ...resolved,
    subnet_count: subnets.length,
    network: {
      distinct_removers: networkRemovers,
      removals: networkChanges.stopped_announcing,
      removals_per_remover: removalsPerRemover(
        networkChanges.stopped_announcing,
        networkRemovers,
      ),
    },
    intensity_distribution:
      intensities.length === 0 ? null : intensityDistribution(intensities),
    subnets: subnets.slice(0, normalizedLimit),
    changes:
      networkChanges.total === 0 ? emptyAxonChangeBreakdown() : networkChanges,
    derivation: axonChangesDerivation(),
  };
}
