// USD across a time series (#10382).
//
// The failure this guards is not a crash — it is a chart that renders
// perfectly and is wrong at every point but the last. Multiplying thirteen
// months of alpha prices by today's TAO/USD produces exactly that, and nothing
// in the output looks off: the curve keeps its shape. So the tests that matter
// most here assert what is ABSENT (a bucket older than the index is null) and
// what is ORDERED (one rate per candle, so high_usd never falls below
// close_usd).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { OHLC_INTERVALS } from "../src/subnet-ohlc.ts";
import {
  loadTaoUsdAtInstants,
  loadTaoUsdBuckets,
  ohlcUsdWindowStart,
  taoUsdBucketMap,
  taoUsdBucketSql,
  TAO_USD_BUCKET_CAP,
  withAlphaUsdCandles,
  withAlphaUsdTrendDays,
} from "../src/alpha-usd-history.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
// An hour boundary, so bucket_start values are exact multiples.
const T0 = Date.parse("2026-08-08T00:00:00.000Z");

const reading = (bucketStart: number, usd: number | null, basis?: string) => ({
  bucket_start: bucketStart,
  // :59 of the bucket — the last reading inside it, which is what the SQL picks.
  observed_at: bucketStart + HOUR - 1000,
  usd_per_tao: usd,
  block_number: 25_700_000,
  price_basis:
    basis ?? (usd === null ? "insufficient_pools" : "wrapped_onchain_median"),
});

const candle = (
  bucketStart: number,
  o: number,
  h: number,
  l: number,
  c: number,
) => ({
  bucket_start: bucketStart,
  bucket_start_iso: new Date(bucketStart).toISOString(),
  open: o,
  high: h,
  low: l,
  close: c,
  volume_tao: 12.5,
  volume_alpha: 100,
  event_count: 3,
});

const ohlc = (candles: Record<string, unknown>[]) => ({
  schema_version: 1,
  netuid: 64,
  interval: "1h",
  candles,
  candle_count: candles.length,
  root_excluded: false,
});

describe("the bucketing SQL", () => {
  test("aligns exactly the way both OHLC tiers bucket", () => {
    // buildSubnetOhlc computes Math.floor(observedAt / intervalMs) * intervalMs.
    // If the SQL's integer division disagreed, every rate would land one bucket
    // off — a silent, uniform, entirely plausible-looking error.
    const sql = taoUsdBucketSql(HOUR);
    assert.match(sql, /DISTINCT ON \(observed_at \/ 3600000\)/);
    assert.match(sql, /\(observed_at \/ 3600000\) \* 3600000 AS bucket_start/);
  });

  test("prefers a PRICED reading over a later unpriced one in the same bucket", () => {
    // One `insufficient_pools` row landing at :59 must not mark an hour
    // unpriced when fifty-nine priced readings preceded it.
    assert.match(
      taoUsdBucketSql(HOUR),
      /ORDER BY observed_at \/ 3600000, \(usd_per_tao IS NOT NULL\) DESC, observed_at DESC/,
    );
  });

  test("refuses a bucket size that would misalign every bucket", () => {
    // A fractional or non-positive interval cannot produce the floor the
    // assembler uses, so it fails here rather than returning shifted rates.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => taoUsdBucketSql(bad), RangeError, String(bad));
    }
  });

  test("is bounded, so a wide window cannot select the whole table", () => {
    assert.match(
      taoUsdBucketSql(DAY),
      new RegExp(`LIMIT ${TAO_USD_BUCKET_CAP}`),
    );
  });

  test("every interval the route accepts produces valid bucketing", () => {
    // Enumerated from the route's OWN vocabulary rather than from a list
    // restated here — a new interval must not silently skip this check.
    for (const [label, ms] of Object.entries(OHLC_INTERVALS)) {
      assert.doesNotThrow(() => taoUsdBucketSql(ms), label);
    }
  });
});

