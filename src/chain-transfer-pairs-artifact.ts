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

import {
  buildChainTransferPairs,
  CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
  CHAIN_TRANSFER_PAIR_SORTS,
  CHAIN_TRANSFER_PAIR_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
} from "./chain-transfer-pairs.ts";

export const CHAIN_TRANSFER_PAIRS_PROJECTION_KEY =
  "metagraph/projections/chain-transfer-pairs.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

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
): Promise<ReturnType<typeof buildChainTransferPairs> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(CHAIN_TRANSFER_PAIRS_PROJECTION_KEY);
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
    const label = query.window ?? DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW;
    // A window outside the route's set — or one this artifact does not carry
    // — must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(CHAIN_TRANSFER_PAIR_WINDOWS, label)) return null;
    const sort = query.sort ?? "volume";
    // Only the two precomputed orders exist; an unknown sort must never be
    // answered with a DIFFERENT order's rows.
    if (!CHAIN_TRANSFER_PAIR_SORTS.includes(sort)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      totals?: unknown;
      sorts?: unknown;
    } | null;
    const sorts = win?.sorts as Record<string, unknown> | null | undefined;
    if (typeof sorts !== "object" || sorts === null) return null;
    const pairs = sorts[sort];
    if (!Array.isArray(pairs)) return null;
    // The stored totals row is data-api's totalsRows[0] ?? null; anything
    // else is not the artifact the lane wrote.
    const totals = win?.totals ?? null;
    if (totals !== null && typeof totals !== "object") return null;
    const limit = normalizedLimit(query.limit);
    return buildChainTransferPairs({
      window: label,
      sort,
      observedAt: newestObservedIso(
        (totals as Record<string, unknown> | null)?.["newest_observed"],
      ),
      totals: totals as Record<string, unknown> | null,
      pairs: (pairs as Record<string, unknown>[]).slice(0, limit),
    });
  } catch {
    return null;
  }
}
