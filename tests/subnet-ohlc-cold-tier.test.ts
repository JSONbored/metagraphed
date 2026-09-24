// The OHLC cold tier's specific properties: the bucketing that data-api does
// in a JS row loop happens in the ENGINE here (so the body is bounded by
// candle count, not by trade count), the candle itself still comes out of the
// one shared assembler, and anything the reader cannot read faithfully
// declines to the caller's schema-stable empty rather than serving a chart
// with an invented hole in it.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import * as indexed from "../src/subnet-indexed-aggregates.ts";
import { loadSubnetOhlcColdTier } from "../src/subnet-ohlc-cold-tier.ts";
import type { SubnetOhlcColdTierResult } from "../src/subnet-ohlc-cold-tier.ts";
import {
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVALS,
} from "../src/subnet-ohlc.ts";

import type { Row } from "./row-type.ts";

const TOKEN = { NATIVE_PROJECTIONS: "enabled" };
const reader = vi.spyOn(indexed, "loadIndexedSubnetOhlcRows");
beforeEach(() => {
  reader.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP is forbidden");
    }),
  );
});
const HOUR_MS = OHLC_INTERVALS["1h"];
const DAY_MS = OHLC_INTERVALS["1d"];
const BUCKET = 1_783_600_000_000 - (1_783_600_000_000 % HOUR_MS);

/** One row in the engine's per-bucket GROUP BY output. */
function bucketRow(overrides: Record<string, unknown> = {}) {
  return {
    bucket_start: BUCKET,
    open_price: 0.5,
    close_price: 0.7,
    high_price: 0.9,
    low_price: 0.4,
    volume_alpha: 120,
    volume_tao: 66,
    event_count: 4,
    last_observed: BUCKET + 900_000,
    ...overrides,
  };
}

function nativeRows(rows: Record<string, unknown>[]) {
  reader.mockReset().mockResolvedValue(rows);
  return reader.mock.calls;
}

/**
 * The answer, or a failed assertion naming what came back instead.
 *
 * A narrowing helper rather than a cast: `kind` is what separates a series
 * from a decline, so a test that reached for `.data` without checking it would
 * be asserting against a shape the reader never promised.
 */
function answerOf(result: SubnetOhlcColdTierResult) {
  assert.equal(result.kind, "answer", `expected an answer, got ${result.kind}`);
  return result as Extract<SubnetOhlcColdTierResult, { kind: "answer" }>;
}

function noFetch() {
  reader.mockClear();
  return reader.mock.calls;
}