describe("loading rates", () => {
  const db = (results: unknown[]) => ({
    query: async <Row>() => results as Row[],
  });

  test("a missing store is a FAILED read, not an empty one", async () => {
    // The distinction is load-bearing downstream: an empty series is a claim
    // about the index, a failed read is not.
    assert.equal(
      await loadTaoUsdBuckets(null, { sinceMs: 0, bucketMs: HOUR }),
      null,
    );
    assert.equal(
      await loadTaoUsdBuckets({} as never, { sinceMs: 0, bucketMs: HOUR }),
      null,
    );
  });

  test("a throwing store yields null rather than propagating", async () => {
    const boom = {
      query: async () => {
        throw new Error("connection reset");
      },
    };
    assert.equal(
      await loadTaoUsdBuckets(boom, { sinceMs: 0, bucketMs: HOUR }),
      null,
    );
  });

  test("rows come back as the reading shape alphaUsd expects", async () => {
    const rows = await loadTaoUsdBuckets(db([reading(T0, 191.5)]), {
      sinceMs: T0,
      bucketMs: HOUR,
    });
    const map = taoUsdBucketMap(rows);
    const r = map.get(T0);
    assert.equal(r?.usd_per_tao, 191.5);
    // Stored as epoch ms, but alphaUsd parses observed_at with Date.parse, so
    // it has to arrive as ISO — a raw bigint here would read as unparseable,
    // which taoUsdUsable treats as STALE.
    assert.equal(r?.observed_at, new Date(T0 + HOUR - 1000).toISOString());
  });

  test("a row without a usable bucket_start is dropped, not keyed to NaN", () => {
    const map = taoUsdBucketMap([
      { ...reading(T0, 191.5), bucket_start: "not-a-number" },
      reading(T0 + HOUR, 192),
    ]);
    assert.equal(map.size, 1);
    assert.ok(map.has(T0 + HOUR));
  });

  test("non-array input yields an empty map", () => {
    for (const bad of [null, undefined, 42 as never]) {
      assert.equal(taoUsdBucketMap(bad as never).size, 0);
    }
  });
});

