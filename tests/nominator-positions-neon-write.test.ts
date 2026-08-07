// The nominator-positions Neon mirror (src/nominator-positions-neon-write.ts).
//
// This lane's distinguishing hazard is the PRUNE. It is a latest-only ledger,
// so a position that no longer exists must be deleted -- and a full scan posts
// in several requests, so a batch-wide "delete everything older than this pass"
// sweep would let one request delete rows another just wrote.
//
// The two properties that matter, both about not deleting live data:
//
//   * the cutoff is PER COLDKEY, against that coldkey's own max captured_at
//   * the prune is SKIPPED ENTIRELY when the upsert failed -- pruning against
//     rows that did not land deletes live positions and leaves nothing in
//     their place, and no retry undoes a delete
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  mirrorNominatorPositionsToNeon,
  NOMINATOR_POSITIONS_CONFLICT,
  NOMINATOR_POSITIONS_NEON_LANE,
} from "../src/nominator-positions-neon-write.ts";
import { pruneKeysInNeon } from "../src/neon-write.ts";

const NOW = 1_785_800_000_000;

function fakeSql(failOn: "insert" | "delete" | null = null) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async unsafe(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failOn === "insert" && text.startsWith("INSERT")) {
        throw new Error("duplicate key");
      }
      if (failOn === "delete" && text.startsWith("DELETE")) {
        throw new Error("deadlock detected");
      }
      return [];
    },
  };
}

function laneSpy() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) {
                  rows.push({ lane: values[0], verdict: values[1] });
                }
              },
            };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil() {} };
const rows = [
  {
    coldkey: "5A",
    hotkey: "5H",
    netuid: 1,
    share_fraction: 0.5,
    captured_at: 9,
  },
];
const cutoffs = new Map([["5A", 9]]);
const on = { NEON_DUAL_WRITE_LANES: NOMINATOR_POSITIONS_NEON_LANE };

describe("pruneKeysInNeon", () => {
  test("deletes per key against that key's own cutoff, in ONE statement", () => {
    // One statement for the whole map rather than one per key: a
    // 24,000-coldkey pass would otherwise be 24,000 round trips.
    const sql = fakeSql();
    return pruneKeysInNeon(
      sql,
      "nominator_positions",
      "coldkey",
      new Map([
        ["5A", 9],
        ["5B", 11],
      ]),
    ).then((result) => {
      assert.deepEqual(result, { ok: true, rows: 2, statements: 1 });
      assert.equal(sql.calls.length, 1);
      assert.match(
        sql.calls[0].text,
        /UNNEST\(\$1::text\[\], \$2::bigint\[\]\)/,
      );
      assert.match(sql.calls[0].text, /captured_at < cutoff\.at/);
      // Keys and cutoffs travel as parallel arrays, so the pairing is
      // positional -- a mismatch would prune one coldkey by another's clock.
      assert.deepEqual(sql.calls[0].values, [
        ["5A", "5B"],
        [9, 11],
      ]);
    });
  });

  test("an empty map touches nothing", async () => {
    const sql = fakeSql();
    assert.deepEqual(await pruneKeysInNeon(sql, "t", "k", new Map()), {
      ok: true,
      rows: 0,
      statements: 0,
    });
    assert.equal(sql.calls.length, 0);
  });

  test("an unbound runner and a failing delete are both reported", async () => {
    assert.equal(
      (await pruneKeysInNeon(null, "t", "k", cutoffs)).reason,
      "unbound",
    );
    const failed = await pruneKeysInNeon(fakeSql("delete"), "t", "k", cutoffs);
    assert.equal(failed.ok, false);
    assert.match(String(failed.reason), /deadlock/);
  });

  test("a non-Error rejection still reads", async () => {
    const sql = {
      async unsafe() {
        throw "connection terminated";
      },
    };
    assert.equal(
      (await pruneKeysInNeon(sql, "t", "k", cutoffs)).reason,
      "connection terminated",
    );
  });
});

describe("mirrorNominatorPositionsToNeon", () => {
  test("conflict key matches the table's primary key", () => {
    assert.deepEqual(NOMINATOR_POSITIONS_CONFLICT, [
      "coldkey",
      "hotkey",
      "netuid",
    ]);
  });

  test("upserts then prunes, in that order, recording both", async () => {
    const sql = fakeSql();
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.write?.ok, true);
    assert.equal(out.prune?.ok, true);
    assert.ok(sql.calls[0].text.startsWith("INSERT"));
    assert.ok(sql.calls[1].text.startsWith("DELETE"));
    assert.deepEqual(
      spy.rows.map((r) => r.lane),
      ["neon:nominator-positions", "neon:nominator-positions-prune"],
    );
  });

  test("carries the out-of-order guard, so a retry cannot regress a row", async () => {
    const sql = fakeSql();
    await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
      { sql, laneHealthDb: laneSpy().db, now: () => NOW },
    );
    assert.match(
      sql.calls[0].text,
      /WHERE nominator_positions\.captured_at < EXCLUDED\.captured_at/,
    );
  });

  test("SKIPS the prune entirely when the upsert failed", async () => {
    // The property this file exists for. Pruning against rows that did not
    // land deletes live positions and leaves nothing in their place, and no
    // retry undoes a delete.
    const sql = fakeSql("insert");
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.write?.ok, false);
    assert.equal(out.prune, undefined);
    assert.ok(
      sql.calls.every((c) => !c.text.startsWith("DELETE")),
      "no DELETE may be issued",
    );
    assert.deepEqual(
      spy.rows.map((r) => r.verdict),
      ["stale"],
    );
  });

  test("a failed prune is reported without costing the upsert", async () => {
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
      { sql: fakeSql("delete"), laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.write?.ok, true);
    assert.equal(out.prune?.ok, false);
    assert.deepEqual(
      spy.rows.map((r) => r.verdict),
      ["ok", "stale"],
    );
  });

  test("does nothing unless the lane is named", async () => {
    const sql = fakeSql();
    for (const env of [
      undefined,
      null,
      {},
      { NEON_DUAL_WRITE_LANES: "neurons" },
    ]) {
      assert.deepEqual(
        await mirrorNominatorPositionsToNeon(
          env,
          ctx,
          { rows, coldkeyMaxCapturedAt: cutoffs },
          { sql },
        ),
        { attempted: false },
      );
    }
    assert.equal(sql.calls.length, 0);
  });

  test("enabled with no binding records the misconfiguration", async () => {
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
      { sql: null, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.deepEqual(out, { attempted: true });
    assert.deepEqual(spy.rows, [
      { lane: "neon:nominator-positions", verdict: "stale" },
    ]);
  });

  test("builds its own runner from the binding, and reports a dead origin", async () => {
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      {
        ...on,
        HYPERDRIVE: { connectionString: "postgresql://u:p@127.0.0.1:1/none" },
        METAGRAPH_HEALTH_DB: spy.db,
      },
      ctx,
      { rows, coldkeyMaxCapturedAt: cutoffs },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.write?.ok, false);
    // And no prune followed the failed write.
    assert.equal(out.prune, undefined);
  });
});
