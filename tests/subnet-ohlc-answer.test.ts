// The one place REST, MCP and GraphQL agree about a failed OHLC read (#10312).
//
// Each surface used to end its read with `?.data ?? buildSubnetOhlc([], ...)`,
// so a lakehouse that timed out published `candles: [], candle_count: 0` --
// byte-identical to a subnet that has genuinely never traded. The existing
// `degraded-answer-is-labelled` sweep did not catch it because that sweep
// asserts the `x-metagraph-degraded` HEADER, and the header was set correctly
// the whole time. The BODY was the lie, and the body is what every consumer
// reads.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { answerSubnetOhlc } from "../src/subnet-ohlc-answer.ts";
import { MAX_CANDLES, OHLC_DEGRADED_UNAVAILABLE } from "../src/subnet-ohlc.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import type { Row } from "./row-type.ts";

/** A configured lakehouse: the deployment where the rows exist. */
const CONFIGURED = { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env;
/** A self-hoster or CI: no lakehouse, so no rows to be wrong about. */
const UNCONFIGURED = {} as unknown as Env;

const HOUR_MS = 3_600_000;
const BUCKET = 1_783_600_000_000 - (1_783_600_000_000 % HOUR_MS);

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

function respondWith(rows: unknown[]) {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function refuse() {
  globalThis.fetch = (async () => {
    throw new Error("lakehouse down");
  }) as unknown as typeof fetch;
}

const QUERY = { interval: "1h", days: 90, limit: MAX_CANDLES };

describe("a failed read and an idle subnet stop looking identical", () => {
  test("a configured lakehouse that fails publishes a DECLINE", async () => {
    refuse();
    const { data, generatedAt } = await answerSubnetOhlc(CONFIGURED, 64, QUERY);
    assert.deepEqual(data.degraded, { reason: OHLC_DEGRADED_UNAVAILABLE });
    // NULL, not 0. Nothing is known about how many candles the window holds,
    // and a 0 asserts the subnet has never traded.
    assert.equal(data.candle_count, null);
    assert.deepEqual(data.candles, []);
    // No instant, because nothing was read. A timestamp here would date an
    // empty series to now.
    assert.equal(generatedAt, null);
  });

  test("a subnet that genuinely did not trade publishes a MEASUREMENT", async () => {
    // The contrast that gives the marker meaning. Same empty array, same
    // status, and the ONLY difference is the one a caller can act on.
    respondWith([]);
    const { data } = await answerSubnetOhlc(CONFIGURED, 64, QUERY);
    assert.equal("degraded" in data, false);
    assert.equal(data.candle_count, 0);
    assert.deepEqual(data.candles, []);
  });

  test("no lakehouse at all is a measurement, not a decline", async () => {
    // The reason `gap` cannot just be the default. A self-hoster has no chain
    // history, so the empty series is correct and marking it degraded would
    // report a fault that does not exist in that deployment.
    refuse();
    const { data } = await answerSubnetOhlc(UNCONFIGURED, 64, QUERY);
    assert.equal("degraded" in data, false);
    assert.equal(data.candle_count, 0);
  });

  test("root is excluded, never degraded", async () => {
    // Root has no AMM, so its zero is measured. It must not be reported as a
    // failed read just because it also yields no candles.
    refuse();
    const { data } = await answerSubnetOhlc(CONFIGURED, 0, QUERY);
    assert.equal(data.root_excluded, true);
    assert.equal(data.candle_count, 0);
    assert.equal("degraded" in data, false);
  });

  test("a real series comes back untouched, so this is not just declining", async () => {
    // Non-vacuity: an answer function that declined everything would satisfy
    // every assertion above.
    respondWith([bucketRow()]);
    const { data, generatedAt } = await answerSubnetOhlc(CONFIGURED, 64, QUERY);
    assert.equal("degraded" in data, false);
    assert.equal(data.candle_count, 1);
    assert.equal((data.candles as Row[]).length, 1);
    assert.equal(data.window_truncated, false);
    assert.equal(generatedAt, new Date(BUCKET + 900_000).toISOString());
  });

  test("the truncation flag survives the seam", async () => {
    // The cold tier decides it; this asserts the answer does not drop it on
    // the way to the three surfaces.
    respondWith(
      Array.from({ length: MAX_CANDLES + 1 }, (_, i) =>
        bucketRow({ bucket_start: BUCKET - i * HOUR_MS }),
      ),
    );
    const { data } = await answerSubnetOhlc(CONFIGURED, 64, QUERY);
    assert.equal(data.window_truncated, true);
    assert.equal(data.candle_count, MAX_CANDLES);
  });
});
