import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetOhlc,
  OHLC_INTERVALS,
  OHLC_INTERVAL_DEFAULT,
  MAX_CANDLES,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/subnet-ohlc.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const HOUR_MS = OHLC_INTERVALS["1h"];
const DAY_MS = OHLC_INTERVALS["1d"];
// An exact hour boundary, comfortably inside a normal epoch-ms range, so bucket
// math is easy to reason about by hand in every test below.
const BASE = 1_700_000_000 * 1000 - ((1_700_000_000 * 1000) % HOUR_MS);

function trade(kind, alpha, tao, observedAt, overrides = {}) {
  return {
    event_kind: kind,
    alpha_amount: alpha,
    amount_tao: tao,
    observed_at: observedAt,
    ...overrides,
  };
}

describe("buildSubnetOhlc — empty / cold-store input", () => {
  test("empty, null, and undefined rows all yield a schema-stable empty candle array", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildSubnetOhlc(rows, 7);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.interval, "1h");
      assert.deepEqual(data.candles, []);
      assert.equal(data.root_excluded, false);
    }
  });

  test("never throws on malformed rows (non-array, non-object entries)", () => {
    assert.doesNotThrow(() => buildSubnetOhlc("not-an-array", 7));
    assert.doesNotThrow(() => buildSubnetOhlc([null, undefined, 42, "x"], 7));
    const data = buildSubnetOhlc([null, undefined, 42, "x"], 7);
    assert.deepEqual(data.candles, []);
  });
});

describe("buildSubnetOhlc — root subnet (netuid 0)", () => {
  test("returns an empty candles array with root_excluded:true, regardless of input rows", () => {
    const rows = [trade(STAKE_ADDED_KIND, 10, 10, BASE)];
    const data = buildSubnetOhlc(rows, 0);
    assert.equal(data.netuid, 0);
    assert.deepEqual(data.candles, []);
    assert.equal(data.root_excluded, true);
  });

  test("still normalizes and echoes the requested interval for root", () => {
    const data = buildSubnetOhlc([], 0, { interval: "1d" });
    assert.equal(data.interval, "1d");
    assert.equal(data.root_excluded, true);
  });

  test("a non-root netuid always reports root_excluded:false", () => {
    const data = buildSubnetOhlc([], 42);
    assert.equal(data.root_excluded, false);
  });
});

describe("buildSubnetOhlc — single-bucket OHLCV math", () => {
  test("a single trade sets open, high, low, and close to that trade's price", () => {
    // price = amount_tao / alpha_amount = 20 / 10 = 2.
    const rows = [trade(STAKE_ADDED_KIND, 10, 20, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles.length, 1);
    const [candle] = data.candles;
    assert.equal(candle.open, 2);
    assert.equal(candle.high, 2);
    assert.equal(candle.low, 2);
    assert.equal(candle.close, 2);
    assert.equal(candle.volume_alpha, 10);
    assert.equal(candle.volume_tao, 20);
    assert.equal(candle.event_count, 1);
  });

  test("multiple trades: open = first price, close = last price, high/low = extremes", () => {
    // Prices in ascending observed_at order: 1, 3, 2, 5, 4.
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 10, BASE), // price 1 (open)
      trade(STAKE_ADDED_KIND, 10, 30, BASE + 60_000), // price 3
      trade(STAKE_REMOVED_KIND, 10, 20, BASE + 120_000), // price 2
      trade(STAKE_ADDED_KIND, 10, 50, BASE + 180_000), // price 5 (high)
      trade(STAKE_REMOVED_KIND, 10, 40, BASE + 240_000), // price 4 (close)
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles.length, 1);
    const [candle] = data.candles;
    assert.equal(candle.open, 1);
    assert.equal(candle.high, 5);
    assert.equal(candle.low, 1);
    assert.equal(candle.close, 4);
    assert.equal(candle.volume_alpha, 50);
    assert.equal(candle.volume_tao, 150);
    assert.equal(candle.event_count, 5);
  });

  test("low is updated as trades arrive with progressively lower prices (not just on the first trade)", () => {
    // Prices in ascending observed_at order: 5, 3, 1, 4, 2 -- the running low
    // must drop on the 2nd and 3rd trades, not just get set once at open.
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 50, BASE), // price 5 (open, initial low/high)
      trade(STAKE_ADDED_KIND, 10, 30, BASE + 60_000), // price 3 (new low)
      trade(STAKE_REMOVED_KIND, 10, 10, BASE + 120_000), // price 1 (new low again)
      trade(STAKE_ADDED_KIND, 10, 40, BASE + 180_000), // price 4
      trade(STAKE_REMOVED_KIND, 10, 20, BASE + 240_000), // price 2 (close)
    ];
    const data = buildSubnetOhlc(rows, 7);
    const [candle] = data.candles;
    assert.equal(candle.open, 5);
    assert.equal(candle.high, 5);
    assert.equal(candle.low, 1);
    assert.equal(candle.close, 2);
  });

  test("both StakeAdded and StakeRemoved contribute to the same candle (no buy/sell split)", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 5, 10, BASE),
      trade(STAKE_REMOVED_KIND, 5, 10, BASE + 60_000),
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].volume_alpha, 10);
    assert.equal(data.candles[0].event_count, 2);
  });

  test("when two trades share the same observed_at, open/close follow the array's original relative order (stable sort)", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 10, BASE), // price 1, listed first
      trade(STAKE_ADDED_KIND, 10, 30, BASE), // price 3, listed second
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles[0].open, 1);
    assert.equal(data.candles[0].close, 3);
  });
});

