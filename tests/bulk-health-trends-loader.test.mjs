import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadBulkHealthTrends } from "../src/bulk-health-trends.mjs";

describe("loadBulkHealthTrends", () => {
  test("aggregates surface_uptime_daily rows into both windows", async () => {
    const now = Date.parse("2026-06-15T12:00:00.000Z");
    let sqlSeen;
    const d1 = async (sql, params) => {
      sqlSeen = sql;
      assert.match(sql, /FROM surface_uptime_daily/);
      assert.equal(params[1], 10000);
      return [
        {
          netuid: 7,
          date: "2026-06-14",
          total: 10,
          ok_count: 9,
          avg_latency_ms: 50,
        },
        {
          netuid: 7,
          date: "2026-06-01",
          total: 4,
          ok_count: 2,
          avg_latency_ms: 80,
        },
      ];
    };
    const { data, rows } = await loadBulkHealthTrends(d1, {
      observedAt: "2026-06-15T00:00:00.000Z",
      now,
    });
    assert.equal(sqlSeen.includes("GROUP BY netuid, day"), true);
    assert.equal(rows.length, 2);
    assert.equal(data.observed_at, "2026-06-15T00:00:00.000Z");
    assert.equal(data.windows["7d"].subnet_count, 1);
    assert.equal(data.windows["7d"].subnets[0].netuid, 7);
    assert.equal(data.windows["30d"].subnet_count, 1);
    assert.equal(data.windows["30d"].subnets[0].points.length, 2);
  });

  test("returns schema-stable empty windows on cold D1", async () => {
    const d1 = async () => [];
    const { data } = await loadBulkHealthTrends(d1, {});
    assert.equal(data.schema_version, 1);
    assert.equal(data.windows["7d"].subnet_count, 0);
    assert.deepEqual(data.windows["7d"].subnets, []);
    assert.equal(data.windows["30d"].subnet_count, 0);
    assert.deepEqual(data.windows["30d"].subnets, []);
  });
});
