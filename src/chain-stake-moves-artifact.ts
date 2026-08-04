// Chain-stake-moves served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as
// src/chain-stake-transfers-artifact.ts (see
// src/chain-transfers-artifact.ts's header for the projection-vs-reader
// argument): the chain-stake-moves lane stores data-api's network DISTINCT
// row and per-subnet StakeMoved aggregate verbatim for every supported
// window, and this reader hands them to the SAME buildChainStakeMoves
// formatter the Postgres tier fed — which owns ranking, the network rollup,
// the distribution, and the limit slice.

import {
  buildChainStakeMoves,
  CHAIN_STAKE_MOVES_WINDOWS,
  DEFAULT_CHAIN_STAKE_MOVES_WINDOW,
} from "./chain-stake-moves.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  projectionKey,
} from "./chain-network.ts";

export const CHAIN_STAKE_MOVES_PROJECTION_KEY =
  "metagraph/projections/chain-stake-moves.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The projected chain-stake-moves leaderboard for one window, or null when
 * the artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute) so the caller
 * keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainStakeMovesFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; limit?: number },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainStakeMoves> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(
      projectionKey(CHAIN_STAKE_MOVES_PROJECTION_KEY, network),
    );
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a
    // guess — same contract as src/top-holders-artifact.ts.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const label = query.window ?? DEFAULT_CHAIN_STAKE_MOVES_WINDOW;
    // A window outside the route's set — or one this artifact does not carry
    // — must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(CHAIN_STAKE_MOVES_WINDOWS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      network?: unknown;
      rows?: unknown;
    } | null;
    if (!Array.isArray(win?.rows)) return null;
    // The stored network row is data-api's networkRows[0] ?? null; anything
    // else is not the artifact the lane wrote.
    const chainWide = win.network ?? null;
    if (chainWide !== null && typeof chainWide !== "object") return null;
    return buildChainStakeMoves(win.rows as Record<string, unknown>[], {
      window: label,
      limit: query.limit,
      networkDistinct:
        (chainWide as Record<string, unknown> | null) ?? undefined,
    });
  } catch {
    return null;
  }
}
