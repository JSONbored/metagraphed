// Shared /chain/serving lakehouse rollup loader for REST + MCP + GraphQL parity.
//
// #9216 wired the lakehouse rollup into the REST handler alone, so the same
// question answered three ways gave real numbers on `GET /api/v1/chain/serving`
// and a zeroed card on `get_chain_serving` and `chain_serving` -- with nothing
// in any of the three payloads letting a caller tell which was lying. Same
// reason src/rpc-usage-loader.ts exists: the alternative is each surface
// repeating "load the rollup, hand it to the builder, decline on a miss", which
// is three places to drift.
//
// DECLINES WITH null, never with the zeroed card. Each surface's fallback is
// its own published contract -- GraphQL deliberately answers with a
// schema-stable card rather than an error, REST falls through to its empty
// payload -- and that choice belongs at the call site, not here. Returning the
// empty card from this function would quietly make every caller's fallback
// identical and unreachable.
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";
import {
  CHAIN_SERVING_ROLLUP,
  loadChainEventRollup,
} from "./chain-event-rollup-cold-tier.ts";
import {
  buildChainServing,
  CHAIN_SERVING_LIMIT_DEFAULT,
  type ChainServingResult,
} from "./chain-serving.ts";

/**
 * The lakehouse rollup for one window, built into the published card.
 *
 * `window` is normalized against ANALYTICS_WINDOWS rather than trusted. All
 * three callers validate it before getting here, so this is belt-and-braces --
 * but the failure it prevents is not a 4xx, it is a `windowDays: undefined`
 * reaching the scan and silently widening it past the range the caller asked
 * for. The label is then carried into the built card, so a fallback can never
 * report a window the numbers did not come from.
 */
export async function loadChainServingRollup(
  env: Parameters<typeof loadChainEventRollup>[0],
  {
    window,
    limit,
    now,
    query,
  }: {
    window?: unknown;
    /**
     * Optional because parseLimitParam types its result `number | undefined`
     * even when a defaultLimit is supplied. Resolved to ONE number here and
     * used for both halves: the scan cap and the builder's row cap defaulted
     * separately (200 vs 20) if each were left to its own, which would scan ten
     * times the rows the response can carry.
     */
    limit?: number;
    now?: number;
    query?: Parameters<typeof loadChainEventRollup>[2]["query"];
  },
): Promise<ChainServingResult | null> {
  const label =
    typeof window === "string" && Object.hasOwn(ANALYTICS_WINDOWS, window)
      ? window
      : DEFAULT_ANALYTICS_WINDOW;
  const rowLimit = limit ?? CHAIN_SERVING_LIMIT_DEFAULT;
  const rollup = await loadChainEventRollup(env, CHAIN_SERVING_ROLLUP, {
    windowDays: ANALYTICS_WINDOWS[label],
    limit: rowLimit,
    ...(now === undefined ? {} : { now }),
    ...(query === undefined ? {} : { query }),
  });
  // The network block rides separately on purpose: one hotkey serving five
  // subnets is five rows and one server, so the network distinct cannot be
  // summed from the per-subnet rows and comes from its own ungrouped query.
  return rollup
    ? buildChainServing(rollup.rows, {
        window: label,
        limit: rowLimit,
        networkDistinct: rollup.networkDistinct,
      })
    : null;
}
