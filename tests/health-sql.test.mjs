import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OK_LATENCY,
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
} from "../src/health-sql.mjs";

describe("health-sql latency builders", () => {
  test("OK_LATENCY gates latency on a successful probe that recorded one", () => {
    assert.equal(OK_LATENCY, "ok = 1 AND latency_ms IS NOT NULL");
  });

  test("rankedChecksCte ranks ok-latency rows and inlines the WHERE clause", () => {
    const cte = rankedChecksCte("netuid = ?");
    assert.match(cte, /WITH ranked AS/);
    assert.match(cte, /FROM surface_checks/);
    assert.ok(cte.includes("WHERE netuid = ?"));
    // latency stats are success-only.
    assert.ok(cte.includes(OK_LATENCY));
    assert.match(cte, /ROW_NUMBER\(\) OVER/);
    assert.ok(cte.includes("AS lat_cnt"));
  });

  test("latencyStatColumns emits samples, mean, min/max and p50/p95/p99 by default", () => {
    const cols = latencyStatColumns();
    assert.ok(cols.includes("AS latency_samples"));
    assert.ok(cols.includes("AS avg_latency_ms"));
    assert.ok(cols.includes("AS min_latency_ms"));
    assert.ok(cols.includes("AS max_latency_ms"));
    for (const p of ["AS p50", "AS p95", "AS p99"]) {
      assert.ok(cols.includes(p), p);
    }
    // default keeps the raw quotient — no INTEGER rounding.
    assert.ok(!cols.includes("CAST(ROUND("));
  });

  test("latencyStatColumns honours roundedAvg and includeMinMax options", () => {
    assert.ok(latencyStatColumns({ roundedAvg: true }).includes("CAST(ROUND("));
    const noMinMax = latencyStatColumns({ includeMinMax: false });
    assert.ok(!noMinMax.includes("min_latency_ms"));
    assert.ok(!noMinMax.includes("max_latency_ms"));
    // percentiles and the mean still survive without min/max.
    assert.ok(
      noMinMax.includes("AS p50") && noMinMax.includes("AS avg_latency_ms"),
    );
  });

  test("dailyLatencyColumns re-aggregates stored rows, weighted by sample count", () => {
    const cols = dailyLatencyColumns();
    assert.ok(cols.includes("AS latency_samples"));
    assert.ok(cols.includes("AS avg_latency_ms"));
    assert.ok(!cols.includes("CAST(ROUND("));
    assert.ok(
      dailyLatencyColumns({ roundedAvg: true }).includes("CAST(ROUND("),
    );
    // The weighted mean must use REAL division — avg_latency_ms and the sample
    // counts are INTEGER columns, so a plain SUM(int)/SUM(int) would truncate.
    assert.ok(cols.includes("CAST(SUM("));
    assert.ok(cols.includes("AS REAL) /"));
  });
});
