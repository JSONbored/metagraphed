// Chain-alpha-volume served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as
// src/chain-stake-flow-artifact.ts (see src/chain-transfers-artifact.ts's
// header for the projection-vs-reader argument): the chain-alpha-volume lane
// stores data-api's per-(netuid, event_kind) aggregate rows verbatim for the
// route's one fixed rolling 24h window, and this reader hands them to the
// SAME buildChainAlphaVolume formatter the Postgres tier fed — which owns
// ranking, the network rollup, the distribution, and the limit slice.

import { buildChainAlphaVolume } from "./chain-alpha-volume.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsCellSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_ALPHA_VOLUME_PROJECTION_KEY =
  "metagraph/projections/chain-alpha-volume.json";

/** The route's one window label (fixed 24h, no ?window= param) — kept as a
 * windows-object key so the artifact envelope matches every sibling lane. */
export const ALPHA_VOLUME_WINDOW = "24h";

/**
 * The route's window SET, which for this lane has exactly one member.
 *
 * Spelled as a set anyway so the shared reader applies the same rule it
 * applies everywhere else: a label the route does not publish is a decline,
 * checked before the artifact is opened.
 */
export const ALPHA_VOLUME_WINDOWS = { [ALPHA_VOLUME_WINDOW]: true };

/**
 * The projected chain-alpha-volume leaderboard, or null when the artifact
 * store cannot answer FAITHFULLY (unbound, missing object, unrecognized
 * body, a missing 24h window) so the caller keeps its schema-stable empty.
 * Decline, never approximate.
 */
export async function loadChainAlphaVolumeFromArtifact(
  env: Env | null | undefined,
  query: {
    limit?: number;
    /** Passed straight to the formatter for vol_mcap_ratio (#9526). Resolved by
     * the caller, not here: this reader's contract is "shape the artifact or
     * decline", and reaching into the economics tier from inside it would give
     * a second store the power to fail a read that the artifact can answer. */
    marketCapByNetuid?: Map<number, number> | null;
  },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainAlphaVolume> | null> {
  const read = await readProjectionWindow(env, {
    key: CHAIN_ALPHA_VOLUME_PROJECTION_KEY,
    network,
    window: ALPHA_VOLUME_WINDOW,
    defaultWindow: ALPHA_VOLUME_WINDOW,
    windows: ALPHA_VOLUME_WINDOWS,
    cell: ProjectionRowsCellSchema,
  });
  if (!read) return null;
  return buildChainAlphaVolume(read.cell.rows, {
    limit: query.limit,
    marketCapByNetuid: query.marketCapByNetuid ?? null,
  });
}
