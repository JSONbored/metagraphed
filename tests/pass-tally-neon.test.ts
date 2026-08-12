// The completeness tally, against Postgres (#10056).
//
// WHAT BROKE, so the tests below read as a fix rather than as coverage. The
// tally is appended to the SAME D1 batch as the rows it describes, deliberately
// -- a tally must not be able to report a pass complete whose rows never
// landed. #10045 then made handleNeuronsSync skip the D1 write outright once
// Neon owned the snapshot, and the tally went with it: neurons_passes stopped
// at the exact captured_at the flip froze D1 on, ~11 passes before anyone
// looked. The invariant that made the tally trustworthy is what carried it off
// the cliff.
//
// So the two things worth asserting are (1) the statement is a real Postgres
// statement rather than a `?`-swap, and (2) the ordering invariant survived the
// move to a store that cannot express it as one batch.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  PASS_TABLES,
  writePassTallyToNeon,
  type PassTallyInput,
} from "../src/pass-completeness.ts";
import { mirrorNeuronSnapshotToNeon } from "../src/neurons-neon-write.ts";

const PASS: PassTallyInput = {
  capturedAt: 1786155508717,
  expectedRows: 30118,
  receivedRows: 2500,
  nowMs: 1786155548405,
};

/** Records what was sent without a database. */
function recordingSql(fail?: string) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (fail) throw new Error(fail);
        return [];
      },
    },
  };
}

describe("writePassTallyToNeon", () => {
  test("every parameter that feeds a comparison is cast", async () => {
    // THE REASON THIS IS ASSERTED ON THE TEXT. Inside a VALUES list Postgres
    // infers a parameter's type from its target column, and completed_at is
    // filled by a CASE whose operands are parameters -- a comparison offers
    // nothing to infer from, so they resolve to text. Verified against a real
    // branch: the uncast form is REJECTED with `column "completed_at" is of
    // type bigint but expression is of type text`.
    //
    // It failing loudly is luck, not design. `'9' >= '100'` is TRUE as text and
    // FALSE as integer, so the same shape somewhere Postgres can coerce would
    // stamp an incomplete pass complete and never say so.
    const { calls, sql } = recordingSql();
    await writePassTallyToNeon(sql, "neurons", PASS);
    const { text } = calls[0]!;
    for (const cast of [
      "$1::bigint",
      "$2::int",
      "$3::int",
      "$4::int",
      "$5::int",
      "$6::bigint",
      "$7::bigint",
    ]) {
      assert.ok(text.includes(cast), `missing cast ${cast}`);
    }
    // No bare `?` survived the port.
    assert.equal(text.includes("?"), false);
  });

  test("the accumulate-and-never-un-complete semantics are in the statement", async () => {
    const { calls, sql } = recordingSql();
    await writePassTallyToNeon(sql, "neurons", PASS);
    const { text, values } = calls[0]!;
    // received_rows ACCUMULATES rather than being replaced: chunks of one pass
    // arrive separately.
    assert.ok(
      text.includes("neurons_passes.received_rows + EXCLUDED.received_rows"),
    );
    // COALESCE, so the first write that closes the gap owns the stamp and a
    // replay cannot move or clear it.
    assert.ok(
      text.includes("COALESCE(\n           neurons_passes.completed_at"),
    );
    // `>=`, never `=`: the transport is at-least-once, so a replayed chunk can
    // push the total past expected and an equality check would call a finished
    // pass unfinished.
    assert.ok(text.includes(">= EXCLUDED.expected_rows"));
    assert.deepEqual(values, [
      PASS.capturedAt,
      PASS.expectedRows,
      PASS.receivedRows,
      PASS.receivedRows,
      PASS.expectedRows,
      PASS.nowMs,
      PASS.nowMs,
    ]);
  });

  test("the table comes from the allowlist, never from the lane name", async () => {
    // The table is interpolated -- Postgres has no placeholder for an
    // identifier -- so an unknown lane must not reach the SQL.
    const { sql } = recordingSql();
    await assert.rejects(
      () => writePassTallyToNeon(sql, "'; DROP TABLE neurons_passes; --", PASS),
      /no pass table for lane/,
    );
  });

  test("a failed write is reported, not thrown", async () => {
    const { sql } = recordingSql("connection reset");
    const out = await writePassTallyToNeon(sql, "neurons", PASS);
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /connection reset/);
  });

  test("every lane in PASS_TABLES can actually be written", async () => {
    // The coupling that caused this issue in the first place, asserted: a lane
    // added to the allowlist with no Neon writer behind it is a ledger that
    // silently stops the day its lane inverts.
    for (const lane of Object.keys(PASS_TABLES)) {
      const { calls, sql } = recordingSql();
      const out = await writePassTallyToNeon(sql, lane, PASS);
      assert.equal(out.ok, true, `${lane} did not write`);
      assert.ok(
        calls[0]!.text.includes(`INSERT INTO ${PASS_TABLES[lane]}`),
        `${lane} wrote the wrong table`,
      );
    }
  });
});