describe("buildSubnetOhlc — bucket boundaries and gaps", () => {
  test("bucket_start floors observed_at down to the interval boundary", () => {
    const rows = [trade(STAKE_ADDED_KIND, 1, 1, BASE + 1_800_000)]; // +30min
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles[0].bucket_start, BASE);
  });

  test("bucket_start_iso is the ISO-8601 rendering of bucket_start", () => {
    const rows = [trade(STAKE_ADDED_KIND, 1, 1, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(
      data.candles[0].bucket_start_iso,
      new Date(BASE).toISOString(),
    );
  });

  test("two trades 30 minutes apart share one 1h bucket", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, BASE + 100_000),
      trade(STAKE_ADDED_KIND, 1, 3, BASE + 3_000_000),
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].event_count, 2);
  });

  test("two trades in adjacent hours produce two separate 1h candles", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, BASE),
      trade(STAKE_ADDED_KIND, 1, 3, BASE + HOUR_MS),
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    assert.equal(data.candles.length, 2);
    assert.equal(data.candles[0].bucket_start, BASE);
    assert.equal(data.candles[1].bucket_start, BASE + HOUR_MS);
  });

  test("candles are sorted ascending by bucket_start regardless of trade order", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 3, BASE + 2 * HOUR_MS),
      trade(STAKE_ADDED_KIND, 1, 1, BASE),
      trade(STAKE_ADDED_KIND, 1, 2, BASE + HOUR_MS),
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    const starts = data.candles.map((c) => c.bucket_start);
    assert.deepEqual(starts, [BASE, BASE + HOUR_MS, BASE + 2 * HOUR_MS]);
  });

  test("an empty bucket between two active buckets produces NO candle (a gap, not a synthesized flat candle)", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, BASE), // hour 0
      trade(STAKE_ADDED_KIND, 1, 3, BASE + 3 * HOUR_MS), // hour 3 -- hours 1,2 empty
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    assert.equal(data.candles.length, 2);
    assert.equal(data.candles[0].bucket_start, BASE);
    assert.equal(data.candles[1].bucket_start, BASE + 3 * HOUR_MS);
  });
});

