// Shared chain-serving loader for REST + MCP + GraphQL parity.
//
// The lakehouse rollup and the builder that shapes it were wired into the REST
// handler alone (#9216), so `get_chain_serving` and GraphQL's `chain_serving`
// kept returning the zeroed card while the same route over HTTP returned real
// numbers. Three callers doing "load the rollup, hand it to the builder" three
// times is three chances to drift — same reason `rpc-usage-loader.ts` exists.
//
// Returns null rather than the zeroed card so each caller keeps its own
// existing fallback and its own error contract: GraphQL in particular
// deliberately answers with a schema-stable card rather than an error, and
// that decision belongs at the call site, not here.
import { ANALYTICS_WINDOWS } from "../workers/config.ts";
import { buildChainServing } from "./chain-serving.ts";
import {
  CHAIN_SERVING_ROLLUP,
  loadChainEventRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One window of chain-serving activity from the lakehouse, already built into
 * the response shape — or null when the lakehouse cannot answer.
 *
 * `windowDays` is resolved from the shared window map rather than parsed here,
 * so an unrecognised label falls back to the same 7d every other analytics
 * surface uses instead of quietly widening the range.
 */
export async function loadChainServingColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  {
    window,
    limit,
    query,
  }: {
    window: string;
    /** Optional so callers that leave it to the builder's own default do not
     * have to restate it here. */
    limit?: number;
    /** Injectable for tests; forwarded to the rollup reader. */
    query?: typeof r2SqlQuery;
  },
): Promise<ReturnType<typeof buildChainServing> | null> {
  const rollup = await loadChainEventRollup(env, CHAIN_SERVING_ROLLUP, {
    windowDays: (ANALYTICS_WINDOWS as Record<string, number>)[window] ?? 7,
    limit,
    // Passed straight through: a destructuring default applies to an explicit
    // undefined, so the rollup reader falls back to the real r2SqlQuery
    // without a conditional spread here that nothing would ever exercise.
    query,
  });
  if (!rollup) return null;
  // The builder's own return type is preserved rather than widened to a plain
  // record: REST reads `data.subnets` for its CSV export, and widening here
  // would push an `unknown` cast back onto every caller.
  return buildChainServing(rollup.rows, {
    window,
    limit,
    networkDistinct: rollup.networkDistinct,
  } as unknown as Parameters<typeof buildChainServing>[1]);
}
