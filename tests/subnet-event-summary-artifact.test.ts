// The subnet-event-summary projection reader (#9146).
//
// This lane's artifact holds EVERY subnet's rows in one bucket per window, so
// the reader's job is the netuid filter. Returning another subnet's rows would
// be a plausible-looking wrong answer rather than an error, which is why that
// gets its own test.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUBNET_EVENT_SUMMARY_PROJECTION_KEY,
  loadSubnetEventSummaryKindRows,
} from "../src/subnet-event-summary-artifact.ts";

function kindRow(netuid: number, kind: string, count: number) {
  return {
    netuid,
    event_kind: kind,
    event_count: count,
    hotkey_count: 2,
    coldkey_count: 1,
    amount_tao: 0,
    alpha_amount: 0,
    first_block: 1,
    last_block: 2,
    first_observed_at: 1_785_700_000_000,
    last_observed_at: 1_785_708_000_000,
  };
}

const BODY = {
  schema_version: 1,
  generated_at: "2026-08-03T02:38:00.000Z",
  row_count: 3,
  windows: {
    "7d": {
      days: 7,
      rows: [
        kindRow(1, "StakeAdded", 10),
        kindRow(1, "WeightsSet", 7),
        kindRow(2, "StakeAdded", 99),
      ],
    },
    "30d": { days: 30, rows: [kindRow(1, "StakeAdded", 40)] },
    "90d": { days: 90, rows: [kindRow(1, "StakeAdded", 90)] },
  },
};

function envWith(body: unknown, opts: { throws?: boolean } = {}) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        get(key: string) {
          keys.push(key);
          if (opts.throws) return Promise.reject(new Error("r2 down"));
          if (key !== SUBNET_EVENT_SUMMARY_PROJECTION_KEY) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ json: () => Promise.resolve(body) });
        },
      },
    } as unknown as Env,
  };
}

describe("loadSubnetEventSummaryKindRows", () => {
  test("returns only the requested subnet's rows", async () => {
    // netuid 2 carries 99 events in the same window; leaking it would inflate
    // netuid 1's summary rather than fail.
    const { env, keys } = envWith(BODY);
    const rows = await loadSubnetEventSummaryKindRows(env, 1, "7d");
    assert.equal(rows!.length, 2);
    assert.ok(rows!.every((r) => r.netuid === 1));
    assert.deepEqual(rows!.map((r) => r.event_kind).sort(), [
      "StakeAdded",
      "WeightsSet",
    ]);
    assert.deepEqual(keys, [SUBNET_EVENT_SUMMARY_PROJECTION_KEY]);
  });

  test("serves each window from its own bucket", async () => {
    const { env } = envWith(BODY);
    for (const [w, count] of [
      ["7d", 10],
      ["30d", 40],
      ["90d", 90],
    ] as [string, number][]) {
      const rows = await loadSubnetEventSummaryKindRows(env, 1, w);
      assert.equal(rows![0].event_count, count, `window ${w}`);
    }
  });

  test("defaults to the route's default window", async () => {
    const { env } = envWith(BODY);
    const rows = await loadSubnetEventSummaryKindRows(env, 1);
    assert.equal(rows![0].event_count, 40, "30d is the default");
  });

  test("a subnet with no rows in a covered window is an empty answer, not a decline", async () => {
    // The lane DID compute the window; nothing happened on that subnet.
    const { env } = envWith(BODY);
    const rows = await loadSubnetEventSummaryKindRows(env, 77, "7d");
    assert.deepEqual(rows, []);
  });

  test("declines a window the lane did not precompute", async () => {
    const { env } = envWith({
      schema_version: 1,
      windows: { "7d": BODY.windows["7d"] },
    });
    assert.equal(await loadSubnetEventSummaryKindRows(env, 1, "30d"), null);
  });

  test("declines a window outside the route's set", async () => {
    const { env } = envWith(BODY);
    assert.equal(await loadSubnetEventSummaryKindRows(env, 1, "1y"), null);
  });

  test.each([
    ["no binding", null],
    ["wrong schema_version", { schema_version: 2, windows: {} }],
    ["windows absent", { schema_version: 1 }],
    ["windows null", { schema_version: 1, windows: null }],
    ["rows not an array", { schema_version: 1, windows: { "7d": {} } }],
  ] as [string, unknown][])(
    "declines when the artifact is unusable: %s",
    async (_label, body) => {
      const env = body === null ? ({} as unknown as Env) : envWith(body).env;
      assert.equal(await loadSubnetEventSummaryKindRows(env, 1, "7d"), null);
    },
  );

  test("declines when the object is missing", async () => {
    const env = {
      METAGRAPH_ARCHIVE: { get: () => Promise.resolve(null) },
    } as unknown as Env;
    assert.equal(await loadSubnetEventSummaryKindRows(env, 1, "7d"), null);
  });

  test("declines rather than throwing when the store errors", async () => {
    const { env } = envWith(BODY, { throws: true });
    assert.equal(await loadSubnetEventSummaryKindRows(env, 1, "7d"), null);
  });

  test("declines on a null env", async () => {
    assert.equal(await loadSubnetEventSummaryKindRows(null, 1, "7d"), null);
  });
});
