// The durable watchdog sink (src/lane-health.ts, #9330/#9340) and the self-health
// card's lane view.
//
// The load-bearing property is NOT that a row gets written -- it is that failing to
// write one can never break the tick that was trying to record an alarm. D1 migrations
// in this repo are applied by hand, so "no such table" is a state this code must
// survive on the day the migration lands late, which is exactly when a watchdog is
// most likely to be firing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  LANE_HEALTH_RETENTION_MS,
  loadLatestLaneHealth,
  recordLaneVerdict,
  staleLanes,
  type LaneHealthRecord,
} from "../src/lane-health.ts";
import { buildSelfHealth, withLaneHealth } from "../src/self-health.ts";
import { SelfHealthArtifactSchema } from "../schemas-src/routes/self-health.ts";

const NOW = 1_785_800_000_000;

function record(over: Partial<LaneHealthRecord> = {}): LaneHealthRecord {
  return {
    lane: "chain-detail",
    verdict: "stale",
    age_ms: 4 * 60 * 60 * 1000,
    detail: "hot_window.to frozen at 8,765,682",
    checked_at: NOW,
    ...over,
  };
}

/** A D1 double that records SQL and bound values, or fails however asked. */
function fakeDb(
  rows: Record<string, unknown>[] | Error = [],
  { failOnRun = false }: { failOnRun?: boolean | Error } = {},
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  return {
    calls,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });
            return {
              async run() {
                if (failOnRun) {
                  throw failOnRun instanceof Error
                    ? failOnRun
                    : new Error("D1_ERROR: no such table: lane_health");
                }
                return { success: true };
              },
            };
          },
          async all() {
            calls.push({ sql, values: [] });
            if (rows instanceof Error) throw rows;
            return { results: rows };
          },
        };
      },
    },
  };
}

describe("recordLaneVerdict", () => {
  test("writes the verdict with its lane, age and detail", async () => {
    const { db, calls } = fakeDb();
    assert.equal(await recordLaneVerdict(db, record()), true);
    const inserts = calls.filter((c) => c.sql.startsWith("INSERT INTO"));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].values, [
      "chain-detail",
      "stale",
      4 * 60 * 60 * 1000,
      "hot_window.to frozen at 8,765,682",
      NOW,
    ]);
  });

  test("prunes only its own lane, only past the retention horizon", async () => {
    // Bounded work per tick: one lane, indexed by (lane, checked_at). A prune that
    // scanned every lane would make each watchdog pay for all the others.
    const { db, calls } = fakeDb();
    await recordLaneVerdict(db, record());
    const deletes = calls.filter((c) => c.sql.startsWith("DELETE FROM"));
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].sql, /WHERE lane = \? AND checked_at < \?/);
    assert.deepEqual(deletes[0].values, [
      "chain-detail",
      NOW - LANE_HEALTH_RETENTION_MS,
    ]);
  });

  test("a failed prune does not report the verdict as unrecorded", async () => {
    // The row is already committed at that point. Returning false would tell the
    // caller its alarm went unrecorded when it did not -- the precise kind of
    // wrong-but-confident report this whole change exists to remove.
    const calls: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {
            calls.push(sql);
            if (sql.startsWith("DELETE FROM"))
              throw new Error("D1_ERROR: busy");
            return { success: true };
          },
        }),
      }),
    };
    assert.equal(
      await recordLaneVerdict(
        db as unknown as Parameters<typeof recordLaneVerdict>[0],
        record(),
      ),
      true,
    );
    assert.equal(calls.filter((s) => s.startsWith("DELETE FROM")).length, 1);
  });

  test("an unapplied migration is survived, not thrown", async () => {
    // The exact shape of the bad day this is written for: the code has merged, the
    // table has not been created yet, and a lane is stale. Recording must fail soft
    // so the caller still reaches its PostHog notification and completes the tick.
    const { db } = fakeDb([], { failOnRun: true });
    assert.equal(await recordLaneVerdict(db, record()), false);
  });

  test("a missing binding is survived", async () => {
    // Local runs, CI, and self-hosters have no METAGRAPH_HEALTH_DB at all.
    assert.equal(await recordLaneVerdict(null, record()), false);
    assert.equal(await recordLaneVerdict(undefined, record()), false);
    assert.equal(
      await recordLaneVerdict(
        {} as unknown as Parameters<typeof recordLaneVerdict>[0],
        record(),
      ),
      false,
    );
  });
});

