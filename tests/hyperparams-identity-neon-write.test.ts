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
  FAMILY_MIRROR_PLANS,
  SUBNET_HYPERPARAMS_NEON_LANE,
  SUBNET_OWNERSHIP_NEON_LANE,
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
  HYPERDRIVE: { connectionString: "postgresql://example/db" },
};
const ctx = { waitUntil: () => undefined };

const HP_ROW = { netuid: 1, captured_at: 5, registration_allowed: true };
const HP_HIST = { netuid: 1, observed_at: 5, hyperparams_hash: "h" };

describe("every plan's history guard", () => {
  // DERIVED, not restated. The rule is: a history whose conflict key already
  // CONTAINS its timestamp needs no guard, because a conflict there is the
  // identical row arriving twice. A history keyed on CONTENT does need one, or
  // buildPgUpsert's `DO UPDATE SET <every non-key column>` rewrites the
  // first-seen stamp to last-seen on every pass.
  //
  // That is not hypothetical -- it is #10836, measured on production:
  // subnet_identity_history held 125 rows across 7 landed passes with 124 of
  // them sitting at the single newest one. Asserting the RULE rather than
  // listing today's four plans is what makes the fifth plan inherit it.
  const timestampColumns = ["observed_at", "captured_at"];

  for (const [lane, plan] of Object.entries(FAMILY_MIRROR_PLANS)) {
    test(`${lane}: guarded iff its history is content-keyed`, () => {
      const keyedOnTime = plan.history.conflict.some((column) =>
        timestampColumns.includes(column),
      );
      if (keyedOnTime) {
        assert.equal(
          plan.history.guard,
          undefined,
          `${lane}'s history key contains its timestamp, so a guard would be dead weight`,
        );
        return;
      }
      assert.ok(
        plan.history.guard,
        `${lane}'s history is keyed on content, so without a guard every ` +
          `re-send rewrites its first-seen stamp -- the #10836 bug`,
      );
      // The guard must compare the history's OWN stamp, and in the direction
      // that keeps the older one. `<` here would be the bug with extra steps.
      assert.match(
        plan.history.guard,
        new RegExp(`^${plan.history.table}\\.\\w+ > EXCLUDED\\.\\w+$`),
        `${lane}'s guard must keep the EARLIER observation`,
      );
    });
  }

  test("only a family whose producer posts everything at once may prune", () => {
    // Pruning against a CHUNK deletes the rows the other chunks carried. Only
    // subnet-ownership posts its whole population in one request, so it is the
    // only plan allowed a prune -- pinned so a future plan cannot pick it up
    // by copy-paste without this test failing.
    const pruning = Object.entries(FAMILY_MIRROR_PLANS)
      .filter(([, plan]) => plan.prune)
      .map(([lane]) => lane);
    assert.deepEqual(pruning, [SUBNET_OWNERSHIP_NEON_LANE]);
  });
});

describe("the lane gate", () => {
  // The off-arm test lived here until #10051: with D1 deleted the write is
  // unconditional, and the behaviour it pinned is gone.
  test("an unknown lane is a no-op, not a throw", async () => {
    // Callers name lanes in code now (#10051); a name this table lacks is a
    // config defect to surface, not a reason to crash the pass around it.
    const out = await mirrorFamilyToNeon(ENV, ctx, "typo-lane", {
      rows: [HP_ROW],
      historyRows: [],
    });
    assert.equal(out.attempted, false);
  });

  // "the two families move independently" also retired with the flag: the
  // per-lane independence it pinned was a property of the free-text list.
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
      {},
      ctx,
      SUBNET_HYPERPARAMS_NEON_LANE,
      { rows: [HP_ROW], historyRows: [] },
    );
    assert.equal(out.attempted, true);
    // The miss is IN-BAND since #10051: empty results let a sync route ack a
    // write nothing held, so every table reports the unbound failure.
    assert.ok(Object.keys(out.results).length > 0, "the miss must be in-band");
    for (const r of Object.values(out.results)) {
      assert.deepEqual(r, {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "hyperdrive unbound",
      });
    }
  });
});
