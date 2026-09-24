// OHLC candles use complete qualified native account-event indexes.
// Missing native coverage declines without manufacturing an empty series.
// Both paths preserve request-time windows, chain ordering, and candle caps.
import { hasRetainedHistoryStore } from "./retained-history-store.ts";
import {
  buildSubnetOhlcFromBuckets,
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVALS,
  type OhlcBucket,
} from "./subnet-ohlc.ts";
import { safeBlockNumber } from "./history-readers.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadIndexedSubnetOhlcRows } from "./subnet-indexed-aggregates.ts";

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
  env: HistoryReadEnv | null | undefined,
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

  const indexed = await loadIndexedSubnetOhlcRows(
    env,
    subnet,
    cutoff,
    intervalMs,
  );
  if (indexed === null) return { kind: "gap" };
  const rows = indexed;
  // A configured lakehouse that could not answer is a GAP; no lakehouse at all
  // is a MISS. Same rows, different deployments, and only one of them makes an
  // empty series the correct answer.
  if (rows == null) {
    return hasRetainedHistoryStore(env) ? { kind: "gap" } : { kind: "miss" };
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
