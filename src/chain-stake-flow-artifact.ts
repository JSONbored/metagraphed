// Chain-stake-flow served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as src/chain-transfers-artifact.ts
// (see that header for the projection-vs-reader argument): the
// chain-stake-flow lane stores data-api's per-(netuid, event_kind) aggregate
// rows verbatim for every supported window, and this reader hands them to the
// SAME buildChainStakeFlow formatter the Postgres tier fed — which owns
// ranking, the network rollup, the distribution, and the limit slice, so one
// artifact serves every window/limit combination the route accepts.

import {
  buildChainStakeFlow,
  CHAIN_STAKE_FLOW_WINDOWS,
  DEFAULT_CHAIN_STAKE_FLOW_WINDOW,
} from "./chain-stake-flow.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_STAKE_FLOW_PROJECTION_KEY =
  "metagraph/projections/chain-stake-flow.json";

/**
 * The projected chain-stake-flow leaderboard for one window, or null when
 * the artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller
 * keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainStakeFlowFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainStakeFlow> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_STAKE_FLOW_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_CHAIN_STAKE_FLOW_WINDOW,
    windows: CHAIN_STAKE_FLOW_WINDOWS,
    cell: ProjectionRowsCellSchema,
  });
  if (!read) return null;
  return buildChainStakeFlow(read.cell.rows, {
    window: read.label,
    limit: query.limit,
  });
}
