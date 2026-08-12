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
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  latestCompletePass,
  mayReadPass,
  PASS_TABLES,
} from "../src/pass-completeness.ts";

const db = (row: unknown, sqlSink?: string[]) => ({
  async first(sql: string) {
    sqlSink?.push(sql);
    return row;
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
      first() {
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

// The passTallyStatement describe retired with the builder (#10909): its only
// callers were these tests -- the live write path has been writePassTallyToNeon
// since the cutover, and a statement builder that exists to feed a deleted
// store's batch() is scaffolding, not API. writePassTallyToNeon's own suite
// below carries every property this one asserted (accumulate-not-overwrite,
// stamp-once, the >= comparison).

describe("PASS_TABLES", () => {
  test("every declared table is one this reader will query", () => {
    // The two lists are the same object, and this asserts it stays that way --
    // a table in one and not the other is a tally nothing reads, or a read of
    // a table nothing writes.
    for (const [lane, table] of Object.entries(PASS_TABLES)) {
      assert.match(table, /_passes$/, lane);
    }
    assert.deepEqual(Object.keys(PASS_TABLES).sort(), [
      // Added #10124. It was ABSENT while D1's account_balances_passes filled
      // normally, because writeAccountBalancesToStore takes the pass and writes
      // the tally itself -- only the Neon mirror consults this map, and a lane
      // missing from it is skipped silently (a lane with no pass table being a
      // legitimate state). Neon's copy therefore had zero rows.
      "account-balances",
      "hotkey-alpha",
      "neurons",
      "nominator-positions",
      "validator-nominator-counts",
    ]);
  });

  test("every declared table is actually created by a migration", () => {
    // The list above makes adding a lane a conscious act; this makes it a
    // COMPLETE one. Migrations here are applied BY HAND, so a lane added to
    // PASS_TABLES without its table does not fail at deploy -- it fails on
    // every chunk, at runtime, and wedges the lane it was meant to protect.
    //
    // `latestCompletePass` declines on a missing table rather than throwing,
    // which is right for a reader and is exactly why nothing else would notice.
    const migrations = readdirSync("tests/fixtures/sqlite-schema")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(`tests/fixtures/sqlite-schema/${f}`, "utf8"))
      .join("\n");
    for (const [lane, table] of Object.entries(PASS_TABLES)) {
      assert.match(
        migrations,
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
        `${lane} declares ${table}, which no migration creates`,
      );
    }
  });
});
