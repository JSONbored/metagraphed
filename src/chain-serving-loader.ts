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
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";
import {
  buildChainServing,
  CHAIN_SERVING_LIMIT_DEFAULT,
} from "./chain-serving.ts";
import {
  CHAIN_SERVING_ROLLUP,
  loadChainEventRollup,
} from "./chain-event-rollup-cold-tier.ts";
import type { r2SqlQuery } from "./r2-sql.ts";

/**
 * One window of chain-serving activity from the lakehouse, already built into
 * the response shape — or null when the lakehouse cannot answer.
 *
 * BOTH the window and the limit are resolved ONCE here, and the resolved values
 * are what reach the scan and the builder alike (#9239).
 *
 * The window mattered because the fallback used to be half-applied:
 * `windowDays` fell back to 7, but the caller's original string was still
 * handed to the builder — so an unrecognised label scanned seven days and
 * published a card claiming to be something else. The scan narrowing without
 * the label narrowing is worse than either alone, because the response then
 * misdescribes data that is itself correct.
 *
 * The limit mattered because it is optional and the two halves default
 * DIFFERENTLY: `loadChainEventRollup` caps at 200, `buildChainServing` at 20.
 * Left to their own defaults an omitted limit scanned ten times the rows the
 * response could carry. `parseLimitParam` genuinely returns
 * `number | undefined` even when given a defaultLimit, so this is reachable
 * from the REST call site's types rather than merely defensive.
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
  const label = Object.hasOwn(ANALYTICS_WINDOWS, window)
    ? window
    : DEFAULT_ANALYTICS_WINDOW;
  const rowLimit = limit ?? CHAIN_SERVING_LIMIT_DEFAULT;
  const rollup = await loadChainEventRollup(env, CHAIN_SERVING_ROLLUP, {
    windowDays: ANALYTICS_WINDOWS[label],
    limit: rowLimit,
    // Passed straight through: a destructuring default applies to an explicit
    // undefined, so the rollup reader falls back to the real r2SqlQuery
    // without a conditional spread here that nothing would ever exercise.
    query,
  });
  if (!rollup) return null;
  // No cast: with the label a resolved string and the limit a resolved number,
  // the builder's real signature accepts these directly. The former
  // `as unknown as Parameters<...>` is what let both mismatches above
  // typecheck in the first place.
  return buildChainServing(rollup.rows, {
    window: label,
    limit: rowLimit,
    networkDistinct: rollup.networkDistinct,
  });
}
