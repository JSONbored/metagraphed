// What GET /api/v1/subnets/{netuid}/ohlc answers, for every surface that
// publishes it (#10312).
//
// ## Why this exists at all
//
// REST, MCP and GraphQL each ended their OHLC read with the same line:
//
//     (await loadSubnetOhlcColdTier(env, netuid, ...))?.data
//       ?? buildSubnetOhlc([], netuid, { interval, limit })
//
// Three copies of one decision, and the decision was wrong in all three. The
// tier returned a bare `null` for five different conditions -- root, an input
// it could not use, an unconfigured lakehouse, a configured lakehouse that
// timed out, and an answer it could not parse -- and `?? buildSubnetOhlc([])`
// turned every one of them into `candles: [], candle_count: 0` with nothing in
// the payload to say which had happened.
//
// That matters here more than it would on a quiet route. Measured against the
// live lakehouse on 2026-08-16, the query behind this route runs 7.3s-24.4s
// while the Worker's `QUERY_TIMEOUT_MS` is 15s, so the decline is a coin flip
// rather than a rare event -- and a subnet trading every hour spent 15 seconds
// answering "no trades, ever", indistinguishable from a genuinely idle subnet.
//
// So the fallback lives HERE, once, and it has three answers instead of one.
// The rule is `account-summary-card.ts`'s, verbatim: a deployment with no
// lakehouse is a `miss` and its empty series is correct; a configured lakehouse
// that could not answer is a `gap`, because in that deployment the rows exist
// and a zero is a lie about them.

import { loadSubnetOhlcColdTier } from "./subnet-ohlc-cold-tier.ts";
import type { SubnetOhlcQuery } from "./subnet-ohlc-cold-tier.ts";
import type { R2SqlEnv } from "./r2-sql.ts";
import {
  buildSubnetOhlcFromBuckets,
  declineSubnetOhlc,
  type OhlcBucket,
} from "./subnet-ohlc.ts";

/** The payload plus the instant it was measured, in data-api's own wrapper. */
export interface SubnetOhlcAnswer {
  data: Record<string, unknown>;
  generatedAt: string | null;
}

/**
 * One subnet's candles, or a payload that says why there are none.
 *
 * `generatedAt` is null for both non-answers, and deliberately: it is derived
 * from the newest `observed_at` actually read, so there is no instant to report
 * when nothing was read. A timestamp there would date an empty series to now.
 */
export async function answerSubnetOhlc(
  env: R2SqlEnv | null | undefined,
  netuid: number,
  query: SubnetOhlcQuery = {},
): Promise<SubnetOhlcAnswer> {
  const result = await loadSubnetOhlcColdTier(env, netuid, query);
  if (result.kind === "answer") {
    return { data: result.data, generatedAt: result.generatedAt };
  }
  if (result.kind === "gap") {
    // A DECLINE, not a series. `candle_count` is null rather than 0 because
    // nothing is known about how many candles the window holds -- the same
    // distinction the eight other declining routes draw.
    return {
      data: declineSubnetOhlc(netuid, { interval: query.interval }),
      generatedAt: null,
    };
  }
  // `miss`: nothing to ask. Root (netuid 0) lands here too and the assembler's
  // own root branch gives it the `root_excluded` shape, which is a MEASURED
  // empty -- there is no AMM, so there are genuinely no candles.
  return {
    data: buildSubnetOhlcFromBuckets(new Map<number, OhlcBucket>(), netuid, {
      interval: query.interval,
      limit: query.limit,
    }),
    generatedAt: null,
  };
}
