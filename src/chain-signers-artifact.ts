// Chain-signers served from a SCHEDULED PROJECTION artifact when the Postgres
// tier misses (#9146). Same shape as src/chain-transfers-artifact.ts (see
// that header for the projection-vs-reader argument): the chain-signers lane
// stores the leaderboard in BOTH supported sort orders at the route's maximum
// limit — a smaller ?limit= is a prefix slice of the same total order,
// sliced BEFORE the formatter to keep data-api's LIMIT-ed-fetch semantics —
// plus the separate freshness read the live tier needs (grouped rows carry
// last_tx_block, not a network observed_at).
//
// The optional call_module scope is NOT precomputed (its value space is
// unbounded), so a filtered call declines to the schema-stable empty rather
// than serving unfiltered numbers under a filtered label.

import { z } from "zod";

import { buildChainSigners } from "./chain-analytics.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsSchema } from "../schemas-src/projection-artifact.ts";
import { CHAIN_SIGNERS_SORTS } from "./chain-query-loaders.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";

export const CHAIN_SIGNERS_PROJECTION_KEY =
  "metagraph/projections/chain-signers.json";

/**
 * One cell holds BOTH orders, keyed by `sort`. `sorts` is pinned only as an
 * object; the requested order's rows are parsed at the call site.
 */
const ChainSignersCellSchema = z.object({
  sorts: z.record(z.string(), z.unknown()),
  newest_observed: z.unknown().optional(),
});

/** The REST route's limit contract (workers/request-handlers/analytics.ts's
 * parseLimitParam({defaultLimit: 50, maxLimit: 100}) — hardcoded there, so
 * single-sourced here for the lane writer and this reader). */
export const CHAIN_SIGNERS_LIMIT_DEFAULT = 50;
export const CHAIN_SIGNERS_LIMIT_MAX = 100;

/** The route's limit contract re-applied at the reader: both callers pass
 * already-validated values, but a direct call must not page past the route's
 * own maximum. */
function normalizedLimit(value: unknown): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored)) return CHAIN_SIGNERS_LIMIT_DEFAULT;
  return Math.max(0, Math.min(floored, CHAIN_SIGNERS_LIMIT_MAX));
}

/** data-api's latestObservedIso over the stored freshness read. */
function newestObservedIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-signers leaderboard for one window/sort, or null when
 * the artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window or sort the lane did not precompute, or a
 * call_module scope — which is never precomputed) so the caller keeps its
 * schema-stable empty. Decline, never approximate.
 */
export async function loadChainSignersFromArtifact(
  env: Env | null | undefined,
  query: {
    window?: string | null;
    sort?: string | null;
    limit?: unknown;
    callModule?: string | null;
  },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainSigners> | null> {
  // A pallet-scoped call has no precomputed answer; serving the unfiltered
  // leaderboard under a filtered label would be a wrong answer, not a
  // degraded one.
  if (typeof query.callModule === "string" && query.callModule.length > 0)
    return null;
  const sort = query.sort ?? "tx_count";
  // Only the two precomputed orders exist; an unknown sort must never be
  // answered with a DIFFERENT order's rows.
  if (!CHAIN_SIGNERS_SORTS.includes(sort)) return null;
  const read = await readProjectionWindow(env, {
    key: CHAIN_SIGNERS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_ANALYTICS_WINDOW,
    windows: ANALYTICS_WINDOW_DAYS,
    cell: ChainSignersCellSchema,
  });
  if (!read) return null;
  // Only the REQUESTED order is parsed, so a malformed order fails only the
  // reads that would have served it.
  const rows = ProjectionRowsSchema.safeParse(read.cell.sorts[sort]);
  if (!rows.success) return null;
  const limit = normalizedLimit(query.limit);
  return buildChainSigners({
    window: read.label,
    sort,
    observedAt: newestObservedIso(read.cell.newest_observed),
    rows: rows.data.slice(0, limit),
  });
}
