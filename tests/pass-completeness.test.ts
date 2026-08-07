// The shared pass-completeness reader and tally (metagraphed-infra#346).
//
// The property worth testing is not the SQL. It is the two rules that make a
// tally usable at all, both of which are easy to get subtly wrong:
//
//   * a pass is complete when `completed_at` is SET, never when the counts are
//     equal -- the transport is at-least-once, so a retried chunk adds its rows
//     again and `received_rows` can legitimately exceed `expected_rows`
//   * an unreadable table means "do not rank", never a throw -- these
//     migrations are applied by hand, so the window between deploying the code
//     and applying 0029 must degrade, not 500
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  latestCompletePass,
  mayReadPass,
  PASS_TABLES,
  passTallyStatement,
} from "../src/pass-completeness.ts";

const db = (row: unknown, sqlSink?: string[]) => ({
  prepare(sql: string) {
    sqlSink?.push(sql);
    return {
      async first() {
        return row;
      },
    };
  },
});

describe("latestCompletePass", () => {
  test("reads the newest complete pass for a known lane", async () => {
    const sql: string[] = [];
    const out = await latestCompletePass(
      db(
        {
          captured_at: 1_780_000_000_000,
          expected_rows: 222_381,
          received_rows: 222_381,
        },
        sql,
      ),
      "nominator-positions",
    );
    assert.deepEqual(out, {
      capturedAt: 1_780_000_000_000,
      expectedRows: 222_381,
      receivedRows: 222_381,
      reason: null,
    });
    assert.equal(mayReadPass(out), true);
    // Keys on the STAMP, not on arithmetic over the counts.
    assert.match(sql[0]!, /completed_at IS NOT NULL/);
    assert.match(sql[0]!, /FROM nominator_positions_passes/);
  });

  test("an over-delivered pass is still complete", async () => {
    // The at-least-once overshoot, which an equality check would call
    // unfinished forever: a retried chunk adds its rows again, so received can
    // exceed expected and the stamp is what settles it.
    const out = await latestCompletePass(
      db({ captured_at: 1, expected_rows: 100, received_rows: 137 }),
      "nominator-positions",
    );
    assert.equal(mayReadPass(out), true);
    assert.equal(out.receivedRows, 137);
  });

  test("no complete pass is a decline, not an empty success", async () => {
    const out = await latestCompletePass(db(null), "nominator-positions");
    assert.equal(out.reason, "no_complete_pass");
    assert.equal(mayReadPass(out), false);
  });

  test("an unreadable table declines rather than throwing", async () => {
    // These migrations are applied BY HAND, so between the deploy and the
    // migration this query hits a table that does not exist. That must read as
    // "do not rank", exactly like no complete pass -- not as a 500 on a
    // published leaderboard.
    const throwing = {
      prepare() {
        throw new Error("no such table: nominator_positions_passes");
      },
    };
    const out = await latestCompletePass(throwing, "nominator-positions");
    assert.equal(out.reason, "unavailable");
    assert.equal(mayReadPass(out), false);
  });

  test("an unknown lane declines instead of interpolating into SQL", async () => {
    // The table name is interpolated, so the allowlist is the injection guard.
    const sql: string[] = [];
    const out = await latestCompletePass(
      db({}, sql),
      "'; DROP TABLE neurons--",
    );
    assert.equal(out.reason, "unavailable");
    assert.deepEqual(sql, [], "no query was built at all");
  });

  test("a row with unusable counts still reports the pass", async () => {
    // expected_rows/received_rows are reported as null rather than 0 when the
    // column is unreadable, because 0 is a measurement and null is an absence
    // -- and the gate keys on completed_at, which this row has.
    const out = await latestCompletePass(
      db({ captured_at: 5, expected_rows: null, received_rows: 0 }),
      "nominator-positions",
    );
    assert.equal(out.reason, null);
    assert.equal(out.expectedRows, null);
    assert.equal(out.receivedRows, null);
  });

  test("a missing binding declines", async () => {
    assert.equal(
      (await latestCompletePass(null, "nominator-positions")).reason,
      "unavailable",
    );
  });
});

describe("passTallyStatement", () => {
  const bindOf = (
    lane: string,
    pass: Parameters<typeof passTallyStatement>[2],
  ) => {
    let sql = "";
    let values: unknown[] = [];
    passTallyStatement(
      {
        prepare(text: string) {
          sql = text;
          return { bind: (...v: unknown[]) => ((values = v), {}) };
        },
      },
      lane,
      pass,
    );
    return { sql, values };
  };

  test("accumulates rather than overwrites, and stamps once", async () => {
    const { sql } = bindOf("nominator-positions", {
      capturedAt: 1,
      expectedRows: 10,
      receivedRows: 4,
      nowMs: 99,
    });
    // received_rows ADDS -- a pass is many requests, and the last one must not
    // erase what the earlier ones delivered.
    assert.match(
      sql,
      /received_rows = nominator_positions_passes\.received_rows \+ excluded\.received_rows/,
    );
    // completed_at is COALESCEd -- the first write that closes the gap owns the
    // stamp, and a later retry cannot move it.
    assert.match(sql, /completed_at = COALESCE\(/);
    // >= and never =, so at-least-once cannot leave a complete pass unfinished.
    assert.match(sql, />= excluded\.expected_rows/);
  });

  test("binds the values the upsert's CASE arms need", () => {
    const { values } = bindOf("validator-nominator-counts", {
      capturedAt: 7,
      expectedRows: 10,
      receivedRows: 10,
      nowMs: 42,
    });
    assert.deepEqual(values, [7, 10, 10, 10, 10, 42, 42]);
  });

  test("THROWS for a lane with no table, rather than silently writing nothing", () => {
    // A writer calls this with its OWN hardcoded lane, so an unknown one is a
    // programming error rather than a runtime condition. Returning null would
    // put a permanently-false branch in every caller -- and worse, a lane added
    // to a route but not to PASS_TABLES would silently keep no tally, which
    // looks exactly like the gap this whole mechanism exists to close.
    assert.throws(
      () =>
        passTallyStatement(
          { prepare: () => ({ bind: () => ({}) }) },
          "hotkey-alpha",
          { capturedAt: 1, expectedRows: 1, receivedRows: 1, nowMs: 1 },
        ),
      /no pass table for lane hotkey-alpha/,
    );
  });

  test("every declared table is one this reader will query", () => {
    // The two lists are the same object, and this asserts it stays that way --
    // a table in one and not the other is a tally nothing reads, or a read of
    // a table nothing writes.
    for (const [lane, table] of Object.entries(PASS_TABLES)) {
      assert.match(table, /_passes$/, lane);
    }
    assert.deepEqual(Object.keys(PASS_TABLES).sort(), [
      "nominator-positions",
      "validator-nominator-counts",
    ]);
  });
});
