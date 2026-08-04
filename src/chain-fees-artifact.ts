// Chain-fees served from a SCHEDULED PROJECTION artifact when the Postgres
// tier misses (#9146). Same shape as src/chain-transfers-artifact.ts (see
// that header for the projection-vs-reader argument): the chain-fees lane
// stores the per-UTC-day fee/tip series, the exact per-day medians, and the
// top-fee-payer leaderboard at the route's maximum limit — a smaller ?limit=
// is a prefix slice of the same total order (total_fee_tao DESC, signer ASC),
// sliced BEFORE the formatter to keep data-api's LIMIT-ed-fetch semantics.
// The handlers' own #8242 window trim applies AFTER this tier resolves,
// exactly as it applies to a live Postgres answer.
//
// The optional call_module scope is NOT precomputed (its value space is
// unbounded), so a filtered call declines to the schema-stable empty rather
// than serving unfiltered numbers under a filtered label.

import { buildChainFees } from "./chain-analytics.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  projectionKey,
} from "./chain-network.ts";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";

export const CHAIN_FEES_PROJECTION_KEY =
  "metagraph/projections/chain-fees.json";

/** The REST route's limit contract (workers/request-handlers/analytics.ts's
 * parseLimitParam({defaultLimit: 25, maxLimit: 100}) — hardcoded there, so
 * single-sourced here for the lane writer and this reader). */
export const CHAIN_FEES_LIMIT_DEFAULT = 25;
export const CHAIN_FEES_LIMIT_MAX = 100;

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/** The route's limit contract re-applied at the reader: both callers pass
 * already-validated values, but a direct call must not page past the route's
 * own maximum. */
function normalizedLimit(value: unknown): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored)) return CHAIN_FEES_LIMIT_DEFAULT;
  return Math.max(0, Math.min(floored, CHAIN_FEES_LIMIT_MAX));
}

/** data-api's latestObservedIso over the stored freshness read. */
function newestObservedIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * The projected chain-fees market card for one window, or null when the
 * artifact store cannot answer FAITHFULLY (unbound, missing object,
 * unrecognized body, a window the lane did not precompute, or a call_module
 * scope — which is never precomputed) so the caller keeps its schema-stable
 * empty. Decline, never approximate.
 */
export async function loadChainFeesFromArtifact(
  env: Env | null | undefined,
  query: {
    window?: string | null;
    limit?: unknown;
    callModule?: string | null;
  },
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildChainFees> | null> {
  // A pallet-scoped call has no precomputed answer; serving the unfiltered
  // series under a filtered label would be a wrong answer, not a degraded one.
  if (typeof query.callModule === "string" && query.callModule.length > 0)
    return null;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(
      projectionKey(CHAIN_FEES_PROJECTION_KEY, network),
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
    const label = query.window ?? DEFAULT_ANALYTICS_WINDOW;
    // A window outside the route's set — or one this artifact does not carry
    // — must never be answered with a DIFFERENT window's numbers.
    if (!Object.hasOwn(ANALYTICS_WINDOWS, label)) return null;
    const win = (body.windows as Record<string, unknown>)[label] as {
      newest_observed?: unknown;
      daily_rows?: unknown;
      median_rows?: unknown;
      payer_rows?: unknown;
    } | null;
    if (
      !Array.isArray(win?.daily_rows) ||
      !Array.isArray(win?.median_rows) ||
      !Array.isArray(win?.payer_rows)
    ) {
      return null;
    }
    const limit = normalizedLimit(query.limit);
    return buildChainFees({
      window: label,
      observedAt: newestObservedIso(win.newest_observed),
      dailyRows: win.daily_rows as Record<string, unknown>[],
      medianRows: win.median_rows as Record<string, unknown>[],
      payerRows: (win.payer_rows as Record<string, unknown>[]).slice(0, limit),
    });
  } catch {
    return null;
  }
}
