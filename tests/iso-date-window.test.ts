// The window boundary that replaced a dialect function (#9798).
//
// This exists because `date(MAX(snapshot_date), '-30 days')` -- SQLite's, with
// no Postgres equivalent -- silently emptied `/subnets/{netuid}/history` and
// `/subnets/movers` the moment #9784 moved them to Neon: the subquery yielded
// nothing, `>=` matched nothing, and both served a schema-stable 200 with zero
// rows. Doing the shift here is what removes the dialect from the question, so
// the arithmetic is worth pinning on its own.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, test } from "vitest";
import { shiftIsoDate, readAnchoredWindow } from "../src/iso-date-window.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

describe("shiftIsoDate", () => {
  test("shifts backwards, which is the only direction the routes use", () => {
    assert.equal(shiftIsoDate("2026-08-07", -30), "2026-07-08");
    assert.equal(shiftIsoDate("2026-08-07", -1), "2026-08-06");
    assert.equal(shiftIsoDate("2026-08-07", -7), "2026-07-31");
  });

  test("crosses month, year and leap-day boundaries", () => {
    // The arithmetic is on epoch ms, so these are not special cases in the
    // implementation -- they are the cases a hand-rolled y/m/d subtraction
    // would get wrong, which is why it is not hand-rolled.
    assert.equal(shiftIsoDate("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftIsoDate("2024-03-01", -1), "2024-02-29", "leap year");
    assert.equal(shiftIsoDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftIsoDate("2026-01-15", -365), "2025-01-15");
  });

  test("a zero or forward shift is arithmetic, not a special case", () => {
    assert.equal(shiftIsoDate("2026-08-07", 0), "2026-08-07");
    assert.equal(shiftIsoDate("2026-08-07", 30), "2026-09-06");
  });

  test("truncates a fractional day rather than emitting a time", () => {
    // A window constant should always be whole days, but the output is BOUND
    // INTO SQL and compared against 'YYYY-MM-DD' -- so a value carrying hours
    // would silently match nothing, which is the failure mode this whole
    // module exists to end.
    assert.equal(shiftIsoDate("2026-08-07", -1.9), "2026-08-06");
    assert.equal(shiftIsoDate("2026-08-07", 1.9), "2026-08-08");
  });

  test("returns null for a value that is not an ISO date", () => {
    // These arrive FROM THE STORE. An empty table yields SQL NULL, and the
    // caller must see the same "no window" signal the NULL subquery produced
    // rather than bind the string "Invalid Date" into a query.
    assert.equal(shiftIsoDate(null, -30), null);
    assert.equal(shiftIsoDate(undefined, -30), null);
    assert.equal(shiftIsoDate("", -30), null);
    assert.equal(shiftIsoDate(20260807, -30), null, "a number is not a date");
    assert.equal(shiftIsoDate("2026-08-07T00:00:00Z", -30), null, "not bare");
    assert.equal(shiftIsoDate("07/08/2026", -30), null);
    assert.equal(shiftIsoDate("2026-8-7", -30), null, "unpadded");
  });

  test("returns null for a well-SHAPED date the calendar rejects", () => {
    // The regex counts digits, not calendars, so this branch is genuinely
    // reachable -- verified against Date.parse rather than assumed.
    assert.equal(shiftIsoDate("2026-13-01", -1), null, "month 13");
    assert.equal(shiftIsoDate("2026-01-32", -1), null, "day 32");
    assert.equal(shiftIsoDate("2026-00-10", -1), null, "month 0");
    // And the one Date.parse does NOT reject, pinned so the comment in the
    // module stays honest: it rolls over rather than failing.
    assert.equal(shiftIsoDate("2026-02-31", 0), "2026-03-03");
  });

  test("returns null when the shift itself is not a number", () => {
    assert.equal(shiftIsoDate("2026-08-07", Number.NaN), null);
    assert.equal(shiftIsoDate("2026-08-07", Number.POSITIVE_INFINITY), null);
    assert.equal(shiftIsoDate("2026-08-07", Number.NEGATIVE_INFINITY), null);
  });
});

describe("readAnchoredWindow", () => {
  // The conversion the three neuron_daily readers never received (#9792/#9798).
  // What matters is that no statement carries a date function and that the
  // cutoff is anchored on the STORE's newest day rather than the wall clock.
  const capturing = (answers: (sql: string) => Record<string, unknown>[]) => {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
      calls,
      runner: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return answers(sql);
      },
    };
  };

  test("reads the anchor, shifts it in TypeScript, and binds a date literal", async () => {
    const { calls, runner } = capturing((sql) =>
      /MAX\(snapshot_date\) AS end_date/.test(sql)
        ? [{ end_date: "2026-01-31" }]
        : [{ start_date: "2026-01-24" }],
    );
    assert.deepEqual(await readAnchoredWindow(runner, 7), {
      startDate: "2026-01-24",
      endDate: "2026-01-31",
    });
    assert.equal(calls.length, 2);
    for (const call of calls) assert.doesNotMatch(call.sql, /\bdate\s*\(/i);
    assert.deepEqual(calls[0].params, []);
    assert.deepEqual(calls[1].params, ["2026-01-24"]);
  });

  test("a subnet scope binds the netuid on both reads", async () => {
    const { calls, runner } = capturing((sql) =>
      /MAX\(snapshot_date\) AS end_date/.test(sql)
        ? [{ end_date: "2026-06-30" }]
        : [{ start_date: "2026-06-01" }],
    );
    await readAnchoredWindow(runner, 30, 9);
    assert.deepEqual(calls[0].params, [9]);
    assert.deepEqual(calls[1].params, [9, "2026-05-31"]);
    assert.match(calls[1].sql, /netuid = \? AND snapshot_date >= \?/);
  });

  test("the whole retained range needs no cutoff and stays one read", async () => {
    const { calls, runner } = capturing(() => [
      { start_date: "2026-01-01", end_date: "2026-06-30" },
    ]);
    assert.deepEqual(await readAnchoredWindow(runner, null, 9), {
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /snapshot_date >=/);
  });

  test("a cold store reports no window instead of computing from a null anchor", async () => {
    // The old subquery's NULL made `>=` match nothing; this must reach the
    // same "unknown window" answer without ever binding "Invalid Date".
    const { calls, runner } = capturing(() => [{ end_date: null }]);
    assert.deepEqual(await readAnchoredWindow(runner, 30), {
      startDate: null,
      endDate: null,
    });
    assert.equal(calls.length, 1, "no cutoff read against a null anchor");
  });

  test("a stored anchor that is not a date reports no window, never a guess", async () => {
    const { calls, runner } = capturing(() => [{ end_date: "not-a-day" }]);
    assert.deepEqual(await readAnchoredWindow(runner, 30), {
      startDate: null,
      endDate: null,
    });
    assert.equal(calls.length, 1);
  });
});

// Executed on a REAL Postgres engine, because the whole failure this repairs
// was a statement that parsed everywhere and ran on only one engine. A stubbed
// runner proves the shape; only an engine proves the dialect. The relation is
// created here rather than applied from migrations/postgres because
// `neuron_daily` is the portable (Neon) view's name and has no composed-tree
// definition -- what is under test is that these statements RUN, not the
// column set.
describe("readAnchoredWindow on a real Postgres engine", () => {
  let db: PGlite;
  const runner = async (sql: string, params: unknown[]) =>
    (
      await db.query<Record<string, unknown>>(
        toPositionalPlaceholders(sql),
        params,
      )
    ).rows;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE TABLE neuron_daily(netuid bigint NOT NULL, snapshot_date text NOT NULL,
         uid bigint NOT NULL, PRIMARY KEY (netuid, snapshot_date, uid))`,
    );
    for (const day of ["2026-01-01", "2026-01-15", "2026-01-31"])
      for (const netuid of [7, 9])
        await db.query(
          "INSERT INTO neuron_daily(netuid,snapshot_date,uid) VALUES ($1,$2,0)",
          [netuid, day],
        );
  });
  afterAll(() => db.close());

  test("the statement that used to answer zero rows now answers the window", async () => {
    // The pre-#9798 form for this exact question was
    //   WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ?) FROM neuron_daily)
    // which Postgres refuses outright -- proven below -- so the subquery
    // yielded nothing and `>=` matched nothing.
    assert.deepEqual(await readAnchoredWindow(runner, 30), {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    // A 7-day window anchored on the stored MAX cuts off at 2026-01-24, and
    // the only stored day at or after that is the newest one.
    assert.deepEqual(await readAnchoredWindow(runner, 7), {
      startDate: "2026-01-31",
      endDate: "2026-01-31",
    });
  });

  test("the subnet scope and the all window both execute", async () => {
    assert.deepEqual(await readAnchoredWindow(runner, 30, 9), {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    assert.deepEqual(await readAnchoredWindow(runner, null, 7), {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    // A subnet with no rows is an empty window, not an error.
    assert.deepEqual(await readAnchoredWindow(runner, 30, 404), {
      startDate: null,
      endDate: null,
    });
  });

  test("the idiom this replaced is genuinely rejected by the engine", async () => {
    // The negative half of the proof: without it, the test above only shows
    // that some statement works, not that the old one did not.
    await assert.rejects(
      db.query(
        "SELECT MIN(snapshot_date) AS start_date FROM neuron_daily" +
          " WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), '-30 days') FROM neuron_daily)",
      ),
      /date/,
    );
  });
});
