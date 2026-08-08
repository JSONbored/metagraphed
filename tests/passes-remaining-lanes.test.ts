// The two lanes that could invert next, and the ledger that would have frozen
// when they did (#10056).
//
// nominator_positions and validator_nominator_counts are at exact parity with
// D1 on both count AND watermark, so they are the next inversions. Both call
// passTallyStatement inside the same D1 batch as their rows, which is precisely
// how neurons_passes froze the moment #10045 skipped that batch. Wiring their
// tallies is the precondition, not a follow-up.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { mirrorLedgerToNeon } from "../src/ledger-neon-write.ts";
import { mirrorNominatorPositionsToNeon } from "../src/nominator-positions-neon-write.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";

const PASS = {
  capturedAt: 1786106225624,
  expectedRows: 100,
  receivedRows: 100,
  nowMs: 1786106230000,
};
const ctx = { waitUntil: () => undefined } as never;

function recordingSql(fail?: RegExp) {
  const calls: string[] = [];
  return {
    calls,
    sql: {
      unsafe: async (text: string) => {
        calls.push(text);
        if (fail?.test(text)) throw new Error("boom");
        return [];
      },
    },
  };
}

describe("validator-nominator-counts", () => {
  const env = {
    NEON_DUAL_WRITE_LANES: "validator-nominator-counts",
    HYPERDRIVE: { connectionString: "postgresql://x" },
  };
  const rows = [{ hotkey: "h", captured_at: 1 }];

  test("the tally lands, and AFTER the rows", async () => {
    const { calls, sql } = recordingSql();
    await mirrorLedgerToNeon(
      env,
      ctx,
      "validator-nominator-counts",
      rows,
      { sql, laneHealthDb: null },
      PASS,
    );
    const tallyAt = calls.findIndex((c) =>
      c.includes("INSERT INTO validator_nominator_counts_passes"),
    );
    const rowsAt = calls.findIndex((c) =>
      c.includes("INSERT INTO validator_nominator_counts "),
    );
    assert.ok(rowsAt >= 0, "no row insert to order against");
    assert.ok(tallyAt > rowsAt, "the tally was written before its rows");
  });

  test("NO tally when the rows failed", async () => {
    const { calls, sql } = recordingSql(
      /INSERT INTO validator_nominator_counts /,
    );
    await mirrorLedgerToNeon(
      env,
      ctx,
      "validator-nominator-counts",
      rows,
      { sql, laneHealthDb: null },
      PASS,
    );
    assert.equal(
      calls.some((c) => c.includes("_passes")),
      false,
      "a tally was written for rows that never landed",
    );
  });

  test("hotkey-alpha writes its tally, like the other ledger lanes", async () => {
    // THIS ASSERTED THE OPPOSITE until #10137, on the reasoning that
    // hotkey-alpha and account-balances "keep their own bespoke ledgers with
    // extra columns, so PASS_TABLES gates them out".
    //
    // The schemas do carry two extra columns -- `scanned` and `outcome` -- but
    // NEITHER WRITER SETS THEM. writeHotkeyAlphaToD1 and
    // writeAccountBalancesToD1 both insert exactly the four standard columns,
    // the same four writePassTallyToNeon writes. So the exclusion was based on
    // the table's shape rather than on anything a writer did, and its effect
    // was that D1's tally filled while Neon's stayed empty -- on a lane about
    // to become the only writer of it.
    assert.equal(PASS_TABLES["hotkey-alpha"], "hotkey_alpha_passes");
    const { calls, sql } = recordingSql();
    await mirrorLedgerToNeon(
      { ...env, NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      ctx,
      "hotkey-alpha",
      [{ hotkey: "h", netuid: 1, captured_at: 1 }],
      { sql, laneHealthDb: null },
      PASS,
    );
    assert.ok(
      calls.some((c) => c.includes("INSERT INTO hotkey_alpha_passes")),
      `no tally written; statements were: ${calls.join(" | ")}`,
    );
  });

  test("the tally is still WITHHELD when the rows did not land", async () => {
    // The gate that matters is "rows first", not "which lane" -- a pass marked
    // complete whose rows failed is the one failure this ledger exists to make
    // impossible, and it is never revisited.
    const { calls, sql } = recordingSql(/INSERT INTO hotkey_alpha /);
    await mirrorLedgerToNeon(
      { ...env, NEON_DUAL_WRITE_LANES: "hotkey-alpha" },
      ctx,
      "hotkey-alpha",
      [{ hotkey: "h", netuid: 1, captured_at: 1 }],
      { sql, laneHealthDb: null },
      PASS,
    );
    assert.equal(
      calls.some((c) => c.includes("hotkey_alpha_passes")),
      false,
      "a tally was written for rows that never landed",
    );
  });
});

describe("nominator-positions", () => {
  const env = {
    NEON_DUAL_WRITE_LANES: "nominator-positions",
    HYPERDRIVE: { connectionString: "postgresql://x" },
  };
  const input = {
    rows: [{ coldkey: "c", hotkey: "h", netuid: 1, captured_at: 5 }],
    coldkeyMaxCapturedAt: new Map([["c", 5]]),
  };

  test("the tally lands AFTER the prune, not merely after the upsert", async () => {
    // This lane's pass is only whole once superseded positions are gone. A
    // tally written between upsert and prune would declare a complete pass
    // over a table that still holds stale rows.
    const { calls, sql } = recordingSql();
    await mirrorNominatorPositionsToNeon(
      env,
      ctx,
      { ...input, pass: PASS },
      { sql, laneHealthDb: null },
    );
    const tallyAt = calls.findIndex((c) =>
      c.includes("INSERT INTO nominator_positions_passes"),
    );
    const pruneAt = calls.findIndex((c) => c.includes("DELETE FROM"));
    assert.ok(pruneAt >= 0, "no prune to order against");
    assert.ok(tallyAt > pruneAt, "the tally was written before the prune");
  });

  test("NO tally when the prune failed", async () => {
    const { calls, sql } = recordingSql(/DELETE FROM/);
    await mirrorNominatorPositionsToNeon(
      env,
      ctx,
      { ...input, pass: PASS },
      { sql, laneHealthDb: null },
    );
    assert.equal(
      calls.some((c) => c.includes("_passes")),
      false,
    );
  });

  test("no pass declared means no tally", async () => {
    const { calls, sql } = recordingSql();
    await mirrorNominatorPositionsToNeon(env, ctx, input, {
      sql,
      laneHealthDb: null,
    });
    assert.equal(
      calls.some((c) => c.includes("_passes")),
      false,
    );
  });
});
