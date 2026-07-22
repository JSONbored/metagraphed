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
// (see workers/data-api.mjs's /ohlc block). Null-safe: a cold store or an
// empty window yields a schema-stable empty candle array (never throws),
// matching the sibling live tiers (alpha-volume, stake-flow).
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
// Worker's ?days= clamp (workers/request-handlers/entities.mjs) and the
// Postgres-tier SQL cutoff (workers/data-api.mjs) share one number instead of
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

// 1 TAO/alpha = 1e9 rao. Copied verbatim from alpha-volume.mjs's/
// chain-alpha-volume.ts's own roundUnit -- every rao-precision rounding
// helper in this codebase is a deliberate byte-for-byte copy, not a shared
// import, so each module stays independently reviewable (see those modules'
// own header comments for the same note).
const RAO_PER_UNIT = 1e9;
function roundUnit(value: number): number {
  /* v8 ignore next -- defensive: callers only pass finite accumulator sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_UNIT) / RAO_PER_UNIT;
}

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
function normalizeInterval(interval: unknown): string {
  return typeof interval === "string" && Object.hasOwn(OHLC_INTERVALS, interval)
    ? interval
    : OHLC_INTERVAL_DEFAULT;
}

interface OhlcBucket {
  open: number;
  high: number;
  low: number;
  close: number;
  volumeAlpha: number;
  volumeTao: number;
  eventCount: number;
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
// output is rounded to rao precision (roundUnit) to avoid IEEE-754 dust,
// mirroring alpha-volume.mjs/chain-alpha-volume.ts's own volume rounding.
//
// Empty buckets (no trades in that time slot) are a genuine GAP -- they never
// appear in the output array, never synthesized as a flat candle (standard
// candlestick-charting convention, and honest given how sparse an illiquid
// subnet's trading can be).
export function buildSubnetOhlc(
  rows: Row[] | null | undefined,
  netuid: number,
  { interval = OHLC_INTERVAL_DEFAULT }: { interval?: unknown } = {},
): Row {
  const normalizedInterval = normalizeInterval(interval);

  // Root subnet (netuid 0) has no AMM pool -- 1:1 TAO, no price impact.
  // Short-circuit with an explicit degenerate shape rather than computing a
  // meaningless flat-line series, mirroring stake-quote.ts's is_root
  // short-circuit (which similarly never runs its pool math against
  // nonexistent reserves). `candles` stays an empty array (not omitted) and
  // `root_excluded` is always present as a boolean -- one schema-stable shape
  // for both the root and non-root case, rather than two different response
  // shapes for callers to branch on.
  if (netuid === 0) {
    return {
      schema_version: 1,
      netuid: 0,
      interval: normalizedInterval,
      candles: [],
      root_excluded: true,
    };
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

  const bucketStarts = [...buckets.keys()].sort((a, b) => a - b);
  const cappedStarts =
    bucketStarts.length > MAX_CANDLES
      ? bucketStarts.slice(bucketStarts.length - MAX_CANDLES)
      : bucketStarts;

  const candles = cappedStarts.map((bucketStart) => {
    const b = buckets.get(bucketStart) as OhlcBucket;
    return {
      bucket_start: bucketStart,
      bucket_start_iso: new Date(bucketStart).toISOString(),
      open: roundUnit(b.open),
      high: roundUnit(b.high),
      low: roundUnit(b.low),
      close: roundUnit(b.close),
      volume_alpha: roundUnit(b.volumeAlpha),
      volume_tao: roundUnit(b.volumeTao),
      event_count: b.eventCount,
    };
  });

  return {
    schema_version: 1,
    netuid,
    interval: normalizedInterval,
    candles,
    root_excluded: false,
  };
}
