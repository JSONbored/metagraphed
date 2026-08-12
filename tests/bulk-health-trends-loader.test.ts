import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadBulkHealthTrends } from "../src/bulk-health-trends.ts";
import { HEALTH_TREND_WINDOWS } from "../workers/config.ts";
import { utcWindowCutoffDay } from "../src/health-serving.ts";
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
    query<T>(sql: string, params: unknown[] = []) {
      seen.push({ sql, params });
      if (opts.throws) return Promise.reject(new Error("store down"));
      return Promise.resolve(rows as T[]);
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
    // storeAll contains the failure: a serving path must not turn a store outage
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

// The three narrowing parameters (#9989). This route used to take NONE -- it
// served every window for every subnet, which is how the tool mirroring it
// returned ~487 KB from a call with no arguments.
describe("loadBulkHealthTrends narrowing", () => {
  const rowsFor = (netuids: number[]) =>
    netuids.flatMap((netuid) => [
      { netuid, date: dayAgo(1), total: 10, ok_count: 10, avg_latency_ms: 5 },
      { netuid, date: dayAgo(20), total: 10, ok_count: 5, avg_latency_ms: 9 },
    ]);

  test("window selects ONE window and narrows the D1 scan to it", async () => {
    // The scan half is the point, and it is invisible in the payload: the
    // loader reads the widest window because it has to answer for all of them.
    // A 7d request has no reason to read 30 days and discard 23.
    const db = fakeDb(rowsFor([1]));
    const { data } = (await loadBulkHealthTrends({
      db: db as never,
      window: "7d",
    })) as Row;
    assert.deepEqual(Object.keys(data.windows as Row), ["7d"]);
    const cutoff = db.seen[0]!.params[0] as string;
    // The loader's OWN cutoff helper, not a restatement of its arithmetic --
    // the window is inclusive (days - 1), and a test that re-derived that
    // would pass while disagreeing with the code it checks.
    assert.equal(
      cutoff,
      utcWindowCutoffDay(Date.now(), 7),
      "a 7d request must scan from the 7d cutoff, not the 30d one",
    );
    assert.notEqual(cutoff, utcWindowCutoffDay(Date.now(), 30));
  });

  test("no window reads the widest one, as it always did", async () => {
    const db = fakeDb(rowsFor([1]));
    const { data } = (await loadBulkHealthTrends({ db: db as never })) as Row;
    assert.deepEqual(
      Object.keys(data.windows as Row).sort(),
      Object.keys(HEALTH_TREND_WINDOWS).sort(),
    );
    assert.equal(
      db.seen[0]!.params[0],
      utcWindowCutoffDay(
        Date.now(),
        Math.max(...Object.values(HEALTH_TREND_WINDOWS)),
      ),
    );
  });

  test("an unknown window falls back to every window rather than serving none", async () => {
    // The route rejects a bad value before reaching here; this is the loader's
    // own floor, so a caller can never get an empty `windows` from a typo.
    const db = fakeDb(rowsFor([1]));
    const { data } = (await loadBulkHealthTrends({
      db: db as never,
      window: "90d",
    })) as Row;
    assert.deepEqual(
      Object.keys(data.windows as Row).sort(),
      Object.keys(HEALTH_TREND_WINDOWS).sort(),
    );
  });

  test("limit/offset page the subnets while subnet_count spans ALL of them", async () => {
    // The contract that lets a caller page without losing the denominator it
    // is ranking against -- the same one get_chain_deregistrations publishes.
    const db = fakeDb(rowsFor([1, 2, 3, 4, 5]));
    const { data } = (await loadBulkHealthTrends({
      db: db as never,
      window: "7d",
      limit: 2,
      offset: 1,
    })) as Row;
    const win = (data.windows as Row)["7d"] as Row;
    assert.equal(win.subnet_count, 5, "count spans every subnet, not the page");
    assert.deepEqual(
      (win.subnets as Row[]).map((s) => s.netuid),
      [2, 3],
    );
  });

  test("no limit returns every subnet, as it always did", async () => {
    const db = fakeDb(rowsFor([1, 2, 3, 4, 5]));
    const { data } = (await loadBulkHealthTrends({
      db: db as never,
      window: "7d",
    })) as Row;
    const win = (data.windows as Row)["7d"] as Row;
    assert.equal((win.subnets as Row[]).length, 5);
    assert.equal(win.subnet_count, 5);
  });
});
