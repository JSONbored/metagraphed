// Network-wide registration activity served from a SCHEDULED PROJECTION
// artifact when the Postgres tier misses (#9146).
//
// A PROJECTION, NOT A REQUEST-TIME READ, and that is the whole design point.
// This is a chain-wide aggregate with no selective predicate: a COUNT(*) plus
// two COUNT(DISTINCT hotkey) over every NeuronRegistered row in the window.
// Measured on the live engine (2026-08-03) the per-subnet grouping alone reads
// **186 MB** at ~67 MB/s -- roughly 2.8s. The account-scoped feeds can afford
// a request-time lakehouse read because one address is a selective predicate
// against a big table; this is not that shape. src/account-feeds-cold-tier.ts's
// header draws the same line: chain-wide aggregates moved to scheduled
// projections.
//
// Rows are stored VERBATIM, per the chain-* lane convention: the route's
// ?limit= only slices the leaderboard, and buildChainRegistrations owns that
// slice plus the network rollup and the intensity distribution. One artifact
// therefore serves every window/limit combination the route accepts.

import {
  buildChainRegistrations,
  CHAIN_REGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
} from "./chain-registrations.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsWithAggregateCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_REGISTRATIONS_PROJECTION_KEY =
  "metagraph/projections/chain-registrations.json";

/**
 * The projected registration leaderboard for one window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller keeps
 * its schema-stable empty. Decline, never approximate.
 */
export async function loadChainRegistrationsFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainRegistrations> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_REGISTRATIONS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
    windows: CHAIN_REGISTRATIONS_WINDOWS,
    cell: ProjectionRowsWithAggregateCellSchema,
  });
  if (!read) return null;
  // The network rollup is a SEPARATE aggregate, not a sum of the per-subnet
  // rows: a hotkey registering on three subnets is three subnet-level
  // registrants but one network-wide distinct registrant. Summing the rows
  // would silently overcount, so the lane stores the real network aggregate and
  // this hands it through untouched.
  return buildChainRegistrations(read.cell.rows, {
    window: read.label,
    limit: query.limit,
    networkDistinct: read.cell.network ?? undefined,
  });
}
