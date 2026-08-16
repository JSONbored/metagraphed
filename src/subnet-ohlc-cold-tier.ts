// Subnet OHLC candles served from the lakehouse when the Postgres tier misses
// (#9146's cold-tier lane).
//
// WHY REQUEST-TIME AND NOT A PROJECTION LANE. src/projection-lanes.ts exists
// because a CHAIN-WIDE aggregate over the 894M-row event tables cannot be
// recomputed under a request. This is not that read. The predicate here is
// `netuid = N AND observed_at >= cutoff`, which is the same SELECTIVE shape
// src/account-feeds-cold-tier.ts already serves live (one address against the
// same table) -- and its header states the rule this follows: selective
// predicates stay request-time, chain-wide aggregates move to the cron.
//
// The selectivity is measured, not assumed. The live chain-alpha-volume
// projection reports ~14.9k StakeAdded/StakeRemoved trades per DAY across all
// subnets, with the busiest non-root subnet at ~1.4k/day and the median at
// ~70/day. So one subnet's default 90-day window touches ~6k rows at the
// median and ~125k at the worst -- 0.01% of the table, not a scan of it.
//
// A lane would also have to DECLINE most of this route's parameter space:
// 129 subnets x 2 intervals x days(1..365) cannot be precomputed, so only the
// default window would be real and every other ?days= would degrade to an
// empty. That is a worse route than a second-scale query behind the edge
// cache.
//
// WHY THE AGGREGATION IS IN SQL HERE AND IN JS THERE. See src/subnet-ohlc.ts's
// header: raw rows over HTTP do not bound, and capping them would silently
// shorten the caller's window. Bucketing in SQL bounds the response by CANDLE
// count (<= MAX_CANDLES) instead of by trade count, so ?days=365 on the
// busiest subnet costs the same as ?days=1 on the quietest. The candle shape
// itself still comes from buildSubnetOhlcFromBuckets, the one assembler both
// tiers end in.
//
// EQUIVALENCE with data-api's JS loop, clause by clause:
//   - price: `amount_tao / alpha_amount` per trade, identical expression.
//   - the guards: buildSubnetOhlc skips a row whose alpha_amount is not
//     finite-and-positive or whose amount_tao is not finite; the WHERE clause
//     drops exactly those rows (`alpha_amount > 0` also excludes NULL, and
//     `amount_tao IS NOT NULL` the other). COUNT(*) therefore counts the same
//     trades event_count counts.
//   - the bucket key: `FLOOR(observed_at / intervalMs) * intervalMs`, the
//     same arithmetic, and CAST-wrapped so it holds whether the engine reads
//     `/` as integer or float division (observed_at is always positive here,
//     so truncation and floor agree).
//   - open/close: the JS builder sorts by observed_at with a STABLE sort, so
//     ties resolve to the order the SQL happened to return. This tier breaks
//     the same ties by (block_number, event_index) -- the real chain order --
//     which is deterministic where the other was incidental. Same trade
//     except when two trades share a millisecond, and then this one is right.
//   - the sums: SUM() in the engine vs a JS accumulator can differ in the
//     last ulp by association order; both are then rounded to rao (1e-9) by
//     the shared assembler, which is far coarser than that difference.

