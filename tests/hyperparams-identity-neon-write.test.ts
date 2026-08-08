// The Neon write for subnet_hyperparams and account_identity (#10046).
//
// Both families showed EXACT parity in Neon and looked ready to invert -- and
// neither handler had ever executed a Neon write. Their copies came from the
// reconciler cron. That is why this module exists: a code path that has never
// run is not evidence, however equal the row counts look, and inverting on
// reconciler parity would mean deleting the D1 copy while trusting something
// unexercised.
//
// TRANSITIONAL (#10051). Every assertion here describes a rung, not the
// destination: once these tables are sole-store the D1 write goes, and once
// every table has crossed this module is deleted along with the rest of the
// dual-write scaffolding.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  ACCOUNT_IDENTITY_NEON_LANE,
  SUBNET_HYPERPARAMS_NEON_LANE,
  failedTables,
  mirrorFamilyToNeon,
} from "../src/hyperparams-identity-neon-write.ts";

/** Captures the statements a mirror would issue, without a database. */
function sqlSpy(failOn?: string) {
  const statements: string[] = [];
  return {
    statements,
    sql: {
      unsafe: async (text: string) => {
        statements.push(text);
        if (failOn && text.includes(failOn)) throw new Error("boom");
        return [];
      },
    },
  };
}

const ENV = {
  NEON_DUAL_WRITE_LANES: "subnet-hyperparams,account-identity",
  HYPERDRIVE: { connectionString: "postgresql://example/db" },
};
const ctx = { waitUntil: () => undefined };

const HP_ROW = { netuid: 1, captured_at: 5, registration_allowed: true };
const HP_HIST = { netuid: 1, observed_at: 5, hyperparams_hash: "h" };

describe("the lane gate", () => {
  test("an unnamed lane writes nothing", async () => {
    const spy = sqlSpy();
    const out = await mirrorFamilyToNeon(
      { ...ENV, NEON_DUAL_WRITE_LANES: "" },
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [HP_HIST] },
      { sql: spy.sql },
    );
    assert.equal(out.attempted, false);
    assert.deepEqual(spy.statements, []);
  });

  test("an unknown lane is a no-op, not a throw", async () => {
    // The flag is free text. A typo must not take down the D1 write this runs
    // behind.
    const out = await mirrorFamilyToNeon(ENV, ctx, "typo-lane", {
      rows: [HP_ROW],
      historyRows: [],
    });
    assert.equal(out.attempted, false);
  });

  test("the two families move independently", async () => {
    const spy = sqlSpy();
    const out = await mirrorFamilyToNeon(
      { ...ENV, NEON_DUAL_WRITE_LANES: "account-identity" },
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [] },
      { sql: spy.sql },
    );
    assert.equal(out.attempted, false);
  });
});

describe("what it writes", () => {
  test("both tables, latest and history", async () => {
    const spy = sqlSpy();
    const out = await mirrorFamilyToNeon(
      ENV,
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [HP_HIST] },
      { sql: spy.sql },
    );
    assert.equal(out.attempted, true);
    assert.equal(spy.statements.length, 2);
    assert.match(spy.statements[0]!, /INSERT INTO subnet_hyperparams\b/);
    assert.match(spy.statements[1]!, /INSERT INTO subnet_hyperparams_history/);
  });

  test("the LATEST table is freshness-guarded and the history is NOT", async () => {
    // The card is rewritten in place, so an out-of-order pass must not roll it
    // back. A history row is appended only when the hash CHANGED, so a
    // conflict on (netuid, observed_at) means the same revision arriving
    // twice -- doing nothing is right, and a `captured_at <` guard there would
    // reference a column the history table does not have.
    const spy = sqlSpy();
    await mirrorFamilyToNeon(
      ENV,
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [HP_HIST] },
      { sql: spy.sql },
    );
    assert.match(
      spy.statements[0]!,
      /subnet_hyperparams\.captured_at < EXCLUDED\.captured_at/,
    );
    assert.doesNotMatch(spy.statements[1]!, /captured_at/);
  });

  test("an empty side issues no statement for it", async () => {
    const spy = sqlSpy();
    await mirrorFamilyToNeon(
      ENV,
      ctx,
      ACCOUNT_IDENTITY_NEON_LANE,
      { rows: [{ account: "a", captured_at: 1 }], historyRows: [] },
      { sql: spy.sql },
    );
    assert.equal(spy.statements.length, 1);
    assert.match(spy.statements[0]!, /INSERT INTO account_identity\b/);
  });

  test("the history conflicts on the pair, not on an id", async () => {
    // These tables carry an AUTOINCREMENT id whose values differ per store.
    // Conflicting on it would make the mirror depend on two sequences
    // agreeing, which they never will.
    const spy = sqlSpy();
    await mirrorFamilyToNeon(
      ENV,
      ctx,
      ACCOUNT_IDENTITY_NEON_LANE,
      {
        rows: [],
        historyRows: [{ account: "a", observed_at: 2, identity_hash: "h" }],
      },
      { sql: spy.sql },
    );
    assert.match(spy.statements[0]!, /ON CONFLICT \(account, observed_at\)/);
  });
});

describe("failure is reported, never thrown", () => {
  test("a failing table is named so the caller can act on it", async () => {
    const spy = sqlSpy("subnet_hyperparams_history");
    const out = await mirrorFamilyToNeon(
      ENV,
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [HP_HIST] },
      { sql: spy.sql },
    );
    assert.equal(out.attempted, true);
    assert.deepEqual(failedTables(out), ["subnet_hyperparams_history"]);
    // The latest write still succeeded -- one table failing must not be
    // reported as both failing.
    assert.equal(out.results.subnet_hyperparams!.ok, true);
  });

  test("a clean run names nothing", async () => {
    const spy = sqlSpy();
    const out = await mirrorFamilyToNeon(
      ENV,
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [HP_HIST] },
      { sql: spy.sql },
    );
    assert.deepEqual(failedTables(out), []);
  });

  test("enabled but unbound is a verdict, not silence", async () => {
    // Somebody named the lane and the binding is missing. That deserves a
    // recorded failure rather than a quiet no-op.
    const out = await mirrorFamilyToNeon(
      { NEON_DUAL_WRITE_LANES: "subnet-hyperparams" },
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [] },
    );
    assert.equal(out.attempted, true);
    assert.deepEqual(out.results, {});
  });
});
