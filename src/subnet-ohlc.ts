// Subnet OHLC candlestick data (#5655, Phase 1 of the OHLC epic #5304): shapes
// account_events StakeAdded/StakeRemoved rows into open/high/low/close/volume
// candles bucketed by time interval. Each row is one executed trade carrying
// alpha_amount (alpha bought/sold) and amount_tao (TAO spent/received) --
// price = amount_tao / alpha_amount for that single trade. This is genuine
// tick-level data, not a derived moving average (unlike subnet_snapshots'
// alpha_price_tao, which is SubnetMovingPrice and carries no real high/low
// range) -- see #5304's scoping comment for the full data-source analysis.
//
// Pure shaping (buildSubnetOhlc) over RAW, unaggregated rows -- deliberately
// mirrors chain-alpha-volume.ts's own pure-shaping convention rather than
// computing open/close with SQL array_agg/window-function tricks: the hard
// bucketing/OHLC math happens in JS, so it's unit-testable without a database,
// and the SQL stays a plain filtered `SELECT ... ORDER BY observed_at ASC`
// (see workers/data-api.ts's /ohlc block). Null-safe: a cold store or an
// empty window yields a schema-stable empty candle array (never throws),
// matching the sibling live tiers (alpha-volume, stake-flow).
//
// The lakehouse cold tier CANNOT keep that shape, and the split is drawn on
// purpose. R2 SQL is reached over HTTP, so "every raw trade in the window"
// would be a multi-megabyte body for an active subnet (the busiest non-root
// subnet trades ~1.4k times a day; ?days= goes to 365) -- and capping the row
// count would silently shorten the window a caller asked for. So that tier
// aggregates in SQL and fills OhlcBucket directly. buildSubnetOhlcFromBuckets
// below is therefore the seam: both tiers agree on what a BUCKET is, and only
// one of them decides what a CANDLE looks like.
//
// Root subnet (netuid 0) has no AMM pool -- staking there is 1:1 TAO<->TAO with
// no price impact (mirrors src/stake-quote.ts's own root short-circuit) -- so
// an OHLC series for it would just be a flat line at 1.0 and isn't a
// meaningful market. buildSubnetOhlc returns an explicit root_excluded shape
// (candles: [], root_excluded: true) instead of computing a degenerate series.
//
// Approved scope: #5304 (scoping comment
// https://github.com/JSONbored/metagraphed/issues/5304#issuecomment-4977247367),
// itself authorized by #4302's maintainer decision ("both items approved, in
// scope") extending metagraphed's original developer-explorer fence (#2589,
// which had explicitly excluded OHLC candlesticks) to cover this feature.

import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./alpha-volume.ts";
import { round9OrZero } from "./lib/rao.ts";

export { STAKE_ADDED_KIND, STAKE_REMOVED_KIND };

type Row = Record<string, unknown>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Supported candle widths, in epoch-ms. Any other/malformed ?interval= value
// normalizes to OHLC_INTERVAL_DEFAULT rather than throwing -- this codebase's
// convention for a malformed param is to clamp/normalize the pure shaper's
// input defensively (mirrors chain-alpha-volume.ts's own `limit` clamp),
// while the HTTP/MCP layers additionally validate the enum up front for a
// clear 400/invalid_params instead of a silent substitution (mirrors how
// handleSubnetStakeFlow validates `direction` AND buildStakeFlow-adjacent
// callers still guard defensively).
export const OHLC_INTERVALS: Record<string, number> = {
  "1h": HOUR_MS,
  "1d": DAY_MS,
};
export const OHLC_INTERVAL_DEFAULT = "1h";

// Default account_events lookback window for the Postgres loader (#5304's
// scoping comment: "a bounded default window (e.g., last 90 days) with a
// wider window as a deliberate, more expensive opt-in"). Exported so the
// Worker's ?days= clamp (workers/request-handlers/entities.ts) and the
// Postgres-tier SQL cutoff (workers/data-api.ts) share one number instead of
// two independently-drifting literals.
export const DEFAULT_OHLC_WINDOW_DAYS = 90;
export const MAX_OHLC_WINDOW_DAYS = 365;

