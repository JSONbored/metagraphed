import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadRpcUsage } from "../src/rpc-usage-loader.ts";

// D1 fully eliminated (2026-07-17): loadRpcUsage no longer takes a `d1`
// argument and never queries rpc_proxy_events -- it always returns the
// schema-stable empty shape (formatRpcUsage with no totals/rows). Callers
// only reach this loader on a Postgres-tier miss.
describe("loadRpcUsage", () => {
  test("returns a cold-stable zeroed payload", async () => {
    const data = await loadRpcUsage({ window: "30d" });
    assert.equal(data.window, "30d");
    assert.equal(
      (data.summary as { total_requests: number }).total_requests,
      0,
    );
    assert.deepEqual(data.endpoints, []);
    assert.deepEqual(data.networks, []);
    assert.deepEqual(data.buckets, []);
    assert.equal(data.bucket_granularity, "6h");
  });

  test("falls back to 7d for an unknown window label", async () => {
    const data = await loadRpcUsage({ window: "bogus" });
    assert.equal(data.window, "7d");
    assert.equal(data.bucket_granularity, "1h");
  });
});
