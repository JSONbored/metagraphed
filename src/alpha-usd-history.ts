// USD across a TIME SERIES, priced per bucket rather than per response (#10382).
//
// src/alpha-usd.ts prices one figure against one reading -- the right primitive
// for a spot surface, where every field describes the same instant. A series is
// the other case: /subnets/{netuid}/ohlc and /economics/trends publish points
// spanning months, and there is no single rate that is correct for all of them.
//
// ## THE TRAP THIS MODULE EXISTS TO CLOSE
//
//   alpha price history   2025-06-23 -> 2026-08-10   ~13 months of daily rows
//   tao_usd_index         2026-08-02 -> 2026-08-10   ~8 days at one row/minute
//
// Multiplying thirteen months of alpha prices by TODAY's TAO/USD produces a
// chart that renders perfectly and is wrong at every point except the last. It
// is not a USD history; it is one exchange rate applied retroactively. The
// error is invisible in the output -- the curve keeps its shape, so it looks
// like data -- which is why the rule is structural rather than advisory:
//
//   A POINT IS PRICED BY A READING FROM ITS OWN BUCKET, OR IT IS NOT PRICED.
//
// A bucket older than the index carries `null`. Never the nearest rate, never
// the first rate, never today's.
//
// ## ONE RATE PER BUCKET, NOT ONE PER FIELD
//
// A candle's open/high/low/close happen at four different instants inside the
// bucket, so pricing each against the rate at ITS instant is tempting and
// wrong: with a moving rate, `high_usd` can come out below `close_usd` and the
// OHLC invariant (high >= open, close, low) breaks. A chart drawn from that has
// candles inside out. Multiplying all four by ONE positive rate is monotonic,
// so every ordering the TAO candle had, the USD candle still has.
//
// The rate chosen is the LAST reading observed WITHIN the bucket --
// contemporaneous by construction, and the same "close" convention the candle
// itself uses. It is never a reading from after the bucket, so no point is
// priced with information that did not exist yet.
//
// ## WHY THE BUCKETING IS DONE IN SQL
//
// The index writes about once a minute: an 8-day overlap is ~11,500 rows to
// fetch and walk per request, to produce at most a few hundred rates. The
// DISTINCT ON below collapses that to one row per bucket in the engine, so the
// body crossing the wire is bounded by the CANDLE count, not by the index's
// cadence -- the same reason src/subnet-ohlc-cold-tier.ts buckets in SQL.
//
// Bucket alignment is `(observed_at / bucketMs) * bucketMs`, integer division
// on a positive bigint, which is exactly the `Math.floor(observedAt /
// intervalMs) * intervalMs` both OHLC tiers already use. The two must agree or
// every rate lands one bucket off, so bucketMs comes from OHLC_INTERVALS rather
// than from a caller.
//
// ## A SERIES STATES ITS NULLS DIFFERENTLY FROM A SPOT SURFACE
//
// src/alpha-usd-overlay.ts OMITS a `_usd` field it cannot fill: on a spot blob,
// an absent field says "not available" and there is nothing to chart. Here the
// field is emitted as an explicit `null`, because a series is consumed as an
// array of uniform points -- a caller mapping `c => c.close_usd` must get a
// hole in the line, not an undefined that silently plots as zero or shortens
// the array. The reason for the nulls rides at the TOP level instead of on
// every point: for a 2,000-candle window the reason is the same string 1,900
// times, and repeating it would cost more than the prices do.

import {
  ALPHA_USD_FIELD_SOURCE,
  ALPHA_USD_UNAVAILABLE,
  alphaUsd,
  type AlphaUsdUnavailable,
  type TaoUsdReading,
} from "./alpha-usd.ts";
import { TAO_USD_TABLE } from "./tao-usd-series.ts";

type Row = Record<string, unknown>;

/** The minimal store surface used here, matching src/tao-usd-series.ts. */
export interface TaoUsdBucketDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/**
 * Rates fetched per request, whatever the window.
 *
 * MAX_CANDLES is 2,000 and a day series is at most 365 points, so this ceiling
 * is never the binding constraint on a legitimate read -- it is the backstop
 * that keeps a malformed bucketMs from selecting the whole table.
 */
