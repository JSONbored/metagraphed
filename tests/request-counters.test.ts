import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createRequestCounter,
  withRequestCounters,
} from "../src/request-counters.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { recordIndexedHistoryFailure } from "../src/indexed-history-status.ts";
import { offsetBeyondEmulationCap } from "../src/cold-tier-offset.ts";
import { unmeasured, DEGRADED_HEADER } from "../workers/edge-cache.ts";
import { withResponseTiming } from "../workers/request-lifecycle.ts";
import {
  currentStoreReadFailureGeneration,
  storeAll,
} from "../src/analytics-live.ts";

test("request counters isolate overlapping and nested scopes, including failures", async () => {
  const counter = createRequestCounter("test/request-counters.ts");
  assert.equal(counter.current(), 0);
  counter.increment();
  assert.equal(counter.current(), 1);
  await Promise.all([
    withRequestCounters(async () => {
      assert.equal(counter.current(), 0);
      counter.increment();
      await Promise.resolve();
      assert.equal(counter.current(), 1);
      await assert.rejects(
        withRequestCounters(async () => {
          assert.equal(counter.current(), 0);
          counter.increment();
          counter.increment();
          assert.equal(counter.current(), 2);
          throw new Error("isolated failure");
        }),
        /isolated failure/,
      );
      assert.equal(counter.current(), 1);
    }),
    withRequestCounters(async () => {
      await Promise.resolve();
      assert.equal(counter.current(), 0);
    }),
  ]);
  assert.equal(counter.current(), 1);
  resetModuleState();
  assert.equal(counter.current(), 0);
});

for (const [name, fail] of [
  ["history failure", () => recordIndexedHistoryFailure()],
  ["unmeasured response", () => unmeasured(null)],
  ["offset decline", () => offsetBeyondEmulationCap(251)],
] as const) {
  test(`${name} labels only its own concurrent HTTP response`, async () => {
    const [healthy, degraded] = await Promise.all([
      withResponseTiming(async () => {
        await Promise.resolve();
        return new Response("measured data");
      }),
      withResponseTiming(async () => {
        fail();
        return new Response("unmeasured data");
      }),
    ]);
    assert.equal(healthy.headers.get(DEGRADED_HEADER), null);
    assert.equal(degraded.headers.get(DEGRADED_HEADER), "tier_unavailable");
  });
}

test("a failed observation query cannot suppress another reader's cache", async () => {
  const [healthy, failed] = await Promise.all([
    withRequestCounters(async () => {
      const before = currentStoreReadFailureGeneration();
      await Promise.resolve();
      await Promise.resolve();
      return currentStoreReadFailureGeneration() !== before;
    }),
    withRequestCounters(async () => {
      const before = currentStoreReadFailureGeneration();
      await storeAll(
        {
          query: async () => {
            throw new Error("D1 read failed");
          },
        },
        "SELECT 1",
        [],
      );
      return currentStoreReadFailureGeneration() !== before;
    }),
  ]);
  assert.equal(healthy, false);
  assert.equal(failed, true);
});
