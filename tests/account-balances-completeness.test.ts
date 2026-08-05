// The account_balances completeness gate (#9511), against a REAL SQLite
// database built from the migration it reads.
//
// The bug this exists to prevent is not a crash. It is a leaderboard that is
// entirely well-formed and quietly missing its #2: production ranked
// `ORDER BY free_tao DESC` over 147,000 correct rows while the second-largest
// free balance on the network (737,821 TAO, live on chain) was simply absent,
// because the only guard was `results.length === 0` and 147,000 clears it.
//
// So the assertions here are about what the gate REFUSES, not what it returns.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  latestCompleteAccountBalancesPass,
  mayRankAccountBalances,
} from "../src/account-balances-completeness.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0020_account_balances_passes.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

/** The D1 shim shape this reader uses: prepare().first(). */
function d1() {
  return {
    prepare(sql: string) {
      return {
        async first() {
          return db.prepare(sql).get() ?? null;
        },
      };
    },
  };
}

function insertPass(
  capturedAt: number,
  expected: number,
  received: number,
  completedAt: number | null,
) {
  db.prepare(
    `INSERT INTO account_balances_passes
       (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(capturedAt, expected, received, completedAt);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("latestCompleteAccountBalancesPass", () => {
  test("declines while no pass has completed", async () => {
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(result.capturedAt, null);
    assert.equal(result.reason, "no_complete_pass");
    assert.equal(mayRankAccountBalances(result), false);
  });

  test("REFUSES a pass that is still in flight -- the 2026-08-05 shape", async () => {
    // The exact production failure: rows landed, they are correct, and ranking
    // over them drops real top holders. 147,000 of a declared 364,266.
    insertPass(1_785_907_636_083, 364_266, 147_000, null);
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(result.capturedAt, null, "an unfinished pass is not rankable");
    assert.equal(result.reason, "no_complete_pass");
    assert.equal(mayRankAccountBalances(result), false);
  });

  test("returns the newest COMPLETE pass and permits ranking", async () => {
    insertPass(1_785_900_000_000, 360_000, 360_000, 1_785_900_100_000);
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(result.capturedAt, 1_785_900_000_000);
    assert.equal(result.expectedRows, 360_000);
    assert.equal(result.receivedRows, 360_000);
    assert.equal(result.reason, null);
    assert.equal(mayRankAccountBalances(result), true);
  });

  test("a newer INCOMPLETE pass never supersedes an older complete one", async () => {
    // The case that matters operationally: yesterday's pass is whole, today's
    // died halfway. Ranking must fall back to yesterday, not to the fragment.
    insertPass(1_785_900_000_000, 360_000, 360_000, 1_785_900_100_000);
    insertPass(1_785_990_000_000, 364_266, 12_000, null);
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(
      result.capturedAt,
      1_785_900_000_000,
      "the complete pass wins even though it is older",
    );
    assert.equal(mayRankAccountBalances(result), true);
  });

  test("ordering is by completion, and a replayed pass stays complete", async () => {
    // The producer is at-least-once, so received can exceed expected. An
    // equality check would call a finished pass unfinished; the stamp decides.
    insertPass(1_785_900_000_000, 360_000, 360_000, 1_785_900_100_000);
    insertPass(1_785_990_000_000, 364_266, 389_266, 1_785_990_500_000);
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(result.capturedAt, 1_785_990_000_000);
    assert.equal(result.receivedRows, 389_266);
    assert.equal(mayRankAccountBalances(result), true);
  });

  test("a missing binding declines rather than throwing", async () => {
    for (const binding of [null, undefined, {} as never]) {
      const result = await latestCompleteAccountBalancesPass(binding);
      assert.equal(result.reason, "unavailable");
      assert.equal(mayRankAccountBalances(result), false);
    }
  });

  test("an absent table declines rather than throwing", async () => {
    // The migrations here are applied by hand, so "the table does not exist
    // yet" is a real state and means the same thing as "do not rank".
    db.exec("DROP TABLE account_balances_passes");
    const result = await latestCompleteAccountBalancesPass(d1());
    assert.equal(result.reason, "unavailable");
    assert.equal(mayRankAccountBalances(result), false);
  });

  test("an unusable captured_at is treated as no pass at all", async () => {
    const broken = {
      prepare: () => ({
        first: async () => ({
          captured_at: null,
          expected_rows: 1,
          received_rows: 1,
        }),
      }),
    };
    assert.equal(
      (await latestCompleteAccountBalancesPass(broken)).reason,
      "no_complete_pass",
    );
    const zero = {
      prepare: () => ({
        first: async () => ({
          captured_at: 0,
          expected_rows: 1,
          received_rows: 1,
        }),
      }),
    };
    assert.equal(
      (await latestCompleteAccountBalancesPass(zero)).reason,
      "no_complete_pass",
    );
  });

  test("null counts on a usable stamp degrade to null, not NaN", async () => {
    const partial = {
      prepare: () => ({
        first: async () => ({
          captured_at: 1_785_900_000_000,
          expected_rows: null,
          received_rows: null,
        }),
      }),
    };
    const result = await latestCompleteAccountBalancesPass(partial);
    assert.equal(result.capturedAt, 1_785_900_000_000);
    assert.equal(result.expectedRows, null);
    assert.equal(result.receivedRows, null);
    assert.equal(mayRankAccountBalances(result), true);
  });
});

describe("the passes migration", () => {
  test("declares the columns the reader and writer name", () => {
    const cols = new Set(
      (
        db
          .prepare("PRAGMA table_info(account_balances_passes)")
          .all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    for (const col of [
      "captured_at",
      "expected_rows",
      "received_rows",
      "completed_at",
    ]) {
      assert.ok(cols.has(col), `${col} missing from the migration`);
    }
  });

  test("is keyed one row per pass", () => {
    assert.match(SCHEMA, /PRIMARY KEY \(captured_at\)/);
  });
});