/**
 * Every reason a SERIES may carry no USD, including the one only a series has.
 *
 * `read_failed` is not an AlphaUsdUnavailable: those describe what the index
 * SAID, and this one says we never got to ask. Kept distinct because "the index
 * declined to price this window" and "we could not reach the index" send an
 * operator to different places.
 *
 * Derived from ALPHA_USD_UNAVAILABLE rather than retyped, so a new reason there
 * appears here automatically.
 */
export const SERIES_USD_UNAVAILABLE = [
  ...ALPHA_USD_UNAVAILABLE,
  "read_failed",
] as const;

export const TAO_USD_BUCKET_CAP = 2500;

/**
 * The last reading inside each bucket, one row per bucket.
 *
 * `DISTINCT ON` orders priced readings ahead of unpriced ones within a bucket,
 * so a single `insufficient_pools` row landing at :59 cannot mark an hour
 * unpriced when fifty-nine priced readings preceded it. When a bucket holds
 * ONLY unpriced readings, the surviving row carries that basis through -- the
 * distinction between "the index was down" (no row at all) and "the index
 * declined to price this window" (a row with a null price) is one ADR 0025 went
 * to the trouble of recording, and it survives to the caller.
 */
export function taoUsdBucketSql(bucketMs: number): string {
  // Interpolated, never bound: this is an internal interval constant, and a
  // placeholder inside the DISTINCT ON expression would not be usable as a
  // sort key. Integral by construction, and asserted so a fractional value
  // fails here rather than producing a silently misaligned bucket.
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
    throw new RangeError(
      `bucketMs must be a positive integer, got ${bucketMs}`,
    );
  }
  return (
    `SELECT DISTINCT ON (observed_at / ${bucketMs})` +
    ` (observed_at / ${bucketMs}) * ${bucketMs} AS bucket_start,` +
    ` observed_at, usd_per_tao, block_number, price_basis` +
    ` FROM ${TAO_USD_TABLE} WHERE observed_at >= ?` +
    ` ORDER BY observed_at / ${bucketMs},` +
    ` (usd_per_tao IS NOT NULL) DESC, observed_at DESC` +
    ` LIMIT ${TAO_USD_BUCKET_CAP}`
  );
}

/**
 * One reading per bucket from `sinceMs` forward. Null when the read fails.
 *
 * A null return means "we could not ask", which the overlays render as an
 * unpriced series rather than as an empty one -- a distinction that matters
 * because an empty series is a claim about the index and a failed read is not.
 */
