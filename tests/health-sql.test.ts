import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import {
  OK_COUNT,
  OK_LATENCY,
  SURFACE_STATUS_OK_LATENCY,
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
  surfaceStatusAvgLatencySql,
} from "../src/health-sql.ts";

describe("health-sql latency builders", () => {
  test("OK_LATENCY gates latency on a successful probe that recorded one", () => {
    assert.equal(OK_LATENCY, "ok AND latency_ms IS NOT NULL");
  });

  test("no builder compares `ok` against a number", () => {
    // THE PROPERTY, not the string (#10086). `surface_checks.ok` is INTEGER in
    // D1 and BOOLEAN in Neon, so `ok = 1` / `ok = 0` / `SUM(ok)` parse on both
    // and only Postgres rejects them -- at runtime, with `operator does not
    // exist: boolean = integer`. A bare `ok` means the same thing on both.
    //
    // Asserted over every builder rather than over OK_LATENCY alone, because
    // the literal above can be fixed while a sibling builder keeps the old
    // spelling, which is exactly how the two stores drifted in the first place.
    const built = [
      OK_LATENCY,
      OK_COUNT,
      rankedChecksCte("netuid = ?"),
      dailyLatencyColumns(),
      latencyStatColumns(),
      surfaceStatusAvgLatencySql(),
      surfaceStatusAvgLatencySql({ rounded: true }),
    ].join("\n");
    assert.doesNotMatch(
      built,
      /\bok\s*(=|<>|!=)\s*[01]\b/,
      "a builder compares `ok` to a number; that is a type error on Neon",
    );
    assert.doesNotMatch(
      built,
      /\bSUM\(\s*ok\s*\)/i,
      "SUM(ok) has no meaning in Postgres -- use OK_COUNT",
    );
  });

  test("OK_COUNT counts successes without summing a boolean", () => {
    assert.equal(OK_COUNT, "SUM(CASE WHEN ok THEN 1 ELSE 0 END)");
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

  test("latencyStatColumns picks percentiles by nearest rank, EXECUTED", () => {
    // ASSERTED BY RUNNING IT, not by matching the spelling. The previous
    // version of this test pinned the exact string
    // `CAST(q*lat_cnt AS INTEGER) + (q*lat_cnt > CAST(...))`, which is a
    // restatement of the implementation: it passed for a SQLite-only
    // expression that threw `operator does not exist: integer + boolean` on
    // every Postgres read, and it would have blocked the fix (#10200).
    //
    // What matters is the rank each quantile selects. node:sqlite evaluates it
    // here; tests/analytics-live-postgres.test.ts runs the whole loader on the
    // engine that threw -- which is where a repeat of #10200 would surface.
    const cols = latencyStatColumns();
    for (const p of ["AS p50", "AS p95", "AS p99"]) {
      assert.ok(cols.includes(p), p);
    }
    const db = new DatabaseSync(":memory:");
    const rank = (q: number, n: number): number => {
      const expr = cols
        .split("\n")
        .map((line) => line.trim())
        .find(
          (line) =>
            line.startsWith(`MAX(CASE WHEN rn = `) &&
            line.includes(`${q} * lat_cnt`),
        );
      assert.ok(expr, `an expression exists for q=${q}`);
      const position = expr
        .replace("MAX(CASE WHEN rn = ", "")
        .replace(/ THEN latency_ms END\) AS \w+,?$/, "")
        .replaceAll("lat_cnt", String(n));
      const row = db.prepare(`SELECT ${position} AS pos`).get() as {
        pos: number;
      };
      return row.pos;
    };
    // ceil(q * N). The floor(q*N)+1 form this replaced overshot by one whenever
    // q*N was an integer -- N=100 picked ranks 51/96/100 instead of 50/95/99.
    const cases: [number, number, number][] = [
      [0.5, 1, 1],
      [0.95, 1, 1],
      [0.99, 1, 1],
      [0.5, 3, 2],
      [0.95, 3, 3],
      [0.99, 3, 3],
      [0.5, 7, 4],
      [0.95, 7, 7],
      [0.99, 7, 7],
      [0.5, 20, 10],
      [0.95, 20, 19],
      [0.99, 20, 20],
      [0.5, 100, 50],
      [0.95, 100, 95],
      [0.99, 100, 99],
    ];
    for (const [q, n, expected] of cases) {
      assert.equal(
        rank(q, n),
        expected,
        `p${q * 100} of ${n} rows is rank ${expected}`,
      );
    }
    db.close();
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