describe("buildSubnetOhlc — interval handling", () => {
  test("defaults to 1h when interval is omitted", () => {
    const data = buildSubnetOhlc([], 7);
    assert.equal(data.interval, "1h");
  });

  test("1d buckets by calendar day: trades at different hours of the same day share one candle", () => {
    const alignedDayStart = Math.floor(BASE / DAY_MS) * DAY_MS;
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, alignedDayStart + 1 * HOUR_MS),
      trade(STAKE_ADDED_KIND, 1, 5, alignedDayStart + 20 * HOUR_MS),
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1d" });
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].bucket_start, alignedDayStart);
  });

  test("1h and 1d produce different bucket counts for the same spread-out rows", () => {
    const alignedDayStart = Math.floor(BASE / DAY_MS) * DAY_MS;
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, alignedDayStart + 1 * HOUR_MS),
      trade(STAKE_ADDED_KIND, 1, 2, alignedDayStart + 5 * HOUR_MS),
      trade(STAKE_ADDED_KIND, 1, 3, alignedDayStart + 10 * HOUR_MS),
    ];
    const hourly = buildSubnetOhlc(rows, 7, { interval: "1h" });
    const daily = buildSubnetOhlc(rows, 7, { interval: "1d" });
    assert.equal(hourly.candles.length, 3);
    assert.equal(daily.candles.length, 1);
  });

  test("an unsupported interval value normalizes to the default (1h), never throws", () => {
    const rows = [trade(STAKE_ADDED_KIND, 1, 1, BASE)];
    const data = buildSubnetOhlc(rows, 7, { interval: "5m" });
    assert.equal(data.interval, "1h");
    assert.equal(data.candles.length, 1);
  });

  test("a non-string/garbage interval value (number, null, object) normalizes to the default", () => {
    for (const interval of [123, null, {}, undefined, ""]) {
      const data = buildSubnetOhlc([], 7, { interval });
      assert.equal(
        data.interval,
        OHLC_INTERVAL_DEFAULT,
        `interval=${String(interval)}`,
      );
    }
  });
});

describe("buildSubnetOhlc — malformed-row guarding (fund-safety precision)", () => {
  test("skips a row with alpha_amount of exactly 0 (no divide-by-zero)", () => {
    const rows = [trade(STAKE_ADDED_KIND, 0, 10, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
  });

  test("skips a row with a negative alpha_amount", () => {
    const rows = [trade(STAKE_ADDED_KIND, -5, 10, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
  });

  test("skips a row with a non-finite alpha_amount (NaN, Infinity, -Infinity)", () => {
    for (const alpha of [NaN, Infinity, -Infinity, "not-a-number"]) {
      const data = buildSubnetOhlc(
        [trade(STAKE_ADDED_KIND, alpha, 10, BASE)],
        7,
      );
      assert.deepEqual(data.candles, [], `alpha_amount=${String(alpha)}`);
    }
  });

  test("skips a row with a non-finite amount_tao (NaN, Infinity, -Infinity)", () => {
    for (const tao of [NaN, Infinity, -Infinity, "not-a-number"]) {
      const data = buildSubnetOhlc([trade(STAKE_ADDED_KIND, 10, tao, BASE)], 7);
      assert.deepEqual(data.candles, [], `amount_tao=${String(tao)}`);
    }
  });

  test("skips a row with a null or blank alpha_amount (coerces to 0, fails the >0 guard)", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, null, 10, BASE),
      trade(STAKE_ADDED_KIND, "", 10, BASE + 60_000),
      trade(STAKE_ADDED_KIND, "   ", 10, BASE + 120_000),
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
  });

  test("a null or blank amount_tao coerces to 0 (finite) and is NOT skipped -- only non-finite amount_tao is guarded", () => {
    const rows = [trade(STAKE_ADDED_KIND, 10, null, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].open, 0); // price = 0 / 10 = 0, not skipped, not NaN
    assert.equal(data.candles[0].volume_tao, 0);
  });

  test("skips a row with a non-finite or missing observed_at", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 10, NaN),
      trade(STAKE_ADDED_KIND, 10, 10, undefined),
      trade(STAKE_ADDED_KIND, 10, 10, "not-a-timestamp"),
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
  });

  test("never produces Infinity or NaN in candle output even when every row is malformed", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 0, Infinity, BASE),
      trade(STAKE_ADDED_KIND, NaN, NaN, BASE + 60_000),
      trade(STAKE_ADDED_KIND, -1, -1, BASE + 120_000),
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
    for (const value of JSON.stringify(data).match(/-?\d+\.?\d*/g) ?? []) {
      assert.ok(
        Number.isFinite(Number(value)),
        `unexpected non-finite ${value}`,
      );
    }
  });

  test("ignores rows whose event_kind is neither StakeAdded nor StakeRemoved", () => {
    const rows = [trade("WeightsSet", 10, 20, BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.deepEqual(data.candles, []);
  });

  test("a malformed row does not drop the rest of the batch -- valid rows still produce candles", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 0, 10, BASE), // malformed: alpha 0
      trade(STAKE_ADDED_KIND, 10, 20, BASE + 60_000), // valid: price 2
    ];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].open, 2);
    assert.equal(data.candles[0].event_count, 1);
  });

  test("coerces numeric-string amount cells (Postgres NUMERIC columns arrive as strings)", () => {
    const rows = [trade(STAKE_ADDED_KIND, "10", "25", BASE)];
    const data = buildSubnetOhlc(rows, 7);
    assert.equal(data.candles[0].open, 2.5);
    assert.equal(data.candles[0].volume_alpha, 10);
    assert.equal(data.candles[0].volume_tao, 25);
  });
});

