// Chain-stake-transfers served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as
// src/chain-stake-flow-artifact.ts (see src/chain-transfers-artifact.ts's
// header for the projection-vs-reader argument): the chain-stake-transfers
// lane stores data-api's network DISTINCT row and per-subnet StakeTransferred
// aggregate verbatim for every supported window, and this reader hands them
// to the SAME buildChainStakeTransfers formatter the Postgres tier fed —
// which owns ranking, the network rollup, the distribution, and the limit
// slice.

import {
  buildChainStakeTransfers,
  CHAIN_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_CHAIN_STAKE_TRANSFERS_WINDOW,
} from "./chain-stake-transfers.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsWithAggregateCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_STAKE_TRANSFERS_PROJECTION_KEY =
  "metagraph/projections/chain-stake-transfers.json";

/**
 * The projected chain-stake-transfers leaderboard for one window, or null
 * when the artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller
 * keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainStakeTransfersFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainStakeTransfers> | null> {
  // The stored network row is data-api's `networkRows[0] ?? null`; anything
  // else is not the artifact the lane wrote, and the aggregate cell declines it.
  const read = await readProjectionWindow(env, {
    key: CHAIN_STAKE_TRANSFERS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_CHAIN_STAKE_TRANSFERS_WINDOW,
    windows: CHAIN_STAKE_TRANSFERS_WINDOWS,
    cell: ProjectionRowsWithAggregateCellSchema,
  });
  if (!read) return null;
  return buildChainStakeTransfers(read.cell.rows, {
    window: read.label,
    limit: query.limit,
    networkDistinct: read.cell.network ?? undefined,
  });
}
