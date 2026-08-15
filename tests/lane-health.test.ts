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
      async run(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (failOnRun) {
          throw failOnRun instanceof Error
            ? failOnRun
            : new Error("store: no such table: lane_health");
        }
        return { changes: 1 };
      },
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (rows instanceof Error) throw rows;
        return rows;
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
      query: async () => [],
      run: async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith("DELETE FROM")) throw new Error("store: busy");
        return { changes: 1 };
      },
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
        // `neon:neurons`, not the bare spelling: that one is retired (#10851
        // froze it) and the serving read drops retired lanes by design.
        lane: "neon:neurons",
        verdict: "ok",
        age_ms: 10,
        detail: null,
        checked_at: NOW - 5,
      },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.deepEqual(Object.keys(latest).sort(), [
      "chain-detail",
      "neon:neurons",
    ]);
    assert.equal(latest["chain-detail"].verdict, "stale");
    assert.equal(latest["neon:neurons"].detail, null);
    // The newest-per-lane reduction happens in SQL, not in the Worker: the table
    // grows by a row per lane per tick forever, so a full scan would get slower
    // every day this runs.
    assert.match(calls[0].sql, /MAX\(checked_at\)[\s\S]*GROUP BY lane/);
  });

  // TWO ROWS CAN TIE AT THE MAX, and this used to resolve by row order.
  //
  // `lane_health` has no key, recordLaneVerdict INSERTs, and its prune deletes
  // `checked_at < ?` -- strictly less -- so same-stamp rows both survive and
  // both match the MAX. Several lanes are stamped with the PRODUCER's pass time
  // rather than the check time, so the stamp freezes while the producer is down
  // and later writes land on top of it: a sync flush writing `ok` beside a
  // staleness watchdog writing `unknown`, same lane, same millisecond.
  //
  // Measured 2026-08-15 03:58Z: the lane alarm read the `ok` side of exactly
  // that tie and CLOSED #11252 and #11253 as recovered, while
  // /api/v1/self-health served `unknown` for the same lanes at the same
  // millisecond. Both lanes had been dead 76 hours.
  //
  // THE `neon:` SPELLING, not the bare one the incident was reported under.
  // That bare name is retired as of the #10851 fossil sweep, so
  // loadLatestLaneHealth now DROPS it -- and a fixture the reader discards
  // makes every assertion below pass on an empty result. Same lane, same
  // "127 statement(s) flushed" that its flush actually writes, still watched.
  const TIED_LANE = "neon:validator-nominator-counts";

  const tiedRows = (first: string, second: string) => [
    {
      lane: TIED_LANE,
      verdict: first,
      age_ms: null,
      detail:
        first === "ok" ? "127 statement(s) flushed" : "no verdict for 4597m",
      checked_at: NOW,
    },
    {
      lane: TIED_LANE,
      verdict: second,
      age_ms: null,
      detail:
        second === "ok" ? "127 statement(s) flushed" : "no verdict for 4597m",
      checked_at: NOW,
    },
  ];

  test("a tie resolves to the WORST verdict, whichever row comes first", async () => {
    for (const [a, b] of [
      ["ok", "unknown"],
      ["unknown", "ok"],
    ]) {
      const { db } = fakeDb(tiedRows(a, b));
      const latest = await loadLatestLaneHealth(db);
      assert.equal(
        latest[TIED_LANE].verdict,
        "unknown",
        `order ${a},${b}: a finding must survive a tie with ok`,
      );
      // And it carries THAT row's detail, so the reader is not shown the
      // reassuring half of a contradiction.
      assert.match(latest[TIED_LANE].detail ?? "", /no verdict for/);
    }
  });

  test("a measured breach outranks an unmeasurable one on a tie", async () => {
    for (const [a, b] of [
      ["stale", "unknown"],
      ["unknown", "stale"],
    ]) {
      const { db } = fakeDb(tiedRows(a, b));
      const latest = await loadLatestLaneHealth(db);
      assert.equal(latest[TIED_LANE].verdict, "stale");
    }
  });

  // THE PROPERTY THAT MUST NOT REGRESS, and it caught a real flaw in the first
  // draft of this fix: ordering by severity ALONE lets an older finding outrank
  // a genuine recovery, which is the false-ALARM mirror of the false-recovery
  // above. A lane that really recovers is not a tie at all -- the producer ran,
  // so its stamp advances -- and the reader now says so explicitly rather than
  // relying on the SQL having already reduced the set.
  test("a NEWER ok still wins outright over an older finding", async () => {
    const { db } = fakeDb([
      {
        lane: "a",
        verdict: "stale",
        age_ms: 1,
        detail: "behind",
        checked_at: NOW - 1,
      },
      {
        lane: "a",
        verdict: "ok",
        age_ms: 1,
        detail: "recovered",
        checked_at: NOW,
      },
    ]);
    const latest = await loadLatestLaneHealth(db);
    assert.equal(latest.a.verdict, "ok");
    assert.equal(latest.a.checked_at, NOW);
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
    // The injected-fake surface is deliberately narrow (`all?()`), and a store binding
    // that cannot answer a SELECT must degrade to "no lanes" rather than throw
    // through a watchdog tick.
    const db = {
      run: async () => ({ changes: 1 }),
      query: async () => {
        throw new Error("store cannot SELECT");
      },
    };
    assert.deepEqual(
      await loadLatestLaneHealth(
        db as unknown as Parameters<typeof loadLatestLaneHealth>[0],
      ),
      {},
    );
  });

  // "a row with no result set" retired with the D1 envelope (#10909): the
  // owned query() answers rows or throws (the arm above); zero rows is the
  // empty map, pinned elsewhere in this suite.

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