describe("buildSubnetOhlc — defensive sort of unsorted input", () => {
  test("sorts rows by observed_at ascending before bucketing, regardless of input order", () => {
    // Anchor to a day boundary (not the hour-aligned BASE) so all three
    // 1-hour-apart trades stay inside the same UTC calendar day -- BASE
    // itself can sit within 2h of midnight depending on the epoch chosen,
    // which would otherwise split this across two 1d buckets.
    const dayStart = Math.floor(BASE / DAY_MS) * DAY_MS + HOUR_MS;
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 40, dayStart + 2 * HOUR_MS), // price 4, latest
      trade(STAKE_ADDED_KIND, 10, 10, dayStart), // price 1, earliest (should be open)
      trade(STAKE_ADDED_KIND, 10, 20, dayStart + HOUR_MS), // price 2, middle
    ];
    // Force all three into the SAME bucket by using a 1d interval so ordering
    // (not bucketing) is what's under test.
    const data = buildSubnetOhlc(rows, 7, { interval: "1d" });
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].open, 1); // earliest trade despite being listed 2nd
    assert.equal(data.candles[0].close, 4); // latest trade despite being listed 1st
  });

  test("does not mutate the caller's input array", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 10, 20, BASE + HOUR_MS),
      trade(STAKE_ADDED_KIND, 10, 10, BASE),
    ];
    const snapshot = JSON.stringify(rows);
    buildSubnetOhlc(rows, 7);
    assert.equal(JSON.stringify(rows), snapshot);
  });
});

describe("buildSubnetOhlc — rao-precision rounding", () => {
  test("rounds every numeric candle field to rao precision (no IEEE-754 dust)", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 0.1 + 0.2, 0.1 + 0.2, BASE), // 0.30000000000000004
    ];
    const data = buildSubnetOhlc(rows, 7);
    const [candle] = data.candles;
    assert.equal(candle.volume_alpha, 0.3);
    assert.equal(candle.volume_tao, 0.3);
    assert.equal(candle.open, 1); // (0.1+0.2)/(0.1+0.2) = 1 exactly
  });
});

