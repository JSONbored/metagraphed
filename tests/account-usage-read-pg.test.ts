import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgAccountUsageReaders } from "../src/account-usage-read-pg.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

function fixture(rows: object[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(callback, options) {
      assert.deepEqual(options, { isolation: "read committed" });
      return callback({
        async query<Row>(text: string, values: unknown[] = []) {
          queries.push({ text, values });
          return rows as Row[];
        },
        async first() {
          return null;
        },
        async run() {
          return { changes: 0 };
        },
      });
    },
  };
  return { queries, readers: createPgAccountUsageReaders(runtime) };
}

test("account and anomaly reads keep source row ordering and wire numbers", async () => {
  const f = fixture([
    {
      day: "2026-11-04",
      route: "/z",
      requests: "9007199254740993",
      rejected: "Infinity",
      account: "42",
    },
  ]);
  assert.deepEqual(await f.readers.accountRows(0.1, "2026-11-01"), [
    {
      day: "2026-11-04",
      route: "/z",
      request_count: 9007199254740992,
      rejected_count: null,
    },
  ]);
  assert.match(f.queries[0].text, /ORDER BY day DESC,source_row_id/);
  assert.equal(
    f.queries[0].values[0],
    "0.1000000000000000055511151231257827021181583404541015625",
  );
  assert.deepEqual(await f.readers.anomalyRows("2026-11-01"), [
    {
      account_id: 42,
      day: "2026-11-04",
      route: "/z",
      request_count: 9007199254740992,
    },
  ]);
  assert.match(f.queries[1].text, /ORDER BY account_id,day,source_row_id/);
});

test("rollup sorting compares exact values before the JSON number boundary", async () => {
  const f = fixture([
    {
      route_family: "a",
      cost_shape: "small",
      requests: "9007199254740992",
      keyed: "0",
    },
    {
      route_family: "b",
      cost_shape: "great",
      requests: "9007199254740993",
      keyed: "0",
    },
    { route_family: "c", cost_shape: "inf", requests: "Infinity", keyed: "0" },
    {
      route_family: "d",
      cost_shape: "null",
      requests: "Infinity",
      keyed: "Infinity",
    },
    {
      route_family: "d",
      cost_shape: "null",
      requests: "-Infinity",
      keyed: "-Infinity",
    },
    { route_family: "e", cost_shape: "tie", requests: "1", keyed: "0" },
    { route_family: "f", cost_shape: "tie", requests: "1", keyed: "0" },
    { route_family: "g", cost_shape: "null", requests: "Infinity", keyed: "0" },
    {
      route_family: "g",
      cost_shape: "null",
      requests: "-Infinity",
      keyed: "0",
    },
  ]);
  const rows = await f.readers.rollupRows("2026-11-01", "family");
  assert.deepEqual(
    rows.map((row) => row.route_family),
    ["c", "b", "a", "e", "f", "d", "g"],
  );
  assert.equal(rows[3].request_count, 1);
  assert.equal(rows[5].request_count, null);
  assert.equal(rows[5].keyed_count, null);
  assert.match(f.queries[0].text, /ORDER BY route_family,cost_shape,day DESC/);
});

test("shape grouping retains source order and only family output is capped", async () => {
  const f = fixture([
    {
      route_family: "a",
      cost_shape: "one",
      requests: "1",
      keyed: "10000000000000000",
    },
    { route_family: "b", cost_shape: "one", requests: "1", keyed: "0.1" },
    {
      route_family: "c",
      cost_shape: "one",
      requests: "1",
      keyed: "-10000000000000000",
    },
  ]);
  assert.deepEqual(await f.readers.rollupRows("2026-11-01", "shape"), [
    { cost_shape: "one", request_count: 3, keyed_count: 0.1 },
  ]);
  assert.match(f.queries[0].text, /ORDER BY cost_shape,day DESC,source_row_id/);
  const many = fixture(
    Array.from({ length: 501 }, (_, index) => ({
      route_family: `f${index}`,
      cost_shape: `s${index}`,
      requests: "1",
      keyed: "0",
    })),
  );
  assert.equal(
    (await many.readers.rollupRows("2026-11-01", "family")).length,
    500,
  );
  assert.equal(
    (await many.readers.rollupRows("2026-11-01", "shape")).length,
    501,
  );
});
