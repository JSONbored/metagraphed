import assert from "node:assert/strict";
import { test, vi } from "vitest";
import * as existing from "../src/analytics-live.ts";
import { storeAll, currentStoreReadFailureGeneration, type ObservationsReadDb } from "../src/analytics-store-read.ts";
import { COMPARE_VALIDATORS_MAX, parseCompareHotkeys, parseCompareHotkeyList } from "../src/compare-validator-input.ts";
import { loadSubnetUptime } from "../src/uptime-read.ts";
import { withRequestCounters } from "../src/request-counters.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { MAX_UPTIME_ROWS } from "../workers/config.ts";

const keys = Array.from({ length: 17 }, (_, n) => encodeAccountId32(new Uint8Array(32).fill(n))!);

test("old analytics exports retain the same leaf functions and counter owner", () => {
  assert.equal(existing.storeAll, storeAll);
  assert.equal(existing.currentStoreReadFailureGeneration, currentStoreReadFailureGeneration);
  assert.equal(existing.parseCompareHotkeys, parseCompareHotkeys);
  assert.equal(existing.parseCompareHotkeyList, parseCompareHotkeyList);
  assert.equal(existing.loadSubnetUptime, loadSubnetUptime);
  assert.equal(existing.COMPARE_VALIDATORS_MAX, COMPARE_VALIDATORS_MAX);
});

test("comparison input keeps deduplication, raw CSV limits and checksum-qualified array limits", () => {
  assert.equal(COMPARE_VALIDATORS_MAX, 16);
  for (const value of [null, undefined, 1, "", "I".repeat(48), keys.join(",")])
    assert.equal(parseCompareHotkeys(value), null);
  assert.deepEqual(parseCompareHotkeys(`${keys[0]},${keys[0]},${keys[1]}`), keys.slice(0, 2));
  assert.deepEqual(parseCompareHotkeys(keys.slice(0, 16).join(",")), keys.slice(0, 16));
  for (const value of [null, [], [1], ["not-an-address"], keys])
    assert.equal(parseCompareHotkeyList(value), null);
  assert.deepEqual(parseCompareHotkeyList([keys[0], keys[0], keys[1]]), keys.slice(0, 2));
  assert.deepEqual(parseCompareHotkeyList(keys.slice(0, 16)), keys.slice(0, 16));
});

test("bounded store reads retain exact SQL/rows and isolate failure generations per response", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await Promise.all([
      withRequestCounters(async () => {
        assert.equal(currentStoreReadFailureGeneration(), 0);
        for (const db of [undefined, null, {} as ObservationsReadDb])
          assert.deepEqual(await storeAll(db, "SELECT 1", []), []);
        const rows = [{ id: 1 }];
        const query = vi.fn(async () => rows);
        assert.equal(await storeAll({ query } as ObservationsReadDb, "SELECT id WHERE id=?", [1]), rows);
        assert.deepEqual(query.mock.calls, [["SELECT id WHERE id=?", [1]]]);
        for (const error of [new Error("fixture unavailable"), null]) {
          assert.deepEqual(await existing.storeAll({ query: async () => { throw error; } }, "SELECT 1", []), []);
        }
        assert.equal(existing.currentStoreReadFailureGeneration(), 2);
      }),
      withRequestCounters(async () => {
        await Promise.resolve();
        assert.equal(currentStoreReadFailureGeneration(), 0);
        assert.deepEqual(await storeAll({ query: async () => [] }, "SELECT 1", []), []);
        assert.equal(existing.currentStoreReadFailureGeneration(), 0);
      }),
    ]);
  } finally { log.mockRestore(); }
});

test("uptime leaf keeps window fallback, bounded SQL, sample floors and empty response shape", async () => {
  const empty = await loadSubnetUptime(8) as { surfaces: unknown[] };
  assert.deepEqual(empty.surfaces, []);
  for (const minSamples of [null, -1, 1.5, 0, 2]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const db: ObservationsReadDb = { query: async (sql, values) => { calls.push({ sql, values: values ?? [] }); return []; } };
    const data = await loadSubnetUptime(8, { window: "invalid", minSamples, now: "2026-10-16T00:00:00Z", db }) as { window: string; surfaces: unknown[] };
    assert.equal(data.window, "90d");
    assert.deepEqual(data.surfaces, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values.at(-1), MAX_UPTIME_ROWS);
    assert.equal(calls[0].values[0], 8);
    assert.equal(calls[0].sql.includes("HAVING SUM(samples) >= ?"), minSamples === 0 || minSamples === 2);
  }
});
