// Chain-calls served from a SCHEDULED PROJECTION artifact when the Postgres
// tier misses (#9146). Same shape as src/chain-transfers-artifact.ts (see
// that header for the projection-vs-reader argument): the chain-calls lane
// stores BOTH group_by variants' grouped rows at the route's maximum limit —
// a smaller ?limit= is a prefix slice of the same total order — plus the
// full-window share denominator read separately, pre-LIMIT, exactly like the
// live tier. The slice happens BEFORE the formatter to keep data-api's
// LIMIT-ed-fetch row set (shares themselves divide by the stored full-window
// total, so they are limit-independent either way).
//
// The optional call_module scope is NOT precomputed (its value space is
// unbounded), so a filtered call declines to the schema-stable empty rather
// than serving unfiltered numbers under a filtered label.

import { z } from "zod";

import { buildChainCalls } from "./chain-analytics.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsSchema } from "../schemas-src/projection-artifact.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";

export const CHAIN_CALLS_PROJECTION_KEY =
  "metagraph/projections/chain-calls.json";

/** The REST route's limit contract (workers/request-handlers/analytics.ts's
 * parseLimitParam({defaultLimit: 50, maxLimit: 100}) — hardcoded there, so
 * single-sourced here for the lane writer and this reader). */
export const CHAIN_CALLS_LIMIT_DEFAULT = 50;
export const CHAIN_CALLS_LIMIT_MAX = 100;

const CHAIN_CALLS_GROUP_BYS = ["module", "module_function"];

/**
 * One cell holds BOTH groupings, keyed by `group_by`.
 *
 * `groups` is pinned only as an object here; the requested grouping's rows are
 * parsed separately at the call site, so a malformed grouping fails only the
 * reads that would have served it.
 */
const ChainCallsCellSchema = z.object({
  groups: z.record(z.string(), z.unknown()),
  total: z.unknown().optional(),
  newest_observed: z.unknown().optional(),
});

/** The route's limit contract re-applied at the reader: both callers pass
 * already-validated values, but a direct call must not page past the route's
 * own maximum. */
function normalizedLimit(value: unknown): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored)) return CHAIN_CALLS_LIMIT_DEFAULT;
  return Math.max(0, Math.min(floored, CHAIN_CALLS_LIMIT_MAX));
}

/** data-api's latestObservedIso over the stored freshness read. */
function newestObservedIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-calls breakdown for one window/group_by, or null when
 * the artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window or group_by the lane did not precompute, or a
 * call_module scope — which is never precomputed) so the caller keeps its
 * schema-stable empty. Decline, never approximate.
 */
export async function loadChainCallsFromArtifact(
  env: Env | null | undefined,
  query: {
    window?: string | null;
    groupBy?: string | null;
    limit?: unknown;
    callModule?: string | null;
  },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainCalls> | null> {
  // A pallet-scoped call has no precomputed answer; serving the unfiltered
  // rows under a filtered label would be a wrong answer, not a degraded one.
  if (typeof query.callModule === "string" && query.callModule.length > 0)
    return null;
  const groupBy = query.groupBy ?? "module";
  if (!CHAIN_CALLS_GROUP_BYS.includes(groupBy)) return null;
  const read = await readProjectionWindow(env, {
    key: CHAIN_CALLS_PROJECTION_KEY,
    network,
    window: query.window,
    defaultWindow: DEFAULT_ANALYTICS_WINDOW,
    windows: ANALYTICS_WINDOW_DAYS,
    cell: ChainCallsCellSchema,
  });
  if (!read) return null;
  // Only the REQUESTED grouping is parsed. Validating every stored group would
  // fail a `?group_by=module` read because the `module_function` rows the
  // caller never asked for were malformed -- a decline the caller could do
  // nothing about, on data that did not reach their answer.
  const rows = ProjectionRowsSchema.safeParse(read.cell.groups[groupBy]);
  if (!rows.success) return null;
  const limit = normalizedLimit(query.limit);
  return buildChainCalls({
    window: read.label,
    groupBy,
    observedAt: newestObservedIso(read.cell.newest_observed),
    // data-api's Number(totalRows[0]?.total) || 0 coercion, verbatim.
    total: Number(read.cell.total) || 0,
    rows: rows.data.slice(0, limit),
  });
}
