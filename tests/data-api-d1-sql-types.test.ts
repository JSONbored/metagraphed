// SQL parameter types on the engine we actually run: D1, which is SQLite (#9426).
//
// This is the successor to tests/data-api-sql-types.test.ts, which asserted the same
// class of defect against PGlite. That test was written for a real bug --
// `realized-return-baseline-query` shipped comparing a DATE column against an integer
// and returned nothing on every invocation for days without a single test going red --
// but the query it guards, `loadRealizedStakeBaselinesD1`, runs on D1. It was
// protecting the wrong engine.
//
// AND THE WRONG ENGINE WAS THE FORGIVING ONE. Postgres raises
// `operator does not exist: date >= integer` and fails loudly. SQLite has type
// affinity instead of operator resolution: comparing a date-shaped TEXT column against
// an integer is not an error, it just quietly matches nothing. The exact defect that
// was survivable-but-visible on Postgres is silent here, so this test matters MORE on
// D1 than the one it replaces did on Postgres.
//
// The DDL is read from migrations/d1/, not from a hand-written fixture, so the column
// types are the ones production actually has.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import { REALIZED_RETURN_BASELINE_TOLERANCE_DAYS } from "../workers/data-api.ts";

const NEURONS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0007_neurons.sql"),
  "utf8",
);

const ANALYTICS_DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 10);

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(NEURONS_SCHEMA);
});

/** The production shape: an ISO date string on both sides of the range. */
function baselineQuery(cutoff: string, floor: string) {
  return db
    .prepare(
      `SELECT hotkey, snapshot_date, stake_tao
         FROM neuron_daily
        WHERE snapshot_date <= ? AND snapshot_date >= ?
        ORDER BY snapshot_date DESC`,
    )
    .all(cutoff, floor);
}

function seed(daysAgo: number, hotkey = "5HOT", stake = 100) {
  db.prepare(
    `INSERT INTO neuron_daily
       (netuid, uid, hotkey, snapshot_date, stake_tao, captured_at, updated_at)
     VALUES (0, 0, ?, ?, ?, ?, ?)`,
  ).run(
    hotkey,
    isoDate(daysAgo * ANALYTICS_DAY_MS),
    stake,
    Date.now(),
    Date.now(),
  );
}

describe("migrations/d1 DDL", () => {
  test("neuron_daily carries the columns the baseline query reads", () => {
    const cols = new Set(
      (
        db.prepare("PRAGMA table_info(neuron_daily)").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    for (const c of ["hotkey", "snapshot_date", "stake_tao"]) {
      assert.ok(cols.has(c), `neuron_daily is missing ${c}`);
    }
  });

  test("snapshot_date is TEXT, so date comparison is string comparison", () => {
    // This is the fact the whole file rests on. ISO-8601 dates sort correctly as
    // strings, which is why the string form of the query is correct -- and why an
    // integer on either side compares against nothing rather than erroring.
    const col = (
      db.prepare("PRAGMA table_info(neuron_daily)").all() as Array<{
        name: string;
        type: string;
      }>
    ).find((r) => r.name === "snapshot_date");
    assert.equal(col?.type.toUpperCase(), "TEXT");
  });
});

describe("realized-return baseline query — parameter types", () => {
  test("the correct ISO-string shape returns the rows in range", () => {
    // The positive control. Without this, every assertion below could pass on an
    // empty table and prove nothing.
    seed(1);
    seed(3);
    seed(30);
    const rows = baselineQuery(isoDate(0), isoDate(7 * ANALYTICS_DAY_MS));
    assert.equal(rows.length, 2, "the two in-window rows must come back");
  });

  test("an INTEGER on the floor side silently matches NOTHING -- the defect", () => {
    // The regression, in the form D1 actually expresses it. On Postgres this raised
    // `operator does not exist: date >= integer`. Here it is not an error at all: the
    // query runs, returns zero rows, and a caller reading "no baseline available"
    // cannot tell that apart from a genuinely empty window.
    seed(1);
    seed(3);
    const wrong = db
      .prepare(
        `SELECT hotkey FROM neuron_daily
          WHERE snapshot_date <= ? AND snapshot_date >= ?`,
      )
      .all(isoDate(0), 7);
    assert.equal(
      wrong.length,
      0,
      "if this ever returns rows, SQLite's affinity rules changed and the " +
        "reasoning in this file needs revisiting",
    );
    // And the proof it is the INTEGER that did it, not an empty table:
    assert.equal(
      baselineQuery(isoDate(0), isoDate(7 * ANALYTICS_DAY_MS)).length,
      2,
    );
  });

  test("a bare day count on the ceiling side matches nothing either", () => {
    seed(1);
    const wrong = db
      .prepare("SELECT hotkey FROM neuron_daily WHERE snapshot_date <= ?")
      .all(0);
    assert.equal(wrong.length, 0);
    assert.equal(
      db
        .prepare("SELECT hotkey FROM neuron_daily WHERE snapshot_date <= ?")
        .all(isoDate(0)).length,
      1,
    );
  });

  test("the tolerance widens the floor rather than narrowing it", () => {
    // REALIZED_RETURN_BASELINE_TOLERANCE_DAYS exists so a snapshot a day or two either
    // side of the window still anchors the return. A sign error here would silently
    // shrink the window instead, which reads as "no baseline" rather than as a bug.
    assert.ok(REALIZED_RETURN_BASELINE_TOLERANCE_DAYS > 0);
    const days = 7;
    seed(days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS);
    const widened = baselineQuery(
      isoDate(0),
      isoDate(
        (days + REALIZED_RETURN_BASELINE_TOLERANCE_DAYS) * ANALYTICS_DAY_MS,
      ),
    );
    const unwidened = baselineQuery(
      isoDate(0),
      isoDate(days * ANALYTICS_DAY_MS),
    );
    assert.equal(
      widened.length,
      1,
      "the tolerance must reach the older snapshot",
    );
    assert.equal(
      unwidened.length,
      0,
      "and without it that row is out of range",
    );
  });

  test("ISO dates order correctly as strings across a month boundary", () => {
    // The property that makes TEXT dates safe here at all. If it did not hold, every
    // range query in this family would be quietly wrong at the end of each month.
    db.prepare(
      `INSERT INTO neuron_daily
         (netuid, uid, hotkey, snapshot_date, stake_tao, captured_at, updated_at)
       VALUES (0, 1, '5A', '2026-07-31', 1, 1, 1), (0, 2, '5B', '2026-08-01', 2, 2, 2)`,
    ).run();
    const rows = db
      .prepare(
        `SELECT hotkey FROM neuron_daily
          WHERE snapshot_date >= '2026-07-31' AND snapshot_date <= '2026-08-01'
          ORDER BY snapshot_date`,
      )
      .all() as Array<{ hotkey: string }>;
    assert.deepEqual(
      rows.map((r) => r.hotkey),
      ["5A", "5B"],
    );
  });
});