describe("buildSubnetOhlc — MAX_CANDLES cap", () => {
  test("MAX_CANDLES is a sane positive integer", () => {
    assert.ok(Number.isInteger(MAX_CANDLES));
    assert.ok(MAX_CANDLES > 0);
  });

  test("a series longer than MAX_CANDLES is capped to MAX_CANDLES candles", () => {
    const rows = [];
    const total = MAX_CANDLES + 50;
    for (let i = 0; i < total; i += 1) {
      rows.push(trade(STAKE_ADDED_KIND, 1, i + 1, BASE + i * HOUR_MS));
    }
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    assert.equal(data.candles.length, MAX_CANDLES);
  });

  test("when capped, the MOST RECENT candles are kept (the oldest tail is dropped)", () => {
    const rows = [];
    const total = MAX_CANDLES + 10;
    for (let i = 0; i < total; i += 1) {
      rows.push(trade(STAKE_ADDED_KIND, 1, i + 1, BASE + i * HOUR_MS));
    }
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    // The oldest 10 buckets (indices 0..9, at BASE..BASE+9h) should be gone;
    // the earliest surviving candle should be bucket index 10.
    assert.equal(data.candles[0].bucket_start, BASE + 10 * HOUR_MS);
    // The newest bucket (index total-1) should still be present as the last candle.
    assert.equal(
      data.candles[data.candles.length - 1].bucket_start,
      BASE + (total - 1) * HOUR_MS,
    );
  });

  test("a series shorter than MAX_CANDLES is not truncated", () => {
    const rows = [
      trade(STAKE_ADDED_KIND, 1, 1, BASE),
      trade(STAKE_ADDED_KIND, 1, 2, BASE + HOUR_MS),
    ];
    const data = buildSubnetOhlc(rows, 7, { interval: "1h" });
    assert.equal(data.candles.length, 2);
  });
});

describe("buildSubnetOhlc — output shape", () => {
  test("top-level shape carries schema_version, netuid, interval, candles, root_excluded", () => {
    const data = buildSubnetOhlc([trade(STAKE_ADDED_KIND, 1, 1, BASE)], 12, {
      interval: "1d",
    });
    assert.deepEqual(Object.keys(data).sort(), [
      "candles",
      "interval",
      "netuid",
      "root_excluded",
      "schema_version",
    ]);
    assert.equal(data.netuid, 12);
    assert.equal(data.interval, "1d");
  });

  test("each candle carries exactly the documented fields", () => {
    const data = buildSubnetOhlc([trade(STAKE_ADDED_KIND, 1, 1, BASE)], 7);
    assert.deepEqual(Object.keys(data.candles[0]).sort(), [
      "bucket_start",
      "bucket_start_iso",
      "close",
      "event_count",
      "high",
      "low",
      "open",
      "volume_alpha",
      "volume_tao",
    ]);
  });
});

// --- End-to-end: the Worker route (workers/api.mjs -> entities.mjs) ---------

const ctx = { waitUntil: (p) => p };

describe("GET /api/v1/subnets/{netuid}/ohlc via the Worker", () => {
  test("is schema-stable when the Postgres tier is unavailable (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.candles, []);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.interval, "1h");
  });

  test("root subnet (netuid 0) is schema-stable and root_excluded", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/0/ohlc"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.root_excluded, true);
    assert.deepEqual(body.data.candles, []);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?window=30d"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("an invalid ?interval= value is a 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?interval=5m"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("a valid ?interval=1d is accepted", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?interval=1d"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.interval, "1d");
  });

  test("an out-of-range ?days= value is a 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?days=9999"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("a non-numeric ?days= value is a 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?days=soon"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("a valid ?days= within range is accepted", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc?days=30"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
  });

  test("testnet has no variant (mainnet-only account_events tier)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/subnets/7/ohlc"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("flag=postgres routes through DATA_API and unwraps {data, generatedAt}", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              netuid: 7,
              interval: "1h",
              candles: [
                {
                  bucket_start: BASE,
                  bucket_start_iso: new Date(BASE).toISOString(),
                  open: 1,
                  high: 1,
                  low: 1,
                  close: 1,
                  volume_alpha: 5,
                  volume_tao: 5,
                  event_count: 1,
                },
              ],
              root_excluded: false,
            },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/ohlc"),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.candles.length, 1);
    assert.equal(body.data.candles[0].volume_alpha, 5);
    assert.equal(body.meta.generated_at, "2026-07-01T00:00:00.000Z");
  });
});