describe("loadLatestLaneHealth", () => {
  test("returns one record per lane, typed", async () => {
    const { db, calls } = fakeDb([
      {
        lane: "chain-detail",
        verdict: "stale",
        age_ms: 900,
        detail: "frozen",
        checked_at: NOW,
      },
      {
        lane: "neurons",
        verdict: "ok",
        age_ms: 10,
        detail: null,
        checked_at: NOW - 5,
      },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.deepEqual(Object.keys(latest).sort(), ["chain-detail", "neurons"]);
    assert.equal(latest["chain-detail"].verdict, "stale");
    assert.equal(latest.neurons.detail, null);
    // The newest-per-lane reduction happens in SQL, not in the Worker: the table
    // grows by a row per lane per tick forever, so a full scan would get slower
    // every day this runs.
    assert.match(calls[0].sql, /MAX\(checked_at\)[\s\S]*GROUP BY lane/);
  });

  test("a verdict this build does not know reads as unknown, not as ok", async () => {
    const { db } = fakeDb([
      {
        lane: "a",
        verdict: "catastrophe",
        age_ms: 1,
        detail: null,
        checked_at: 1,
      },
      { lane: "b", verdict: null, age_ms: 1, detail: null, checked_at: 1 },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.equal(latest.a.verdict, "unknown");
    assert.equal(latest.b.verdict, "unknown");
  });

  test("unusable rows are dropped rather than served as zeroes", async () => {
    const { db } = fakeDb([
      { lane: "", verdict: "ok", age_ms: 1, detail: null, checked_at: 1 },
      { lane: null, verdict: "ok", age_ms: 1, detail: null, checked_at: 1 },
      // A non-integer age is not a zero age -- it is an unmeasured one.
      {
        lane: "c",
        verdict: "ok",
        age_ms: "not-a-number",
        detail: null,
        checked_at: 2,
      },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.deepEqual(Object.keys(latest), ["c"]);
    assert.equal(latest.c.age_ms, null);
  });

  test("a failed or absent read yields no lanes rather than throwing", async () => {
    const { db } = fakeDb(new Error("D1_ERROR: no such table: lane_health"));
    assert.deepEqual(await loadLatestLaneHealth(db), {});
    assert.deepEqual(await loadLatestLaneHealth(null), {});
    assert.deepEqual(
      await loadLatestLaneHealth(
        {} as unknown as Parameters<typeof loadLatestLaneHealth>[0],
      ),
      {},
    );
  });

  test("a query returning nothing is an empty map, not a failure", async () => {
    const { db } = fakeDb([]);
    assert.deepEqual(await loadLatestLaneHealth(db), {});
  });

  test("a driver without an all() is treated as no data", async () => {
    // The injected-fake surface is deliberately narrow (`all?()`), and a D1 binding
    // that cannot answer a SELECT must degrade to "no lanes" rather than throw
    // through a watchdog tick.
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
    assert.deepEqual(
      await loadLatestLaneHealth(
        db as unknown as Parameters<typeof loadLatestLaneHealth>[0],
      ),
      {},
    );
  });

  test("a row with no result set is an empty map", async () => {
    const db = { prepare: () => ({ all: async () => null }) };
    assert.deepEqual(
      await loadLatestLaneHealth(
        db as unknown as Parameters<typeof loadLatestLaneHealth>[0],
      ),
      {},
    );
  });

  test("null age and null checked_at are read as unmeasured and epoch", async () => {
    // age_ms null is genuinely "we could not measure how far behind"; checked_at has
    // no such reading, so it floors to 0 -- which sorts the row FIRST in staleLanes,
    // i.e. treated as longest-unverified rather than newest.
    const { db } = fakeDb([
      {
        lane: "a",
        verdict: "stale",
        age_ms: null,
        detail: null,
        checked_at: null,
      },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.equal(latest.a.age_ms, null);
    assert.equal(latest.a.checked_at, 0);
  });
});

describe("staleLanes", () => {
  test("reports only stale lanes, longest-wrong first", () => {
    const latest = {
      fresh: record({ lane: "fresh", verdict: "ok", checked_at: NOW }),
      newer: record({ lane: "newer", checked_at: NOW }),
      older: record({ lane: "older", checked_at: NOW - 1000 }),
      // `unknown` means the watchdog could not evaluate. Claiming staleness from an
      // absence of measurement is the confident-wrong-answer this repo avoids.
      quiet: record({ lane: "quiet", verdict: "unknown", checked_at: 0 }),
    };
    assert.deepEqual(
      staleLanes(latest).map((r) => r.lane),
      ["older", "newer"],
    );
  });
});

describe("withLaneHealth", () => {
  test("stale lanes lead, then alphabetical, and the count matches", () => {
    const card = withLaneHealth(buildSelfHealth([], []), {
      neurons: record({ lane: "neurons", verdict: "ok" }),
      "chain-detail": record({ lane: "chain-detail", verdict: "stale" }),
      "rpc-usage": record({ lane: "rpc-usage", verdict: "stale" }),
      alpha: record({ lane: "alpha", verdict: "unknown" }),
    });
    assert.deepEqual(
      card.lanes.map((l) => l.lane),
      ["chain-detail", "rpc-usage", "alpha", "neurons"],
    );
    assert.equal(card.stale_lane_count, 2);
    // checked_at is serialized the same way every other timestamp on this card is.
    assert.equal(card.lanes[0].checked_at, new Date(NOW).toISOString());
  });

  test("no lanes is an empty list and a zero count, never a stale claim", () => {
    const card = withLaneHealth(buildSelfHealth([], []), {});
    assert.deepEqual(card.lanes, []);
    assert.equal(card.stale_lane_count, 0);
  });

  test("the card still satisfies its published schema", () => {
    // #9330 adds two fields to a response that is served under a schema; the pool
    // schemas caught exactly this omission on a sibling change.
    const card = withLaneHealth(buildSelfHealth([], []), {
      "chain-detail": record(),
    });
    const parsed = SelfHealthArtifactSchema.safeParse(card);
    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    );
  });

  test("the components the card already carried are preserved", () => {
    const base = buildSelfHealth(
      [{ day: "2026-08-01", component: "api", checks: 10, ok_count: 10 }],
      [],
    );
    const card = withLaneHealth(base, { neurons: record({ lane: "neurons" }) });
    assert.deepEqual(card.components, base.components);
    assert.equal(card.verdict, base.verdict);
    assert.equal(card.observed_at, base.observed_at);
  });
});