describe("loadSubnetOhlcColdTier", () => {
  test("passes the exact window and bucket width to the qualified native aggregate", async () => {
    const q = nativeRows([bucketRow()]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 90,
    });
    assert.equal(q.length, 1);
    assert.equal(q[0][1], 7);
    assert.equal(q[0][3], HOUR_MS);
    assert.ok(Math.abs(q[0][2] - (Date.now() - 90 * DAY_MS)) < 1000);

    const data = answerOf(result).data as Row;
    assert.equal(data.netuid, 7);
    assert.equal(data.interval, "1h");
    assert.equal(data.root_excluded, false);
    assert.deepEqual(data.candles, [
      {
        bucket_start: BUCKET,
        bucket_start_iso: new Date(BUCKET).toISOString(),
        open: 0.5,
        high: 0.9,
        low: 0.4,
        close: 0.7,
        volume_alpha: 120,
        volume_tao: 66,
        event_count: 4,
      },
    ]);
    assert.equal(
      answerOf(result).generatedAt,
      new Date(BUCKET + 900_000).toISOString(),
      "generatedAt is the newest trade instant, as on the Postgres tier",
    );
  });

  test("?days= sets the cutoff and ?interval= sets the bucket width", async () => {
    const q = nativeRows([]);
    const before = Date.now();
    await loadSubnetOhlcColdTier(TOKEN, 12, { interval: "1d", days: 7 });
    const cutoff = q[0][2];
    assert.ok(
      cutoff >= before - 7 * DAY_MS && cutoff <= Date.now() - 7 * DAY_MS,
    );
    assert.equal(q[0][1], 12);
    assert.equal(q[0][3], DAY_MS);
  });

  test("no trades in the window is an empty series, not a decline", async () => {
    nativeRows([]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 1,
    });
    assert.deepEqual((answerOf(result).data as Row).candles, []);
    assert.equal(answerOf(result).generatedAt, null);
  });

  test("declines an unusable netuid, and root, without touching the engine", async () => {
    const calls = noFetch();
    for (const netuid of [null, "abc", -1, 1.5, 0]) {
      assert.deepEqual(
        await loadSubnetOhlcColdTier(TOKEN, netuid, {
          interval: "1h",
          days: 1,
        }),
        { kind: "miss" },
        `netuid ${String(netuid)} must miss`,
      );
    }
    assert.deepEqual(calls, [], "no query is issued for a declined read");
  });

  test("declines a param the caller should already have rejected", async () => {
    const calls = noFetch();
    // interval: absent, non-string, and a well-formed unknown value.
    for (const interval of [undefined, 5, "5m"]) {
      assert.deepEqual(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval, days: 1 }),
        { kind: "miss" },
        `interval ${String(interval)} must miss`,
      );
    }
    // days: absent, below the floor, above the ceiling.
    for (const days of [undefined, 0, MAX_OHLC_WINDOW_DAYS + 1]) {
      assert.deepEqual(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days }),
        { kind: "miss" },
        `days ${String(days)} must miss`,
      );
    }
    assert.deepEqual(calls, []);
  });

  // THE DISTINCTION THIS TIER USED TO COLLAPSE (#10312). A configured lakehouse
  // that could not answer is a GAP: the rows exist in that deployment, so an
  // empty series is a lie about them. It used to return the same bare `null` as
  // "no lakehouse here", and every caller turned that into `candle_count: 0`.
  test("a failed query on a CONFIGURED lakehouse is a gap, not an empty", async () => {
    reader.mockResolvedValue(null);
    assert.deepEqual(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 30 }),
      { kind: "gap" },
    );
  });

  // The other half, and why `gap` cannot simply be the default: a self-hoster
  // or a CI run has no lakehouse at all, there is no chain history to read, and
  // the caller's empty series is the correct answer -- exactly as
  // account-summary-card.ts reserves `miss` for the same deployment.
  test("the same failure with NO lakehouse configured is a miss", async () => {
    reader.mockResolvedValue(undefined);
    assert.deepEqual(
      await loadSubnetOhlcColdTier({} as unknown as Env, 7, {
        interval: "1h",
        days: 30,
      }),
      { kind: "miss" },
    );
  });

  // The WHERE clause already dropped every malformed TRADE, so an unreadable
  // BUCKET means the engine answered something this reader does not
  // understand. Skipping it would render as a quiet hour on a price chart --
  // indistinguishable from real market data, and wrong.
  test("an unreadable bucket cell declines the whole series", async () => {
    for (const field of [
      "bucket_start",
      "open_price",
      "close_price",
      "high_price",
      "low_price",
      "volume_alpha",
      "volume_tao",
      "event_count",
    ]) {
      nativeRows([bucketRow(), bucketRow({ [field]: "nope" })]);
      assert.deepEqual(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 30 }),
        { kind: "gap" },
        `an unreadable ${field} must decline`,
      );
    }
  });

  test("generatedAt takes the newest instant, ignoring cells that carry none", async () => {
    // Rows arrive newest-bucket-first; the max is still taken across all of
    // them rather than trusting the first, and a bucket with no readable
    // last_observed simply does not contribute one.
    nativeRows([
      bucketRow({ bucket_start: BUCKET, last_observed: BUCKET + 10 }),
      bucketRow({ bucket_start: BUCKET - HOUR_MS, last_observed: BUCKET + 99 }),
      bucketRow({ bucket_start: BUCKET - 2 * HOUR_MS, last_observed: BUCKET }),
      bucketRow({ bucket_start: BUCKET - 3 * HOUR_MS, last_observed: 0 }),
      bucketRow({ bucket_start: BUCKET - 4 * HOUR_MS, last_observed: null }),
      bucketRow({
        bucket_start: BUCKET - 5 * HOUR_MS,
        last_observed: undefined,
      }),
    ]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 30,
    });
    assert.equal(
      answerOf(result).generatedAt,
      new Date(BUCKET + 99).toISOString(),
    );
    assert.equal((answerOf(result).data as Row).candles.length, 6);
  });

  test("no readable instant anywhere yields a null generatedAt, not an epoch", async () => {
    nativeRows([bucketRow({ last_observed: null })]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 30,
    });
    assert.equal(answerOf(result).generatedAt, null);
    assert.equal((answerOf(result).data as Row).candles.length, 1);
  });
  // ## The window count that was reporting the cap (#10312)
  //
  // Measured against the live lakehouse 2026-08-16: SN64 answered
  // `candle_count: 2000` at ?days=90 AND at ?days=365. Two windows of
  // different widths cannot hold the same number of buckets -- that 2000 was
  // MAX_CANDLES showing through a field documented as the window's total.
  test("reading CAP+1 rows marks the window truncated and still pages at CAP", async () => {
    const rows = Array.from({ length: MAX_CANDLES + 1 }, (_, i) =>
      bucketRow({ bucket_start: BUCKET - i * HOUR_MS }),
    );
    nativeRows(rows);
    const data = answerOf(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 365 }),
    ).data as Row;
    assert.equal(data.window_truncated, true);
    // The surplus row is DROPPED, so the published page is exactly the cap --
    // the over-fetch buys the signal without widening the response.
    assert.equal(data.candle_count, MAX_CANDLES);
    assert.equal((data.candles as unknown[]).length, MAX_CANDLES);
  });

  test("exactly CAP rows is NOT truncated -- the boundary the extra row exists to draw", async () => {
    // Non-vacuity, and the whole reason for CAP+1 rather than CAP: a window
    // holding precisely MAX_CANDLES buckets is complete, and reporting it as
    // truncated would be the same overstatement in the other direction.
    const rows = Array.from({ length: MAX_CANDLES }, (_, i) =>
      bucketRow({ bucket_start: BUCKET - i * HOUR_MS }),
    );
    nativeRows(rows);
    const data = answerOf(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 365 }),
    ).data as Row;
    assert.equal(data.window_truncated, false);
    assert.equal(data.candle_count, MAX_CANDLES);
  });

  test("an ordinary window reports window_truncated false", async () => {
    nativeRows([bucketRow()]);
    const data = answerOf(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 30 }),
    ).data as Row;
    assert.equal(data.window_truncated, false);
    assert.equal(data.candle_count, 1);
  });

  test("the dropped surplus row is the OLDEST, so the recent end survives", async () => {
    // Rows arrive newest-first, so slicing from the front keeps the recent end
    // -- the same end the assembler's own cap keeps. Slicing the wrong side
    // would silently hand back the oldest candles of the window.
    const rows = Array.from({ length: MAX_CANDLES + 1 }, (_, i) =>
      bucketRow({ bucket_start: BUCKET - i * HOUR_MS }),
    );
    nativeRows(rows);
    const data = answerOf(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 365 }),
    ).data as Row;
    const candles = data.candles as { bucket_start: number }[];
    assert.equal(
      candles[candles.length - 1]!.bucket_start,
      BUCKET,
      "the newest bucket must be present",
    );
    assert.equal(
      candles.some((c) => c.bucket_start === BUCKET - MAX_CANDLES * HOUR_MS),
      false,
      "the oldest, surplus bucket must be the one dropped",
    );
  });
});
