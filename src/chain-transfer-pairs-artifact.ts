// Chain-transfer-pairs served from a SCHEDULED PROJECTION artifact when the
// Postgres tier misses (#9146). Same shape as
// src/chain-transfers-artifact.ts (see that header for the
// projection-vs-reader argument): the chain-transfer-pairs lane stores the
// full-window totals rollup plus the corridor leaderboard in BOTH supported
// sort orders at the route's maximum limit — a smaller ?limit= is a prefix
// slice of the same total order, sliced BEFORE the formatter to keep
// data-api's LIMIT-ed-fetch semantics (top_pair_share itself divides the
// stored full-window MAX by the full-window SUM, so it is limit-independent
// either way).

import { z } from "zod";

import {
  buildChainTransferPairs,
  CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
  CHAIN_TRANSFER_PAIR_SORTS,
  CHAIN_TRANSFER_PAIR_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
} from "./chain-transfer-pairs.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import {
  ProjectionAggregateSchema,
  ProjectionRowsSchema,
} from "../schemas-src/projection-artifact.ts";

export const CHAIN_TRANSFER_PAIRS_PROJECTION_KEY =
  "metagraph/projections/chain-transfer-pairs.json";

/**
 * One cell holds both orders plus the window's totals row.
 *
 * The stored totals row is data-api's `totalsRows[0] ?? null`, so it is the
 * nullable aggregate -- absent and null both mean the window had none, and the
 * card reports observed_at as null rather than declining.
 */
const ChainTransferPairsCellSchema = z.object({
  sorts: z.record(z.string(), z.unknown()),
  totals: ProjectionAggregateSchema,
});

/** The route's limit contract re-applied at the reader: both callers pass
 * already-validated values, but a direct call must not page past the route's
 * own maximum. */
function normalizedLimit(value: unknown): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored)) return CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT;
  return Math.max(0, Math.min(floored, CHAIN_TRANSFER_PAIR_LIMIT_MAX));
}

/** data-api's latestObservedIso over the stored totals rollup: the queried
 * rows' own MAX(observed_at) as ISO, or null. */
function newestObservedIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-transfer-pairs leaderboard for one window/sort, or
 * null when the artifact store cannot answer FAITHFULLY (unbound, missing
 * object, unrecognized body, a window or sort the lane did not precompute)
 * so the caller keeps its schema-stable empty. Decline, never approximate.
 */
export async function loadChainTransferPairsFromArtifact(
  env: Env | null | undefined,
  query: { window?: string | null; sort?: string | null; limit?: unknown },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainTransferPairs> | null> {
  const sort = query.sort ?? "volume";
  // Only the two precomputed orders exist; an unknown sort must never be
  // answered with a DIFFERENT order's rows.
  if (!CHAIN_TRANSFER_PAIR_SORTS.includes(sort)) return null;
  const read = await readProjectionWindow(env, {
    key: CHAIN_TRANSFER_PAIRS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
    windows: CHAIN_TRANSFER_PAIR_WINDOWS,
    cell: ChainTransferPairsCellSchema,
  });
  if (!read) return null;
  // Only the REQUESTED order is parsed, so a malformed order fails only the
  // reads that would have served it.
  const pairs = ProjectionRowsSchema.safeParse(read.cell.sorts[sort]);
  if (!pairs.success) return null;
  const limit = normalizedLimit(query.limit);
  return buildChainTransferPairs({
    window: read.label,
    sort,
    observedAt: newestObservedIso(read.cell.totals?.["newest_observed"]),
    totals: read.cell.totals,
    pairs: pairs.data.slice(0, limit),
  });
}