// A dead-letter verdict is an EVENT, and the serving read treated it as a
// state (#11297).
//
// `handleDeadLetterBatch` is a `*-dlq` lane's only writer and it writes only on
// a loss, because nothing un-loses a message. So the last loss was served as
// the current state forever: measured 2026-08-15, `/api/v1/self-health`
// reported `stale_lane_count: 1` for `probe-jobs-dlq` while every cause behind
// those losses had been fixed and verified hours earlier.
describe("a dead-letter verdict ages out of the serving read", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const dlq = (checked_at: number): LaneHealthRecord => ({
    lane: "probe-jobs-dlq",
    verdict: "stale",
    age_ms: null,
    detail:
      "2 dead-lettered message(s) on probe-jobs-dlq (netuid=108,netuid=29)",
    checked_at,
  });
  const card = (rows: LaneHealthRecord[], nowMs: number) =>
    withLaneHealth(
      buildSelfHealth([], []),
      Object.fromEntries(rows.map((r) => [r.lane, r])),
      { nowMs },
    );

  test("A RECENT LOSS STILL COUNTS -- this is not suppression", () => {
    const now = 1_785_000_000_000;
    const out = card([dlq(now - 60_000)], now);
    assert.equal(out.stale_lane_count, 1);
    assert.equal(out.lanes[0]?.lane, "probe-jobs-dlq");
  });

  test("past the residue window it stops being NOW", () => {
    // The row stays in `lane_health` for triage. What changes is whether it is
    // served as the current fleet state.
    const now = 1_785_000_000_000;
    const out = card([dlq(now - WEEK - 1)], now);
    assert.equal(out.stale_lane_count, 0);
    assert.deepEqual(out.lanes, []);
  });

  test("the boundary is the alarm's own constant, not a second number", () => {
    const now = 1_785_000_000_000;
    assert.equal(card([dlq(now - WEEK)], now).stale_lane_count, 1);
    assert.equal(card([dlq(now - WEEK - 1)], now).stale_lane_count, 0);
  });

  test("A FRESH LOSS BRINGS IT BACK on the same tick", () => {
    // The property that makes ageing-out different from muting: the lane is
    // still watched, and the next real loss is reported immediately.
    const now = 1_785_000_000_000;
    assert.equal(card([dlq(now - WEEK - 1)], now).stale_lane_count, 0);
    assert.equal(card([dlq(now - 1_000)], now).stale_lane_count, 1);
  });

  test("A DLQ IS NEVER MARKED SILENT -- its quiet is the goal", () => {
    // `laneSilenceCadenceMs` reads the gaps between a lane's rows. For a dlq
    // those are the spacing between FAILURES, so a queue that lost messages
    // hourly for an afternoon gets a "cadence" of an hour and then reads
    // `unknown -- no verdict for 186m (cadence ~60m)`: "expected to lose a
    // message every hour and has not". Measured in production, that string.
    const now = 1_785_000_000_000;
    const out = withLaneHealth(
      buildSelfHealth([], []),
      // Five hours against a 3x-of-60m bound, so it is PAST the threshold
      // rather than exactly on it -- at exactly 3x the comparison is `>` and
      // the test would pass with the exemption removed.
      { "probe-jobs-dlq": dlq(now - 5 * 60 * 60 * 1000) },
      { nowMs: now, cadences: { "probe-jobs-dlq": 60 * 60 * 1000 } },
    );
    assert.equal(
      out.lanes[0]?.verdict,
      "stale",
      "still a real loss, still counted",
    );
    assert.equal(out.stale_lane_count, 1);
    assert.doesNotMatch(String(out.lanes[0]?.detail), /cadence/);
  });

  test("an ordinary lane IS still marked silent on the same input", () => {
    // Non-vacuity for the test above: the exemption is what changes the
    // outcome, not the fixture being unreachable by the silence path.
    const now = 1_785_000_000_000;
    const out = withLaneHealth(
      buildSelfHealth([], []),
      {
        "chain-detail": {
          lane: "chain-detail",
          verdict: "stale" as const,
          age_ms: 1,
          detail: "frozen",
          // Five hours against a 3x-of-60m threshold, so it is past the bound
          // rather than exactly on it.
          checked_at: now - 5 * 60 * 60 * 1000,
        },
      },
      { nowMs: now, cadences: { "chain-detail": 60 * 60 * 1000 } },
    );
    assert.equal(out.lanes[0]?.verdict, "unknown");
    assert.match(String(out.lanes[0]?.detail), /cadence/);
  });

  test("an ORDINARY lane's old stale verdict is left alone", () => {
    // The scope of this rule is exactly the family that cannot say `ok`.
    // Ageing out every stale verdict would hide genuinely broken lanes, which
    // is the opposite failure and a much worse one.
    const now = 1_785_000_000_000;
    const out = card(
      [
        {
          lane: "chain-detail",
          verdict: "stale",
          age_ms: 1,
          detail: "frozen",
          checked_at: now - WEEK - 1,
        },
      ],
      now,
    );
    assert.equal(out.stale_lane_count, 1);
  });
});
