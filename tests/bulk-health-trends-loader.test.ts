import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadBulkHealthTrends } from "../src/bulk-health-trends.ts";
import { HEALTH_TREND_WINDOWS } from "../workers/config.ts";
import type { Row } from "./row-type.ts";

/** UTC day string `days` before now, matching the loader's own cutoff basis. */
function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A D1 double that records the SQL it was handed and replays fixed rows.
 *
 * Shaped from what D1 actually returns (`{ results }`), not from what the
 * loader would find convenient -- a fake built to the consumer's expectation
 * cannot catch the consumer expecting the wrong thing.
 */
function fakeDb(rows: Row[], opts: { throws?: boolean } = {}) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    seen,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            all() {
              seen.push({ sql, params });
              if (opts.throws) return Promise.reject(new Error("d1 down"));
              return Promise.resolve({ results: rows });
            },
          };
        },
      };
    },
  };
}

describe("loadBulkHealthTrends", () => {
  test("returns schema-stable empty windows with no D1 binding", async () => {
    // The 2026-07-17 floor: no binding must still produce a full envelope,
    // never a null and never a throw.
    const { data, rows } = (await loadBulkHealthTrends({
      observedAt: "2026-06-15T00:00:00.000Z",
    })) as Row;
    assert.deepEqual(rows, []);
    assert.equal(data.schema_version, 1);
    assert.equal(data.observed_at, "2026-06-15T00:00:00.000Z");
    for (const label of Object.keys(HEALTH_TREND_WINDOWS)) {
      assert.equal(data.windows[label].subnet_count, 0);
      assert.deepEqual(data.windows[label].subnets, []);
    }
  });

  test("reads surface_uptime_daily from D1 when a binding is supplied", async () => {
    const db = fakeDb([
      {
        netuid: 1,
        date: dayAgo(1),
        total: 100,
        ok_count: 90,
        latency_samples: 90,
        avg_latency_ms: 200,
      },
      {
        netuid: 2,
        date: dayAgo(1),
        total: 50,
        ok_count: 50,
        latency_samples: 50,
        avg_latency_ms: 400,
      },
    ]);
    const { data, rows } = (await loadBulkHealthTrends({
      observedAt: null,
      db,
    })) as Row;

    assert.equal(rows.length, 2);
    assert.equal(data.windows["7d"].subnet_count, 2);
    const subnet1 = (data.windows["7d"].subnets as Row[]).find(
      (s) => s.netuid === 1,
    ) as Row;
    assert.equal(subnet1.uptime_ratio, 0.9);
    assert.equal(subnet1.avg_latency_ms, 200);

    // One read, not one per window -- the windows are nested, so N reads would
    // be N scans of overlapping data for the same answer.
    assert.equal(db.seen.length, 1);
    assert.match(db.seen[0].sql, /FROM surface_uptime_daily/);
    assert.match(db.seen[0].sql, /GROUP BY netuid, day/);
    // Bound, never interpolated: params are the injection boundary here.
    assert.equal(db.seen[0].params.length, 2);
    assert.match(String(db.seen[0].params[0]), /^\d{4}-\d{2}-\d{2}$/);
  });

  test("scopes each window to its own cutoff rather than reusing the widest", async () => {
    // A day inside 30d but outside 7d must land in exactly one window. This is
    // the bug that reusing the single widest read unfiltered would introduce.
    const db = fakeDb([
      {
        netuid: 7,
        date: dayAgo(2),
        total: 10,
        ok_count: 10,
        latency_samples: 10,
        avg_latency_ms: 100,
      },
      {
        netuid: 9,
        date: dayAgo(20),
        total: 10,
        ok_count: 5,
        latency_samples: 10,
        avg_latency_ms: 900,
      },
    ]);
    const { data } = (await loadBulkHealthTrends({ db })) as Row;

    const netuids = (w: string) =>
      (data.windows[w].subnets as Row[]).map((s) => s.netuid).sort();
    assert.deepEqual(netuids("7d"), [7]);
    assert.deepEqual(netuids("30d"), [7, 9]);
  });

  test("degrades to the empty shape when the D1 read fails", async () => {
    // d1All contains the failure: a serving path must not turn a store outage
    // into a route error.
    const { data, rows } = (await loadBulkHealthTrends({
      observedAt: "2026-08-03T00:00:00.000Z",
      db: fakeDb([], { throws: true }),
    })) as Row;
    assert.deepEqual(rows, []);
    assert.equal(data.observed_at, "2026-08-03T00:00:00.000Z");
    assert.equal(data.windows["7d"].subnet_count, 0);
  });
});
