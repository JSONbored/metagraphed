// The OHLC cold tier's specific properties: the bucketing that data-api does
// in a JS row loop happens in the ENGINE here (so the body is bounded by
// candle count, not by trade count), the candle itself still comes out of the
// one shared assembler, and anything the reader cannot read faithfully
// declines to the caller's schema-stable empty rather than serving a chart
// with an invented hole in it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetOhlcColdTier } from "../src/subnet-ohlc-cold-tier.ts";
import {
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVALS,
} from "../src/subnet-ohlc.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import type { Row } from "./row-type.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env;
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

function sqlFetch(rows: unknown[]) {
  const queries: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

function noFetch() {
  const calls: number[] = [];
  globalThis.fetch = (async () => {
    calls.push(1);
    throw new Error("the reader must decline before reaching the engine");
  }) as unknown as typeof fetch;
  return calls;
}

describe("loadSubnetOhlcColdTier", () => {
  test("bucket math, filters and the cap all live in the engine", async () => {
    const q = sqlFetch([bucketRow()]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 90,
    });
    const sql = q[0]!;
    assert.match(sql, /FROM chain\.account_events/);
    assert.match(sql, /WHERE netuid = 7 /);
    assert.match(
      sql,
      /event_kind = 'StakeAdded' OR event_kind = 'StakeRemoved'/,
    );
    // The guards buildSubnetOhlc applies per row, expressed as predicates.
    assert.match(sql, /alpha_amount > 0 AND amount_tao IS NOT NULL/);
    assert.match(sql, /amount_tao \/ alpha_amount AS price/);
    assert.match(
      sql,
      new RegExp(
        `CAST\\(FLOOR\\(observed_at / ${HOUR_MS}\\) AS BIGINT\\) \\* ${HOUR_MS}`,
      ),
    );
    // open/close via the real chain order, not an incidental sort tie.
    assert.match(
      sql,
      /ORDER BY observed_at ASC, block_number ASC, event_index ASC/,
    );
    assert.match(
      sql,
      /ORDER BY observed_at DESC, block_number DESC, event_index DESC/,
    );
    assert.match(sql, /GROUP BY bucket_start/);
    // Newest-first + the assembler's own cap, applied before the wire.
    assert.match(
      sql,
      new RegExp(`ORDER BY bucket_start DESC LIMIT ${MAX_CANDLES}`),
    );

    const data = result!.data as Row;
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
      result!.generatedAt,
      new Date(BUCKET + 900_000).toISOString(),
      "generatedAt is the newest trade instant, as on the Postgres tier",
    );
  });

  test("?days= sets the cutoff and ?interval= sets the bucket width", async () => {
    const q = sqlFetch([]);
    const before = Date.now();
    await loadSubnetOhlcColdTier(TOKEN, 12, { interval: "1d", days: 7 });
    const cutoff = Number(/observed_at >= (\d+)/.exec(q[0]!)![1]);
    assert.ok(
      cutoff >= before - 7 * DAY_MS && cutoff <= Date.now() - 7 * DAY_MS,
      "the window is anchored to request time, exactly as data-api anchors it",
    );
    assert.match(
      q[0]!,
      new RegExp(
        `FLOOR\\(observed_at / ${DAY_MS}\\) AS BIGINT\\) \\* ${DAY_MS}`,
      ),
    );
  });

  test("no trades in the window is an empty series, not a decline", async () => {
    sqlFetch([]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 1,
    });
    assert.deepEqual((result!.data as Row).candles, []);
    assert.equal(result!.generatedAt, null);
  });

  test("declines an unusable netuid, and root, without touching the engine", async () => {
    const calls = noFetch();
    for (const netuid of [null, "abc", -1, 1.5, 0]) {
      assert.equal(
        await loadSubnetOhlcColdTier(TOKEN, netuid, {
          interval: "1h",
          days: 1,
        }),
        null,
        `netuid ${String(netuid)} must decline`,
      );
    }
    assert.deepEqual(calls, [], "no query is issued for a declined read");
  });

  test("declines a param the caller should already have rejected", async () => {
    const calls = noFetch();
    // interval: absent, non-string, and a well-formed unknown value.
    for (const interval of [undefined, 5, "5m"]) {
      assert.equal(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval, days: 1 }),
        null,
        `interval ${String(interval)} must decline`,
      );
    }
    // days: absent, below the floor, above the ceiling.
    for (const days of [undefined, 0, MAX_OHLC_WINDOW_DAYS + 1]) {
      assert.equal(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days }),
        null,
        `days ${String(days)} must decline`,
      );
    }
    assert.deepEqual(calls, []);
  });

  test("a failed query declines, leaving the caller's empty in place", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 30 }),
      null,
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
      sqlFetch([bucketRow(), bucketRow({ [field]: "nope" })]);
      assert.equal(
        await loadSubnetOhlcColdTier(TOKEN, 7, { interval: "1h", days: 30 }),
        null,
        `an unreadable ${field} must decline`,
      );
    }
  });

  test("generatedAt takes the newest instant, ignoring cells that carry none", async () => {
    // Rows arrive newest-bucket-first; the max is still taken across all of
    // them rather than trusting the first, and a bucket with no readable
    // last_observed simply does not contribute one.
    sqlFetch([
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
    assert.equal(result!.generatedAt, new Date(BUCKET + 99).toISOString());
    assert.equal((result!.data as Row).candles.length, 6);
  });

  test("no readable instant anywhere yields a null generatedAt, not an epoch", async () => {
    sqlFetch([bucketRow({ last_observed: null })]);
    const result = await loadSubnetOhlcColdTier(TOKEN, 7, {
      interval: "1h",
      days: 30,
    });
    assert.equal(result!.generatedAt, null);
    assert.equal((result!.data as Row).candles.length, 1);
  });
});