// Defensive cap on the number of candles a single response can carry -- a
// pathological interval/window combination (e.g. 1h buckets over the full
// MAX_OHLC_WINDOW_DAYS = up to 8,760 possible buckets) must never produce an
// unbounded body. Mirrors chain-alpha-volume.ts's CHAIN_ALPHA_VOLUME_LIMIT_MAX
// guard on its own leaderboard length. When a series exceeds the cap, the
// MOST RECENT candles are kept (the oldest tail is dropped) -- a live
// price/volume chart's most useful data is its recent history, unlike
// chain-alpha-volume's own cap (which keeps the biggest-volume subnets,
// an unrelated ranking, not a chronological series).
export const MAX_CANDLES = 2000;

// A finite, strictly positive number, or null otherwise. Guards alpha_amount:
// it's the price denominator, so zero/negative/non-finite must never reach a
// division (that path produces Infinity/NaN/a nonsensical negative price).
function positiveFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A finite number, or null otherwise. Guards amount_tao: unlike alpha_amount
// it's the price numerator, not a denominator, so a zero or negative cell
// (which shouldn't occur for StakeAdded/StakeRemoved in practice, but a
// malformed row must never be trusted) is still safe to carry through --
// only non-finite (NaN/Infinity/unparseable) values are rejected.
function finiteAmount(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// interval, normalized to a supported key -- never throws, mirrors the
// module-level clamp/normalize convention documented on OHLC_INTERVALS above.
export function normalizeInterval(interval: unknown): string {
  return typeof interval === "string" && Object.hasOwn(OHLC_INTERVALS, interval)
    ? interval
    : OHLC_INTERVAL_DEFAULT;
}

// One finished bucket, before it is rounded and named. The lakehouse cold
// tier (src/subnet-ohlc-cold-tier.ts) fills these from a SQL GROUP BY rather
// than from a row loop, which is why this shape and the assembler below are
// exported: the aggregation differs by tier, the CANDLE never does.
export interface OhlcBucket {
  open: number;
  high: number;
  low: number;
  close: number;
  volumeAlpha: number;
  volumeTao: number;
  eventCount: number;
}

// Turn finished buckets into the response payload: the MAX_CANDLES cap, the
// rao rounding, the field names, the root_excluded shape. Every tier ends
// here, so none of that can drift between them -- a tier only has to agree on
// what a bucket IS, not on how a candle is spelled.
//
// Root (netuid 0) has no AMM pool -- 1:1 TAO, no price impact. Short-circuit
// with an explicit degenerate shape rather than computing a meaningless
// flat-line series, mirroring stake-quote.ts's is_root short-circuit (which
// similarly never runs its pool math against nonexistent reserves). `candles`
// stays an empty array (not omitted) and `root_excluded` is always present as
// a boolean -- one schema-stable shape for both the root and non-root case,
// rather than two different response shapes for callers to branch on.
export function buildSubnetOhlcFromBuckets(
  buckets: Map<number, OhlcBucket>,
  netuid: number,
  {
    interval = OHLC_INTERVAL_DEFAULT,
    limit,
    windowTruncated = false,
  }: {
    interval?: unknown;
    limit?: number;
    /**
     * True when the WINDOW held more buckets than the tier could read, so
     * `candle_count` is a floor rather than the total. See `window_truncated`
     * on the payload below.
     */
    windowTruncated?: boolean;
  } = {},
): Row {
  const normalizedInterval = normalizeInterval(interval);
  if (netuid === 0) {
    return {
      schema_version: 1,
      netuid: 0,
      interval: normalizedInterval,
      candles: [],
      candle_count: 0,
      // Root's zero is MEASURED -- there is no AMM, so the window genuinely
      // holds nothing and no cap was reached to hide anything behind.
      window_truncated: false,
      root_excluded: true,
    };
  }

  const bucketStarts = [...buckets.keys()].sort((a, b) => a - b);
  // `limit` narrows the same way MAX_CANDLES caps -- newest-first -- because a
  // caller asking for fewer candles of a price series wants the recent end,
  // and answering with the oldest 24 hours of an 83-day window would be a
  // technically-correct page of the wrong data.
  const ceiling = Math.max(
    1,
    Math.min(MAX_CANDLES, Number.isFinite(limit) ? Number(limit) : MAX_CANDLES),
  );
  const cappedStarts =
    bucketStarts.length > ceiling
      ? bucketStarts.slice(bucketStarts.length - ceiling)
      : bucketStarts;

  const candles = cappedStarts.map((bucketStart) => {
    const b = buckets.get(bucketStart) as OhlcBucket;
    return {
      bucket_start: bucketStart,
      bucket_start_iso: new Date(bucketStart).toISOString(),
      open: round9OrZero(b.open),
      high: round9OrZero(b.high),
      low: round9OrZero(b.low),
      close: round9OrZero(b.close),
      volume_alpha: round9OrZero(b.volumeAlpha),
      volume_tao: round9OrZero(b.volumeTao),
      event_count: b.eventCount,
    };
  });

  return {
    schema_version: 1,
    netuid,
    interval: normalizedInterval,
    candles,
    // The WINDOW's candle count, not the page's. A caller that narrowed with
    // `limit` still needs the denominator it narrowed against -- the same
    // reason #10249 made subnet_count stop tracking `?limit=`, and the same
    // convention /chain/deregistrations already publishes.
    //
    // A FLOOR, not a total, whenever `window_truncated` is set -- see below.
    candle_count: bucketStarts.length,
    // Whether the window held MORE than the tier could read (#10312).
    //
    // Measured 2026-08-16 against the live lakehouse: SN64 reports exactly
    // 2000 candles at ?days=90 AND at ?days=365. Two windows of different
    // widths cannot hold an identical number of buckets -- that 2000 is
    // MAX_CANDLES showing through, and at 1h buckets the cap binds from ~83
    // days, i.e. inside the DEFAULT window. `candle_count` was documented as
    // what the window holds and was silently reporting the cap instead.
    //
    // Published rather than fixed, because the true total is not obtainable at
    // this tier's cost: `COUNT(*) OVER ()` parses at 7 days and is REJECTED at
    // 90 with `40015: scan budget exceeded ... unbounded window without
    // PARTITION BY`, so it would pass every test and fail at the default
    // window. A flag the caller can read beats a number we cannot compute.
    window_truncated: windowTruncated,
    root_excluded: false,
  };
}

/**
 * The reason a declined series carries. Same vocabulary
 * `/health/failure-reasons` already publishes for the same condition: an EMPTY
 * window is a measurement, a FAILED read is not.
 */
export const OHLC_DEGRADED_UNAVAILABLE = "unavailable";

/**
 * A decline, for a series that could not be read at all (#10312).
 *
 * WHY THIS EXISTS. The three surfaces over this route each fell back to
 * `buildSubnetOhlc([], netuid)` when the tier returned null, which publishes
 * `candles: []` with `candle_count: 0` and nothing to say it is not a
 * measurement. Measured 2026-08-16: the lakehouse query behind this route runs
 * 7.3s-24.4s against the Worker's 15s `QUERY_TIMEOUT_MS`, so the decline is a
 * coin flip rather than a rare event -- and a subnet that trades every hour was
 * answering "no trades, ever" in 15 seconds.
 *
 * `candle_count` is NULL here and 0 for root, and the difference is the whole
 * point: root's zero is known, this one is unknown. That is the rule the eight
 * declining siblings already follow (`point_count`, `holder_count`,
 * `nominator_count`, ...); the two that keep a 0 are the permanent curation
 * gaps in `uncurated-event-streams.ts`, where 0 IS the measurement.
 */
export function declineSubnetOhlc(
  netuid: number,
  { interval = OHLC_INTERVAL_DEFAULT }: { interval?: unknown } = {},
): Row {
  return {
    schema_version: 1,
    netuid,
    interval: normalizeInterval(interval),
    candles: [],
    candle_count: null,
    // Nothing was read, so nothing was capped. Stated rather than omitted so
    // the key set does not change between an answer and a decline.
    window_truncated: false,
    root_excluded: false,
    degraded: { reason: OHLC_DEGRADED_UNAVAILABLE },
  };
}

// Shape a subnet's raw StakeAdded/StakeRemoved account_events rows into
// OHLCV candles. `rows` need not be pre-sorted -- sorted defensively by
// observed_at ascending here, never trusting caller order (mirrors this
// codebase's other pure shapers' defensive-input convention; ties keep their
// original relative order via Array#sort's spec-guaranteed stability).
//
// Per bucket, in ascending trade order: open = first trade's price, close =
// last trade's price, high/low = max/min trade price, volume_alpha/volume_tao
// = summed alpha_amount/amount_tao, event_count = trade count. Every numeric
// output is rounded to rao precision (round9OrZero) to avoid IEEE-754 dust --
// the SAME function alpha-volume.ts/chain-alpha-volume.ts use now, rather
// than the three private `roundUnit` copies that used to mirror each other by
// hand (#10948).
//
// Empty buckets (no trades in that time slot) are a genuine GAP -- they never
// appear in the output array, never synthesized as a flat candle (standard
// candlestick-charting convention, and honest given how sparse an illiquid
// subnet's trading can be).
export function buildSubnetOhlc(
  rows: Row[] | null | undefined,
  netuid: number,
  {
    interval = OHLC_INTERVAL_DEFAULT,
    limit,
  }: { interval?: unknown; limit?: number } = {},
): Row {
  const normalizedInterval = normalizeInterval(interval);

  // Root subnet (netuid 0) has no candles at all, so there is nothing to
  // bucket -- hand the assembler an empty map and let its one root branch
  // produce the degenerate shape.
  if (netuid === 0) {
    return buildSubnetOhlcFromBuckets(new Map(), netuid, {
      interval: normalizedInterval,
      limit,
    });
  }

  const intervalMs = OHLC_INTERVALS[normalizedInterval];
  const list = Array.isArray(rows) ? rows : [];
  const sorted = [...list].sort(
    (a, b) => Number(a?.observed_at) - Number(b?.observed_at),
  );

  const buckets = new Map<number, OhlcBucket>();
  for (const row of sorted) {
    const kind = row?.event_kind;
    if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) continue;

    const alpha = positiveFinite(row?.alpha_amount);
    if (alpha == null) continue;
    const tao = finiteAmount(row?.amount_tao);
    if (tao == null) continue;
    const observedAt = finiteAmount(row?.observed_at);
    if (observedAt == null) continue;

    const price = tao / alpha;
    /* v8 ignore next -- defensive: a finite tao / a finite positive alpha is always finite */
    if (!Number.isFinite(price)) continue;

    const bucketStart = Math.floor(observedAt / intervalMs) * intervalMs;
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = {
        open: price,
        high: price,
        low: price,
        close: price,
        volumeAlpha: 0,
        volumeTao: 0,
        eventCount: 0,
      };
      buckets.set(bucketStart, bucket);
    }
    if (price > bucket.high) bucket.high = price;
    if (price < bucket.low) bucket.low = price;
    // Rows are processed in ascending observed_at order, so the latest write
    // to `close` is always the bucket's most recent trade.
    bucket.close = price;
    bucket.volumeAlpha += alpha;
    bucket.volumeTao += tao;
    bucket.eventCount += 1;
  }

  return buildSubnetOhlcFromBuckets(buckets, netuid, {
    interval: normalizedInterval,
    limit,
  });
}
