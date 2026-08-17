// Chain-weight-setters served from a SCHEDULED PROJECTION artifact (#11418).
//
// The per-IDENTITY sibling of src/chain-weights-artifact.ts. That one stores a
// row per netuid; this stores a row per (netuid, uid) plus the window's
// ungrouped totals, which is the shape `buildChainWeightSetters` needs -- the
// totals ride separately because the row page is capped by `limit`, so a share
// computed against a summed page would grow as the page shrank.
//
// WHY A LANE. `/chain/weights/setters` is a network-wide leaderboard over a
// 7d/30d window of `account_events`, recomputed per request. Priced with the
// engine's own metrics (#11436) it reads 2.7-166 MiB depending on the window,
// and the read is not the problem: interleaved sampling of one query against
// one subject spanned 2.00s-31.61s with `cache_hits` at ~99.6%, and
// `QUERY_TIMEOUT_MS` turns that tail into a decline. A cron pays that variance
// once per interval.
//
// WEIGHTSSET HAS NO HOTKEY. `account_events.hotkey` is NULL on all 50,890,747
// WeightsSet rows, so the identity is `uid` and the grouping is the
// (netuid, uid) PAIR -- a uid is unique only within a subnet. The lane stores
// whatever the rollup produced, so those semantics are the rollup's and do not
// change by being precomputed.

import {
  buildChainWeightSetters,
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
} from "./chain-weight-setters.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "./route-limits.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsWithTotalsCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_WEIGHT_SETTERS_PROJECTION_KEY =
  "metagraph/projections/chain-weight-setters.json";

/**
 * The projected weight-setter leaderboard for one window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller falls
 * to its next tier. Decline, never approximate.
 */
export async function loadChainWeightSettersFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainWeightSetters> | null> {
  // `ProjectionRowsWithTotalsCellSchema` requires `totals`, which is the
  // DENOMINATOR: a leaderboard without one publishes shares of nothing. Unlike
  // the per-netuid readers there is nothing for the builder to fall back to, so
  // a cell missing it declines rather than serving shares of an unknown whole.
  const read = await readProjectionWindow(env, {
    key: CHAIN_WEIGHT_SETTERS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_ANALYTICS_WINDOW,
    windows: ANALYTICS_WINDOW_DAYS,
    cell: ProjectionRowsWithTotalsCellSchema,
  });
  if (!read) return null;
  return buildChainWeightSetters(read.cell.rows, read.cell.totals, {
    window: read.label,
    limit: query.limit ?? CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  });
}