describe("the tally travels with the rows (the #10056 invariant)", () => {
  const env = {
    HYPERDRIVE: { connectionString: "postgresql://example/db" },
  };
  const ctx = { waitUntil: () => undefined } as never;
  const input = {
    rows: [{ netuid: 1, uid: 0, captured_at: 1 }],
    dailyRows: [],
    positionRows: [],
  };

  test("a pass is tallied once every table landed", async () => {
    const { calls, sql } = recordingSql();
    const out = await mirrorNeuronSnapshotToNeon(
      env,
      ctx,
      { ...input, pass: PASS },
      { sql, laneHealthDb: null },
    );
    assert.equal(out.results.neurons_passes?.ok, true);
    assert.ok(
      calls.some((c) => c.text.includes("INSERT INTO neurons_passes")),
      "the tally never reached Neon",
    );
    // LAST. The rows it describes must be in the store before it claims they
    // are.
    const tallyAt = calls.findIndex((c) =>
      c.text.includes("INSERT INTO neurons_passes"),
    );
    const lastRowAt = calls.reduce(
      (n, c, i) => (c.text.includes("INSERT INTO neurons ") ? i : n),
      -1,
    );
    // Pinned so the comparison cannot pass on nothing: if the row insert ever
    // stops matching, lastRowAt would sit at -1 and `tallyAt > -1` would be
    // true for any ordering at all. The trailing space is what keeps
    // `neurons ` from also matching `neurons_passes`.
    assert.ok(
      lastRowAt >= 0,
      "no neurons row insert was observed to order against",
    );
    assert.ok(tallyAt > lastRowAt, "the tally was written before its rows");
  });

  test("NO pass is tallied when a table failed", async () => {
    // The whole point. A tally over rows that did not land is never revisited,
    // whereas withholding it costs nothing: the next chunk re-sends its rows
    // and the pass completes then.
    const { calls, sql } = recordingSql("neon exploded");
    const out = await mirrorNeuronSnapshotToNeon(
      env,
      ctx,
      { ...input, pass: PASS },
      { sql, laneHealthDb: null },
    );
    assert.equal(out.results.neurons_passes?.ok, false);
    assert.match(out.results.neurons_passes?.reason ?? "", /tally withheld/);
    assert.equal(
      calls.some((c) => c.text.includes("INSERT INTO neurons_passes")),
      false,
      "a tally was written for rows that never landed",
    );
  });

  test("no pass declared means no tally, not an empty one", async () => {
    const { calls, sql } = recordingSql();
    const out = await mirrorNeuronSnapshotToNeon(
      env,
      ctx,
      { ...input, pass: null },
      { sql, laneHealthDb: null },
    );
    assert.equal(out.results.neurons_passes, undefined);
    assert.equal(
      calls.some((c) => c.text.includes("neurons_passes")),
      false,
    );
  });
});