describe("pricing candles", () => {
  test("A CANDLE OLDER THAN THE INDEX IS NULL, never today's rate", () => {
    // The whole point of the module. The old candle must not borrow the rate
    // that priced the recent one.
    const old = T0 - 200 * DAY;
    const out = withAlphaUsdCandles(
      ohlc([
        candle(old, 0.05, 0.06, 0.04, 0.055),
        candle(T0, 0.08, 0.09, 0.07, 0.088),
      ]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    const candles = out.candles as Record<string, unknown>[];
    assert.equal(
      candles[0].close_usd,
      null,
      "a pre-index candle must not be priced",
    );
    assert.equal(candles[0].usd_per_tao, null);
    assert.equal(candles[1].close_usd, 0.088 * 200);
  });

  test("ONE rate per candle, so the OHLC ordering survives", () => {
    // Pricing each field against the rate at its own instant can put high_usd
    // below close_usd and turn a candle inside out. A single positive
    // multiplier is monotonic, so every ordering the TAO candle had is kept.
    const out = withAlphaUsdCandles(
      ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    const c = (out.candles as Record<string, unknown>[])[0];
    const [o, h, l, cl] = [
      c.open_usd,
      c.high_usd,
      c.low_usd,
      c.close_usd,
    ] as number[];
    assert.ok(h >= o && h >= cl && h >= l, "high must dominate");
    assert.ok(l <= o && l <= cl, "low must be dominated");
    assert.equal(c.usd_per_tao, 200);
  });

  test("volume travels in USD too", () => {
    const out = withAlphaUsdCandles(
      ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    assert.equal(
      (out.candles as Record<string, unknown>[])[0].volume_usd,
      12.5 * 200,
    );
  });

  test("`insufficient_pools` in the bucket is null, NOT a price of zero", () => {
    const out = withAlphaUsdCandles(
      ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
      taoUsdBucketMap([reading(T0, null)]),
      HOUR,
    );
    const c = (out.candles as Record<string, unknown>[])[0];
    assert.equal(c.close_usd, null);
    assert.equal(out.usd_unavailable, "index_unpriced");
    assert.equal(out.priced_candle_count, 0);
  });

  test("the coverage boundary is PUBLISHED, not inferred from where nulls stop", () => {
    const old = T0 - 200 * DAY;
    const out = withAlphaUsdCandles(
      ohlc([
        candle(old, 0.05, 0.06, 0.04, 0.055),
        candle(T0, 0.08, 0.09, 0.07, 0.088),
      ]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    assert.equal(out.usd_available_from, T0);
    assert.equal(out.usd_available_from_iso, new Date(T0).toISOString());
    assert.equal(out.priced_candle_count, 1);
    // Partially priced: the boundary explains it, so no blanket reason.
    assert.equal(out.usd_unavailable, null);
  });

  test("90 days of TAO and 8 days of USD are BOTH legible", () => {
    // The acceptance criterion, as a caller would experience it.
    const candles = Array.from({ length: 90 }, (_, i) =>
      candle(T0 - (89 - i) * DAY, 0.08, 0.09, 0.07, 0.088),
    );
    const rates = candles
      .slice(-8)
      .map((c) => reading(c.bucket_start as number, 200));
    const out = withAlphaUsdCandles(ohlc(candles), taoUsdBucketMap(rates), DAY);
    assert.equal((out.candles as unknown[]).length, 90, "TAO series is intact");
    assert.equal(
      out.priced_candle_count,
      8,
      "USD covers only what the index does",
    );
    assert.equal(out.usd_available_from, T0 - 7 * DAY);
  });

  test("a FAILED read keeps the point shape and names itself", () => {
    // "We could not ask" is not "the index had nothing", and the top-level
    // reason is the only place that distinction lives. The POINTS still carry
    // the full null-filled shape, so a caller charting close_usd gets a hole
    // in the line rather than an array whose keys changed under it.
    const out = withAlphaUsdCandles(
      ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
      null,
      HOUR,
    );
    assert.equal(out.usd_unavailable, "read_failed");
    assert.equal(out.usd_available_from, null);
    assert.equal(out.priced_candle_count, 0);
    const c = (out.candles as Record<string, unknown>[])[0];
    assert.equal(c.close_usd, null);
    assert.equal(c.usd_per_tao, null);
    // The TAO side is untouched — a rate we could not fetch says nothing about
    // the prices we did.
    assert.equal(c.close, 0.088);
  });

  test("the emitted key set is IDENTICAL whether or not a rate was found", () => {
    // The stated reason for nulls-over-omissions. If a failed read returned a
    // different shape, every caller would need two code paths for one series.
    const shape = (map: Parameters<typeof withAlphaUsdCandles>[1]) =>
      Object.keys(
        (
          withAlphaUsdCandles(
            ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
            map,
            HOUR,
          ).candles as Record<string, unknown>[]
        )[0],
      ).sort();
    const priced = shape(taoUsdBucketMap([reading(T0, 200)]));
    assert.deepEqual(shape(null), priced, "failed read");
    assert.deepEqual(
      shape(taoUsdBucketMap([])),
      priced,
      "no reading in bucket",
    );
  });

  test("an empty series states no reason — there was nothing to price", () => {
    const out = withAlphaUsdCandles(ohlc([]), taoUsdBucketMap([]), HOUR);
    assert.equal(out.usd_unavailable, null);
    assert.equal(out.priced_candle_count, 0);
    assert.equal(out.usd_available_from, null);
  });

  test("a payload with no candles array is passed through, not crashed on", () => {
    // Root (netuid 0) short-circuits to a degenerate shape; a missing or
    // malformed candles array must not throw inside an overlay.
    const out = withAlphaUsdCandles(
      { netuid: 0, root_excluded: true },
      taoUsdBucketMap([]),
      HOUR,
    );
    assert.equal(out.root_excluded, true);
    assert.equal(out.usd_available_from, null);
  });

  test("a candle with an unusable bucket_start is refused, not mispriced", () => {
    const broken = {
      ...candle(T0, 0.08, 0.09, 0.07, 0.088),
      bucket_start: "x",
    };
    const out = withAlphaUsdCandles(
      ohlc([broken]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    assert.equal((out.candles as Record<string, unknown>[])[0].close_usd, null);
  });

  test("a MISSING TAO field never coerces into a $0 price", () => {
    // Number(null), Number("") and Number(false) are all 0, so a naive
    // Number(x) turns an absent field into a legitimate-looking $0 — the exact
    // inversion of the rule alpha-usd.ts holds. Caught this way once already.
    for (const missing of [null, undefined, "", "   ", false]) {
      const c = { ...candle(T0, 0.08, 0.09, 0.07, 0.088), high: missing };
      const out = withAlphaUsdCandles(
        ohlc([c]),
        taoUsdBucketMap([reading(T0, 200)]),
        HOUR,
      );
      const got = (out.candles as Record<string, unknown>[])[0];
      assert.equal(got.high_usd, null, `high: ${JSON.stringify(missing)}`);
      // Its siblings still price, and the candle still reports the rate used.
      assert.equal(got.close_usd, 0.088 * 200);
      assert.equal(got.usd_per_tao, 200);
    }
  });

  test("a REAL zero is a price, and prices to $0", () => {
    // The other side of the same line: a pool with no TAO in it has a measured
    // price of 0, and 0 x rate is a legitimate $0 — refusing it would turn a
    // measurement into "unavailable".
    const c = { ...candle(T0, 0.08, 0.09, 0.07, 0.088), low: 0 };
    const out = withAlphaUsdCandles(
      ohlc([c]),
      taoUsdBucketMap([reading(T0, 200)]),
      HOUR,
    );
    assert.equal((out.candles as Record<string, unknown>[])[0].low_usd, 0);
  });

  test("USD is declared RECONSTRUCTED", () => {
    const out = withAlphaUsdCandles(ohlc([]), taoUsdBucketMap([]), HOUR);
    assert.deepEqual(out.field_sources_usd, {
      kind: "reconstructed",
      storage: null,
    });
  });
});

describe("pricing trend days", () => {
  const day = (date: string, weighted: number, median: number) => ({
    snapshot_date: date,
    subnet_count: 129,
    alpha_price_tao_weighted: weighted,
    alpha_price_tao_median: median,
  });
  // The loader returns days NEWEST FIRST.
  const trends = (days: Record<string, unknown>[]) => ({
    schema_version: 1,
    day_count: days.length,
    days,
  });
  const dayStart = (date: string) => Date.parse(`${date}T00:00:00.000Z`);

  test("a day older than the index is null", () => {
    const out = withAlphaUsdTrendDays(
      trends([day("2026-08-08", 0.05, 0.04), day("2025-09-01", 0.03, 0.02)]),
      taoUsdBucketMap([reading(dayStart("2026-08-08"), 200)]),
    );
    const days = out.days as Record<string, unknown>[];
    assert.equal(days[0].alpha_price_usd_weighted, 0.05 * 200);
    assert.equal(days[1].alpha_price_usd_weighted, null);
    assert.equal(days[1].usd_per_tao, null);
  });

  test("the boundary is the OLDEST priced day, though days arrive newest-first", () => {
    // Latching on the first hit would report the NEWEST priced day as the point
    // where USD begins — backwards, and wrong by the whole priced window.
    const out = withAlphaUsdTrendDays(
      trends([
        day("2026-08-09", 0.05, 0.04),
        day("2026-08-08", 0.05, 0.04),
        day("2025-09-01", 0.03, 0.02),
      ]),
      taoUsdBucketMap([
        reading(dayStart("2026-08-09"), 200),
        reading(dayStart("2026-08-08"), 199),
      ]),
    );
    assert.equal(out.usd_available_from, "2026-08-08");
    assert.equal(out.priced_day_count, 2);
  });

  test("a malformed snapshot_date is refused rather than priced at epoch", () => {
    const out = withAlphaUsdTrendDays(
      trends([{ ...day("2026-08-08", 0.05, 0.04), snapshot_date: 20260808 }]),
      taoUsdBucketMap([reading(dayStart("2026-08-08"), 200)]),
    );
    assert.equal(
      (out.days as Record<string, unknown>[])[0].alpha_price_usd_weighted,
      null,
    );
    assert.equal(out.usd_unavailable, "no_index_reading");
  });

  test("a failed read is distinguished from an unpriced series", () => {
    const out = withAlphaUsdTrendDays(
      trends([day("2026-08-08", 0.05, 0.04)]),
      null,
    );
    assert.equal(out.usd_unavailable, "read_failed");
  });

  test("an empty series states no reason", () => {
    const out = withAlphaUsdTrendDays(trends([]), taoUsdBucketMap([]));
    assert.equal(out.usd_unavailable, null);
    assert.equal(out.priced_day_count, 0);
  });

  test("a payload with no days array is passed through", () => {
    const out = withAlphaUsdTrendDays({ day_count: 0 }, taoUsdBucketMap([]));
    assert.equal(out.day_count, 0);
    assert.equal(out.usd_available_from, null);
  });
});

describe("shapes the store actually returns", () => {
  test("zero rows reads as empty, not as a failure", async () => {
    // A store that answers but has nothing to say is an EMPTY series; only a
    // throw or a missing binding is a failed read. (The D1 "no results key"
    // premise retired with the envelope, #10909.)
    const db = { query: async () => [] };
    assert.deepEqual(
      await loadTaoUsdBuckets(db, { sinceMs: 0, bucketMs: HOUR }),
      [],
    );
  });

  test("a NUMERIC column arriving as a STRING still prices", () => {
    // Postgres drivers hand back NUMERIC as a string to avoid double rounding,
    // so `usd_per_tao` and the candle's own prices can both be strings on the
    // wire. Refusing them would unprice the entire series against a live
    // database while every fixture-backed test stayed green.
    const map = taoUsdBucketMap([
      { ...reading(T0, null), usd_per_tao: "200.5" },
    ]);
    assert.equal(map.get(T0)?.usd_per_tao, 200.5);
    const out = withAlphaUsdCandles(
      ohlc([{ ...candle(T0, 0.08, 0.09, 0.07, 0.088), close: "0.088" }]),
      map,
      HOUR,
    );
    assert.equal(
      (out.candles as Record<string, unknown>[])[0].close_usd,
      0.088 * 200.5,
    );
  });

  test("a reading missing its stamp or basis carries null, not undefined", () => {
    const map = taoUsdBucketMap([
      { bucket_start: T0, usd_per_tao: 200, block_number: 1 },
    ]);
    const r = map.get(T0);
    assert.equal(r?.observed_at, null);
    assert.equal(r?.price_basis, null);
    // And a reading that cannot say WHEN is refused rather than trusted --
    // alpha-usd.ts treats an unparseable stamp as stale.
    const out = withAlphaUsdCandles(
      ohlc([candle(T0, 0.08, 0.09, 0.07, 0.088)]),
      map,
      HOUR,
    );
    assert.equal((out.candles as Record<string, unknown>[])[0].close_usd, null);
    assert.equal(out.usd_unavailable, "index_stale");
  });
});

describe("deciding whether to read at all", () => {
  test("no candles means no read", () => {
    // Root (netuid 0) and a cold store both land here. A query for a window no
    // point falls in can only return rows nobody reads.
    assert.equal(ohlcUsdWindowStart(ohlc([])), null);
    assert.equal(ohlcUsdWindowStart({ netuid: 0, root_excluded: true }), null);
  });

  test("the window starts at the OLDEST candle", () => {
    // Candles are ascending, so the first is the floor the index must cover.
    const out = ohlcUsdWindowStart(
      ohlc([
        candle(T0, 0.08, 0.09, 0.07, 0.088),
        candle(T0 + HOUR, 1, 1, 1, 1),
      ]),
    );
    assert.equal(out, T0);
  });

  test("an unusable bucket_start skips the read rather than reading from 0", () => {
    // `Number(x) || 0` would turn a malformed start into epoch zero and pull
    // the entire index back as the window.
    assert.equal(
      ohlcUsdWindowStart(
        ohlc([{ ...candle(T0, 1, 1, 1, 1), bucket_start: "x" }]),
      ),
      null,
    );
  });
});

describe("loadTaoUsdAtInstants", () => {
  // The per-instant read behind /accounts/{ss58}/transfers' USD pricing. It had
  // no direct test: every assertion about it went through the route, so the
  // rules it enforces on its own rows -- which instants make it into the map,
  // and which deliberately do not -- were only ever implied.
  const READING = {
    instant: T0,
    usd_per_tao: 191.5,
    observed_at: T0 - 60_000,
    block_number: 8_800_000,
    price_basis: "pool-twap",
  };

  test("maps each instant to the newest reading at or before it", async () => {
    const db = { query: async <Row>() => [READING] as Row[] };
    const map = await loadTaoUsdAtInstants(db, [T0]);
    assert.equal(map?.size, 1);
    assert.equal(map?.get(T0)?.usd_per_tao, 191.5);
    // The stamp is ISO on the way out, not the raw epoch the row carries.
    assert.equal(
      map?.get(T0)?.observed_at,
      new Date(T0 - 60_000).toISOString(),
    );
    assert.equal(map?.get(T0)?.block_number, 8_800_000);
    assert.equal(map?.get(T0)?.price_basis, "pool-twap");
  });

  test("an instant that predates the index is ABSENT, never a null rate", async () => {
    // #8602's rule: the index starts when collection started, and an event
    // older than that has NO rate. A null-valued entry would read as "the rate
    // was nothing", which is a number nobody measured.
    const db = {
      query: async <Row>() => [{ ...READING, usd_per_tao: null }] as Row[],
    };
    const map = await loadTaoUsdAtInstants(db, [T0]);
    assert.equal(map?.size, 0);
    assert.equal(map?.has(T0), false);
  });

  test("a row whose instant is unreadable is dropped, not keyed on NaN", async () => {
    const db = {
      query: async <Row>() => [{ ...READING, instant: "nope" }] as Row[],
    };
    assert.equal((await loadTaoUsdAtInstants(db, [T0]))?.size, 0);
  });

  test("no instants asked is an empty map, and asks the store nothing", async () => {
    // Distinct from a decline: the caller had nothing to price, which is a
    // real answer and must not cost a query.
    let asked = 0;
    const db = {
      query: async <Row>() => {
        asked += 1;
        return [] as Row[];
      },
    };
    assert.deepEqual(await loadTaoUsdAtInstants(db, []), new Map());
    assert.deepEqual(await loadTaoUsdAtInstants(db, [Number.NaN]), new Map());
    assert.equal(asked, 0, "an empty ask must not reach the store");
  });

  test("no store and a throwing read are both null, never an empty map", async () => {
    // The distinction the callers act on: an empty map says "priced nothing",
    // null says "could not price", and only the second may suppress a figure.
    assert.equal(await loadTaoUsdAtInstants(null, [T0]), null);
    assert.equal(await loadTaoUsdAtInstants({}, [T0]), null);
    const throwing = {
      query: async () => {
        throw new Error("store read failed");
      },
    };
    assert.equal(await loadTaoUsdAtInstants(throwing, [T0]), null);
  });

  test("the statement bins every wanted instant through ONE lateral join", async () => {
    // One query for N instants, not N queries: the unnest+LATERAL shape is
    // what keeps a 1000-transfer page from becoming 1000 point reads.
    let sql = "";
    let values: unknown[] = [];
    const db = {
      query: async <Row>(text: string, v: unknown[] = []) => {
        sql = text;
        values = v;
        return [] as Row[];
      },
    };
    await loadTaoUsdAtInstants(db, [T0, T0 - 1000, T0]);
    assert.match(sql, /unnest\(\?::bigint\[\]\)/);
    assert.match(sql, /LEFT JOIN LATERAL/);
    assert.match(sql, /ORDER BY observed_at DESC LIMIT 1/);
    // Deduplicated: the same instant asked twice is bound once.
    assert.deepEqual(values, [[T0, T0 - 1000]]);
  });
});