export async function loadTaoUsdBuckets(
  db: TaoUsdBucketDb | null | undefined,
  { sinceMs, bucketMs }: { sinceMs: number; bucketMs: number },
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  try {
    const res = await (
      db.prepare(taoUsdBucketSql(bucketMs)).bind(sinceMs) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Bucket start -> the reading that prices it. */
export function taoUsdBucketMap(
  rows: Row[] | null | undefined,
): Map<number, TaoUsdReading> {
  const map = new Map<number, TaoUsdReading>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const start = int(r?.bucket_start);
    if (start === null) continue;
    const observed = int(r?.observed_at);
    map.set(start, {
      usd_per_tao:
        r?.usd_per_tao === null || r?.usd_per_tao === undefined
          ? null
          : Number(r.usd_per_tao),
      // Stored as epoch ms; alphaUsd parses this with Date.parse, so it has to
      // arrive as an ISO string rather than as the raw bigint.
      observed_at: observed === null ? null : new Date(observed).toISOString(),
      block_number: int(r?.block_number),
      price_basis: (r?.price_basis as string | null) ?? null,
    });
  }
  return map;
}

/**
 * The instant a candle payload's USD lookup must start from, or null when
 * there is nothing to price.
 *
 * Lives here rather than in the handler so the handler never reaches into a
 * candle's fields, and so the "no candles" and "unusable bucket_start" cases
 * are exercised by this module's own tests instead of needing a Worker fixture
 * for each. Null means SKIP THE READ -- root (netuid 0) and a cold store both
 * produce empty candle arrays, and querying the index for a window no point
 * falls in is a round trip that can only return rows nobody will use.
 */
export function ohlcUsdWindowStart(data: Row): number | null {
  const candles = Array.isArray(data?.candles) ? (data.candles as Row[]) : [];
  // Candles are ASCENDING, so the first is the oldest and therefore the floor
  // of the window the index has to cover.
  return candles.length ? int(candles[0]?.bucket_start) : null;
}

/**
 * The rate a bucket is priced at, given the reading found in it.
 *
 * The freshness bound is the BUCKET, not TAO_USD_MAX_AGE_MS. A reading selected
 * by taoUsdBucketSql is inside the bucket by construction, so measuring its age
 * against the bucket's own end is the check that is actually meaningful here --
 * asking whether it is within two hours of NOW would refuse every historical
 * point in the series, which is the opposite of the intent.
 */
function priceAt(
  tao: unknown,
  reading: TaoUsdReading | undefined,
  bucketStart: number,
  bucketMs: number,
): { usd: number; rate: number } | { reason: AlphaUsdUnavailable } {
  // NOT `Number(tao)`. `Number(null)`, `Number("")` and `Number(false)` are all
  // 0, so a MISSING field would coerce into a legitimate-looking $0 -- the
  // precise inversion of the rule src/alpha-usd.ts exists to hold: zero is a
  // price, absent is not. Only a real number, or a string that says one,
  // reaches the multiply.
  const n =
    typeof tao === "number"
      ? tao
      : typeof tao === "string" && tao.trim() !== ""
        ? Number(tao)
        : Number.NaN;
  const out = alphaUsd(
    Number.isFinite(n) ? n : null,
    reading ?? null,
    bucketStart + bucketMs,
    bucketMs,
  );
  return out.ok
    ? { usd: out.value.usd, rate: out.value.usd_per_tao }
    : { reason: out.reason };
}

/** Price fields on a candle, and the TAO field each is derived from. */
const CANDLE_USD_FIELDS = [
  ["open", "open_usd"],
  ["high", "high_usd"],
  ["low", "low_usd"],
  ["close", "close_usd"],
  ["volume_tao", "volume_usd"],
] as const;

/**
 * Add USD to an assembled OHLC payload.
 *
 * Applied AFTER the tier resolves rather than inside the candle assembler, so
 * the hot tier, the lakehouse cold tier and the empty fallback all gain USD
 * from one place and cannot disagree -- and so buildSubnetOhlcFromBuckets,
 * which GraphQL and MCP also call, keeps the shape those surfaces already
 * publish.
 */
export function withAlphaUsdCandles(
  data: Row,
  byBucket: Map<number, TaoUsdReading> | null,
  bucketMs: number,
): Row {
  const candles = Array.isArray(data?.candles) ? (data.candles as Row[]) : [];
  // A failed read still produces the FULL point shape, every USD field null.
  // Returning a different key set would defeat the reason these are nulls
  // rather than omissions: a caller mapping `c => c.close_usd` must get a hole
  // in the line whatever went wrong upstream. Only the top-level reason
  // distinguishes "we could not ask" from "the index had nothing".
  const readFailed = byBucket === null;
  const rates = byBucket ?? new Map<number, TaoUsdReading>();

  let availableFrom: number | null = null;
  let pricedCount = 0;
  // The FIRST reason seen, not a set: only one is ever published, and a Set
  // left an unreachable `?? fallback` branch standing in for its empty case.
  let firstReason: AlphaUsdUnavailable | null = null;

  const priced = candles.map((c) => {
    const start = int(c?.bucket_start);
    const reading = start === null ? undefined : rates.get(start);
    const out: Row = { ...c };
    let rate: number | null = null;

    for (const [taoField, usdField] of CANDLE_USD_FIELDS) {
      const r =
        start === null
          ? { reason: "no_index_reading" as AlphaUsdUnavailable }
          : priceAt(c?.[taoField], reading, start, bucketMs);
      if ("usd" in r) {
        out[usdField] = r.usd;
        rate = r.rate;
      } else {
        out[usdField] = null;
        firstReason ??= r.reason;
      }
    }

    // The rate every field on this candle was multiplied by -- one number, so a
    // caller can audit the conversion without the response carrying five
    // provenance fields per point.
    out.usd_per_tao = rate;
    if (rate !== null) {
      pricedCount += 1;
      if (availableFrom === null && start !== null) availableFrom = start;
    }
    return out;
  });

  return {
    ...data,
    candles: priced,
    // Where USD starts, published rather than left to be inferred from where
    // the nulls stop. A caller can render "USD from 2026-08-02" instead of a
    // series that silently changes meaning partway along.
    usd_available_from: availableFrom,
    usd_available_from_iso:
      availableFrom === null ? null : new Date(availableFrom).toISOString(),
    priced_candle_count: pricedCount,
    // Only when NOTHING priced. A partially-priced series explains itself
    // through usd_available_from; a wholly unpriced one needs to say why, and
    // "we could not ask" outranks whatever the empty rate set implied.
    usd_unavailable: readFailed
      ? "read_failed"
      : pricedCount === 0 && candles.length > 0
        ? firstReason
        : null,
    field_sources_usd: ALPHA_USD_FIELD_SOURCE,
  };
}

/** Price fields on a trends day, and the TAO field each is derived from. */
const TREND_USD_FIELDS = [
  ["alpha_price_tao_weighted", "alpha_price_usd_weighted"],
  ["alpha_price_tao_median", "alpha_price_usd_median"],
] as const;

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

/**
 * Add USD to an assembled economics-trends payload.
 *
 * The day series is keyed by `snapshot_date` (a UTC calendar date) rather than
 * by an epoch bucket, so the rate for a day is the last reading observed inside
 * that UTC day -- the same "last reading in the bucket" rule the candles use,
 * with the bucket being the day.
 *
 * Deliberately NOT keyed off each snapshot's own capture instant, even though
 * subnet_snapshots records one: the trends day is a network-wide aggregate over
 * ~129 subnets whose captures do not share an instant, so there is no single
 * capture time for the day to price against. The day is the finest grain the
 * aggregate actually has.
 */
export function withAlphaUsdTrendDays(
  data: Row,
  byBucket: Map<number, TaoUsdReading> | null,
): Row {
  const days = Array.isArray(data?.days) ? (data.days as Row[]) : [];
  // Same uniform-shape rule as the candles: a failed read still emits every USD
  // field as null, and only the top-level reason says why.
  const readFailed = byBucket === null;
  const rates = byBucket ?? new Map<number, TaoUsdReading>();

  let availableFrom: string | null = null;
  let pricedCount = 0;
  // The FIRST reason seen, not a set: only one is ever published, and a Set
  // left an unreachable `?? fallback` branch standing in for its empty case.
  let firstReason: AlphaUsdUnavailable | null = null;

  const priced = days.map((d) => {
    const date = typeof d?.snapshot_date === "string" ? d.snapshot_date : null;
    const startMs = date === null ? NaN : Date.parse(`${date}T00:00:00.000Z`);
    const start = Number.isFinite(startMs) ? startMs : null;
    const reading = start === null ? undefined : rates.get(start);
    const out: Row = { ...d };
    let rate: number | null = null;

    for (const [taoField, usdField] of TREND_USD_FIELDS) {
      const r =
        start === null
          ? { reason: "no_index_reading" as AlphaUsdUnavailable }
          : priceAt(d?.[taoField], reading, start, DAY_MS_LOCAL);
      if ("usd" in r) {
        out[usdField] = r.usd;
        rate = r.rate;
      } else {
        out[usdField] = null;
        firstReason ??= r.reason;
      }
    }

    out.usd_per_tao = rate;
    if (rate !== null) {
      pricedCount += 1;
      // Days arrive NEWEST FIRST, so the oldest priced day is the LAST one
      // seen, not the first -- overwritten on each hit rather than latched.
      // `date` is non-null whenever a rate was found: an unparseable
      // snapshot_date yields no bucket key, so nothing can price against it.
      availableFrom = date;
    }
    return out;
  });

  return {
    ...data,
    days: priced,
    usd_available_from: availableFrom,
    priced_day_count: pricedCount,
    usd_unavailable: readFailed
      ? "read_failed"
      : pricedCount === 0 && days.length > 0
        ? firstReason
        : null,
    field_sources_usd: ALPHA_USD_FIELD_SOURCE,
  };
}
