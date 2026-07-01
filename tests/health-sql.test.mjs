import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OK_LATENCY,
  SURFACE_STATUS_OK_LATENCY,
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
  surfaceStatusAvgLatencySql,
} from "../src/health-sql.mjs";

describe("health-sql latency builders", () => {
  test("OK_LATENCY gates latency on a successful probe that recorded one", () => {
    assert.equal(OK_LATENCY, "ok = 1 AND latency_ms IS NOT NULL");
  });

  test("SURFACE_STATUS_OK_LATENCY mirrors OK_LATENCY over surface_status.status", () => {
    assert.equal(
      SURFACE_STATUS_OK_LATENCY,
      "status = 'ok' AND latency_ms IS NOT NULL",
    );
  });

  test("surfaceStatusAvgLatencySql averages only ok surface_status rows", () => {
    const raw = surfaceStatusAvgLatencySql();
    assert.ok(raw.includes(SURFACE_STATUS_OK_LATENCY));
    assert.ok(raw.startsWith("AVG(CASE WHEN"));
    const rounded = surfaceStatusAvgLatencySql({ rounded: true });
    assert.ok(rounded.startsWith("ROUND(AVG(CASE WHEN"));
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

  test("latencyStatColumns picks percentiles by nearest rank (ceil), not floor+1", () => {
    const cols = latencyStatColumns();
    // ceil(q*N): truncate toward zero, then add 1 only on a fractional part.
    // The old floor(q*N)+1 overshot by one whenever q*N was an integer (the
    // common case, e.g. N=100 → p50/p95/p99 hit ranks 51/96/100, not 50/95/99).
    for (const q of ["0.5", "0.95", "0.99"]) {
      assert.ok(
        cols.includes(
          `CAST(${q} * lat_cnt AS INTEGER) + (${q} * lat_cnt > CAST(${q} * lat_cnt AS INTEGER))`,
        ),
        `percentile ${q} must select the nearest-rank (ceil) position`,
      );
    }
    // The off-by-one `floor(q*N) + 1` form must be gone.
    assert.ok(
      !/CAST\([0-9.]+ \* lat_cnt AS INTEGER\) \+ 1\b/.test(cols),
      "must not use the floor+1 rank that overshoots at integer boundaries",
    );
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
