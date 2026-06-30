import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadRpcUsage } from "../src/rpc-usage-loader.mjs";

describe("loadRpcUsage", () => {
  test("aggregates rpc_proxy_events rows into the usage payload", async () => {
    const now = 1_700_000_000_000;
    const d1 = async (sql) => {
      if (/COUNT\(\*\) AS total/.test(sql)) {
        return [
          {
            total: 100,
            ok_count: 90,
            failover_count: 5,
            cache_hits: 20,
            avg_latency_ms: 150,
          },
        ];
      }
      if (/ROW_NUMBER\(\) OVER/.test(sql)) {
        return [{ p50: 120, p95: 400 }];
      }
      if (/GROUP BY endpoint_id/.test(sql)) {
        return [
          {
            endpoint_id: "fx",
            provider: "onfinality",
            requests: 60,
            ok_count: 55,
            avg_latency_ms: 140,
          },
        ];
      }
      if (/GROUP BY network/.test(sql)) {
        return [{ network: "finney", requests: 100, ok_count: 90 }];
      }
      if (/GROUP BY ts/.test(sql)) {
        return [
          { ts: now - 3_600_000, requests: 10, errors: 1, avg_latency_ms: 100 },
        ];
      }
      return [];
    };
    const data = await loadRpcUsage(d1, {
      window: "7d",
      observedAt: "2026-06-30T00:00:00Z",
      now,
    });
    assert.equal(data.window, "7d");
    assert.equal(data.observed_at, "2026-06-30T00:00:00Z");
    assert.equal(data.summary.total_requests, 100);
    assert.equal(data.summary.ok_requests, 90);
    assert.equal(data.endpoints[0].endpoint_id, "fx");
    assert.equal(data.networks[0].network, "finney");
    assert.equal(data.buckets.length, 1);
    assert.equal(data.bucket_granularity, "1h");
  });

  test("returns a cold-stable zeroed payload when D1 has no rows", async () => {
    const d1 = async () => [];
    const data = await loadRpcUsage(d1, { window: "30d" });
    assert.equal(data.window, "30d");
    assert.equal(data.summary.total_requests, 0);
    assert.deepEqual(data.endpoints, []);
    assert.deepEqual(data.networks, []);
    assert.deepEqual(data.buckets, []);
    assert.equal(data.bucket_granularity, "6h");
  });

  test("falls back to 7d for an unknown window label", async () => {
    const d1 = async () => [];
    const data = await loadRpcUsage(d1, { window: "bogus" });
    assert.equal(data.window, "7d");
    assert.equal(data.bucket_granularity, "1h");
  });
});