import {
  buildSubnetOhlcFromBuckets,
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVALS,
  type OhlcBucket,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "./subnet-ohlc.ts";
import { isR2SqlConfigured, r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

/** Same day length the REST/MCP callers and data-api use, so every tier
 * resolves the same ?days= to the same request-time cutoff. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A finite number from a cell the engine may hand back as a string. */
function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface SubnetOhlcQuery {
  /** A key of OHLC_INTERVALS. Anything else declines rather than silently
   * substituting the default -- REST and MCP both reject a bad value with a
   * 400/invalid_params before any tier is tried, so an unknown one reaching
   * here is a bug, not a user typo to paper over. */
  interval?: unknown;
  /** 1..MAX_OHLC_WINDOW_DAYS. Same reasoning. */
  days?: unknown;
  /** How many candles to return, newest-first, up to MAX_CANDLES (#10318).
   * The window is unchanged -- `candle_count` still reports what the window
   * holds, so a narrowed page keeps its denominator. */
  limit?: number;
}

/**
 * What this tier has to say about a request, which is three different things
 * that used to be one `null` (#10312).
 *
 * `miss` means there is nothing to ask -- no lakehouse configured (a
 * self-hoster, CI), or an input this tier cannot use. The caller's
 * schema-stable empty is CORRECT there and always was.
 *
 * `gap` means a configured lakehouse was asked and could not answer. The rows
 * exist in that deployment, so an empty series is a lie about them, and the
 * caller must decline rather than publish a zero.
 *
 * The distinction is `account-summary-card.ts`'s, for the same reason and in
 * the same words; this route is the one that never drew it.
 */
export type SubnetOhlcColdTierResult =
  | {
      kind: "answer";
      data: Record<string, unknown>;
      generatedAt: string | null;
    }
  | { kind: "gap" }
  | { kind: "miss" };

/**
 * GET /api/v1/subnets/{netuid}/ohlc -- OHLCV candles for one subnet's alpha
 * price, in data-api's own `{ data, generatedAt }` wrapper.
 *
 * Netuid 0 is a `miss` for the same reason it has no candles at all: there is
 * no AMM to query, and the caller's empty already carries the correct
 * root_excluded shape.
 */
export async function loadSubnetOhlcColdTier(
  env: R2SqlEnv | null | undefined,
  netuid: unknown,
  query: SubnetOhlcQuery = {},
): Promise<SubnetOhlcColdTierResult> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null || subnet === 0) return { kind: "miss" };

  const interval = query.interval ?? null;
  if (
    typeof interval !== "string" ||
    !Object.hasOwn(OHLC_INTERVALS, interval)
  ) {
    return { kind: "miss" };
  }
  const intervalMs = OHLC_INTERVALS[interval];

  const days = safeBlockNumber(query.days);
  if (days === null || days < 1 || days > MAX_OHLC_WINDOW_DAYS) {
    return { kind: "miss" };
  }
  const cutoff = Date.now() - days * DAY_MS;

  // Every literal below is an integer this function parsed or a module
  // constant -- src/r2-sql.ts takes no bound parameters, so nothing else may
  // reach the string.
  const bucketExpr = `CAST(FLOOR(observed_at / ${intervalMs}) AS BIGINT) * ${intervalMs}`;
  const rows = await r2SqlQuery(
    env,
    `WITH trades AS (` +
      `SELECT ${bucketExpr} AS bucket_start, observed_at, block_number, ` +
      `event_index, amount_tao / alpha_amount AS price, alpha_amount, amount_tao ` +
      `FROM chain.account_events ` +
      `WHERE netuid = ${subnet} ` +
      `AND (event_kind = '${STAKE_ADDED_KIND}' OR event_kind = '${STAKE_REMOVED_KIND}') ` +
      `AND observed_at >= ${cutoff} ` +
      `AND alpha_amount > 0 AND amount_tao IS NOT NULL` +
      `), ordered AS (` +
      `SELECT bucket_start, observed_at, price, alpha_amount, amount_tao, ` +
      `ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY observed_at ASC, ` +
      `block_number ASC, event_index ASC) AS seq_first, ` +
      `ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY observed_at DESC, ` +
      `block_number DESC, event_index DESC) AS seq_last ` +
      `FROM trades` +
      `) SELECT bucket_start, ` +
      `MAX(CASE WHEN seq_first = 1 THEN price END) AS open_price, ` +
      `MAX(CASE WHEN seq_last = 1 THEN price END) AS close_price, ` +
      `MAX(price) AS high_price, MIN(price) AS low_price, ` +
      `SUM(alpha_amount) AS volume_alpha, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
      `FROM ordered GROUP BY bucket_start ` +
      // Newest-first + LIMIT is precisely the assembler's own cap rule (keep
      // the most recent MAX_CANDLES, drop the oldest tail); doing it in the
      // engine means the body is bounded before it crosses the wire, and the
      // assembler's ascending re-sort restores chart order.
      //
      // CAP + 1, and that one extra row is the whole truncation signal -- the
      // same trick `account-feeds-cold-tier.ts` uses to retire a separate cap
      // probe. Reading MAX_CANDLES rows cannot distinguish "the window holds
      // exactly the cap" from "the window holds far more and you are seeing
      // the cap", which is how `candle_count` came to report 2000 for a
      // 90-day AND a 365-day window. One extra row separates them without a
      // second query -- and a second query is not available anyway: the
      // aggregate that would count the window is rejected outright at this
      // scale (`40015: scan budget exceeded`, measured 2026-08-16).
      //
      // The extra row is DROPPED below, so the published page is unchanged.
      `ORDER BY bucket_start DESC LIMIT ${MAX_CANDLES + 1}`,
  );
  // A configured lakehouse that could not answer is a GAP; no lakehouse at all
  // is a MISS. Same rows, different deployments, and only one of them makes an
  // empty series the correct answer.
  if (rows === null) {
    return isR2SqlConfigured(env) ? { kind: "gap" } : { kind: "miss" };
  }

  // Newest-first, so the surplus row is the OLDEST -- slice from the front to
  // keep the recent end, which is the same end the assembler's cap keeps.
  const windowTruncated = rows.length > MAX_CANDLES;
  const page = windowTruncated ? rows.slice(0, MAX_CANDLES) : rows;

  const buckets = new Map<number, OhlcBucket>();
  let latest: number | null = null;
  for (const row of page) {
    const bucketStart = finite(row.bucket_start);
    const open = finite(row.open_price);
    const close = finite(row.close_price);
    const high = finite(row.high_price);
    const low = finite(row.low_price);
    const volumeAlpha = finite(row.volume_alpha);
    const volumeTao = finite(row.volume_tao);
    const eventCount = finite(row.event_count);
    // Unlike a raw-row tier, there is no such thing as a malformed TRADE here
    // -- the WHERE clause already dropped those. A bucket that will not read
    // means the engine answered something this reader does not understand, so
    // it declines the whole series rather than serving a chart with a hole in
    // it that looks like a quiet hour.
    if (
      bucketStart === null ||
      open === null ||
      close === null ||
      high === null ||
      low === null ||
      volumeAlpha === null ||
      volumeTao === null ||
      eventCount === null
    ) {
      // The engine ANSWERED, so this is not a missing lakehouse -- it is a
      // lakehouse we could not read. A gap either way.
      return { kind: "gap" };
    }
    buckets.set(bucketStart, {
      open,
      high,
      low,
      close,
      volumeAlpha,
      volumeTao,
      eventCount,
    });
    const observed = finite(row.last_observed);
    if (
      observed !== null &&
      observed > 0 &&
      (latest === null || observed > latest)
    ) {
      latest = observed;
    }
  }

  return {
    kind: "answer",
    data: buildSubnetOhlcFromBuckets(buckets, subnet, {
      interval,
      limit: query.limit,
      windowTruncated,
    }),
    // data-api derives generatedAt from the newest observed_at it read; the
    // capped window is the same set of rows the candles came from, so the
    // two tiers report the same instant for the same data.
    generatedAt: latest === null ? null : new Date(latest).toISOString(),
  };
}
