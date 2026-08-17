// Chain-weights served from a SCHEDULED PROJECTION artifact (#11419).
//
// ## Why this route needed a lane, when twelve siblings already had one
//
// `/chain/weights` is a network-wide aggregate over a 7d/30d window of
// `account_events`, recomputed on every request. `src/projection-lanes.ts`'s
// own header calls that "the hot-path misuse" R2 SQL's module warns against,
// and twelve chain-wide aggregates already moved behind a cron for exactly this
// reason. This one and its per-identity setters twin did not.
//
// ## What the measurement said, and what it did NOT say
//
// The engine's own metrics (#11436) price the read at 4.9 MiB and 476 R2
// requests for a 7d window -- not a large scan. The problem is not the bytes:
// interleaved sampling of ONE query against ONE subject spanned 2.00s to
// 31.61s, a 15.8x spread wider than the difference between the query shapes
// being compared, with `cache_hits` at ~99.6% of requests. Request-time reads
// against that engine are unpredictable by construction, and
// `QUERY_TIMEOUT_MS` turns the tail into a decline.
//
// So this is not a query that can be tuned faster -- the tuning candidates were
// measured and one of them was SLOWER. It is a read that should not happen
// under a request at all. A cron pays the variance once per interval; a caller
// then pays one R2 GET.
//
// WEIGHTSSET HAS NO HOTKEY, and that is why this lane needed its own argument
// rather than riding the serving one. `account_events.hotkey` is NULL on all
// 50,890,747 WeightsSet rows -- the chain event emits [netuid, uid] and nothing
// else -- so `CHAIN_WEIGHTS_ROLLUP` counts distinct `uid`, and the reader treats
// the identity as the (netuid, uid) PAIR because a uid is unique only within a
// subnet. The lane stores whatever that rollup produced, so the distinct-setter
// semantics are the rollup's and do not change by being precomputed.
//
// The RESPONSE SHAPE is unchanged: the lane stores the same network DISTINCT
// row and per-subnet aggregate the cold tier computes, and this reader hands
// them to the SAME `buildChainWeights` formatter, which owns ranking, the
// network rollup, the intensity distribution and the limit slice.

import {
  buildChainWeights,
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
} from "./chain-weights.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "./route-limits.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsWithAggregateCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_WEIGHTS_PROJECTION_KEY =
  "metagraph/projections/chain-weights.json";

/**
 * The projected chain-weights card for one window, or null when the artifact
 * store cannot answer FAITHFULLY (unbound, missing object, unrecognized body,
 * a window the lane did not precompute) so the caller falls to its next tier.
 * Decline, never approximate.
 */
export async function loadChainWeightsFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainWeights> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_WEIGHTS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_ANALYTICS_WINDOW,
    windows: ANALYTICS_WINDOW_DAYS,
    cell: ProjectionRowsWithAggregateCellSchema,
  });
  if (!read) return null;
  // NO `subnetCount` PASSED, and that is correct here rather than an omission:
  // the lane stores EVERY per-subnet row, so the builder's own `subnets.length`
  // is the true population. #10249's defect was the opposite case -- a loader
  // that capped in SQL and left the builder counting a page under a field
  // named for a population.
  return buildChainWeights(read.cell.rows, {
    window: read.label,
    limit: query.limit ?? CHAIN_WEIGHTS_LIMIT_DEFAULT,
    networkDistinct: read.cell.network ?? undefined,
  });
}
