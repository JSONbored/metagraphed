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
import { beforeEach, describe, test } from "vitest";
import {
  mirrorNominatorPositionsToNeon,
  NOMINATOR_POSITIONS_CONFLICT,
  NOMINATOR_POSITIONS_NEON_LANE,
} from "../src/nominator-positions-neon-write.ts";
import {
  normalizeShareFractionsInNeon,
  pruneCardOutsideKeySet,
  pruneKeysInNeon,
  resetNeonWriteVerdictMemo,
} from "../src/neon-write.ts";

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

// recordNeonWriteVerdict coalesces an unchanged `ok` for ten minutes, keyed per
// lane in MODULE state. Without this reset a test's verdicts depend on which
// tests ran before it in the same file -- the base and prune rows vanish from
// the middle of the suite and reappear when the test is run alone, which is
// exactly how this was found.
beforeEach(resetNeonWriteVerdictMemo);

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

describe("pruneCardOutsideKeySet", () => {
  // The OTHER prune shape (#10836). pruneKeysInNeon above deletes per key
  // against that key's own cutoff, because its producer posts in chunks. This
  // one deletes everything OUTSIDE a key set, which is only correct because
  // its producer posts the whole population in one request.
  test("deletes rows whose key this pass did not carry", async () => {
    const sql = fakeSql();
    const result = await pruneCardOutsideKeySet(
      sql,
      "subnet_ownership",
      "netuid",
      [1, 2, 3],
    );
    assert.deepEqual(result, { ok: true, rows: 3, statements: 1 });
    assert.equal(sql.calls.length, 1);
    assert.equal(
      sql.calls[0]!.text,
      "DELETE FROM subnet_ownership WHERE netuid <> ALL($1::int[])",
    );
    assert.deepEqual(sql.calls[0]!.values, [[1, 2, 3]]);
  });

  test("an EMPTY key set deletes nothing, and says why", async () => {
    // THE SAFETY PROPERTY, not a convenience. `WHERE netuid <> ALL('{}')` is
    // TRUE for every row, so an empty set means "delete the entire table" --
    // which is exactly what a pass that resolved nothing would ask for.
    // Measured against production while designing this: the empty form would
    // have deleted all 128 rows of subnet_ownership.
    const sql = fakeSql();
    const result = await pruneCardOutsideKeySet(sql, "t", "netuid", []);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 0);
    assert.match(String(result.reason), /empty key set/);
    assert.equal(sql.calls.length, 0);
  });

  test("the cast is written out, so validate:pg-json-binds can see it", async () => {
    // Not decoration. That gate exempts an array bind by reading the STATEMENT
    // for `::<type>[]`; an earlier cut assembled the cast from a parameter,
    // which made it invisible and the gate flagged this as the JSON-bind bug.
    // A cast that only exists at runtime is a cast the gate cannot check.
    const sql = fakeSql();
    await pruneCardOutsideKeySet(sql, "t", "k", [1]);
    assert.match(sql.calls[0]!.text, /::int\[\]/);
  });

  test("an unbound runner and a failing delete are both reported", async () => {
    assert.equal(
      (await pruneCardOutsideKeySet(null, "t", "k", [1])).reason,
      "unbound",
    );
    const failed = await pruneCardOutsideKeySet(
      fakeSql("delete"),
      "t",
      "k",
      [1],
    );
    assert.equal(failed.ok, false);
    assert.match(String(failed.reason), /deadlock/);
  });

  test("a non-Error throw is still reported as a reason", async () => {
    const sql = {
      async unsafe() {
        throw "connection terminated";
      },
    };
    assert.equal(
      (await pruneCardOutsideKeySet(sql, "t", "k", [1])).reason,
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

  test("normalises AFTER the prune and BEFORE the tally (metagraphed-infra#414)", async () => {
    // The order is the correctness claim, not tidiness. Normalising before the
    // prune divides by a denominator that still includes superseded rows;
    // tallying before the normalisation declares a pass whole whose fractions
    // have not been re-derived.
    const sql = fakeSql();
    const spy = laneSpy();
    const out = await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      {
        rows,
        coldkeyMaxCapturedAt: cutoffs,
        pass: {
          capturedAt: NOW,
          expectedRows: rows.length,
          receivedRows: rows.length,
          nowMs: NOW,
        },
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(out.prune?.ok, true);
    const kinds = sql.calls.map((call) => call.text.split(" ")[0]);
    assert.deepEqual(
      kinds,
      ["INSERT", "DELETE", "UPDATE", "INSERT"],
      `expected upsert, prune, normalise, tally -- got ${kinds.join(", ")}`,
    );
    assert.deepEqual(
      spy.rows.map((r) => r.lane),
      [
        "neon:nominator-positions",
        "neon:nominator-positions-prune",
        "neon:nominator-positions-normalize",
        "neon:nominator-positions-pass",
      ],
    );
  });

  test("does NOT normalise when the prune failed", async () => {
    // Same reason the tally is withheld: the table still holds superseded rows,
    // so any pool total computed over it is wrong. Recomputing fractions there
    // would overwrite correct producer-side values with ones divided by a
    // denominator that includes rows the prune was supposed to remove.
    const sql = fakeSql("delete");
    const spy = laneSpy();
    await mirrorNominatorPositionsToNeon(
      on,
      ctx,
      {
        rows,
        coldkeyMaxCapturedAt: cutoffs,
        pass: {
          capturedAt: NOW,
          expectedRows: rows.length,
          receivedRows: rows.length,
          nowMs: NOW,
        },
      },
      { sql, laneHealthDb: spy.db, now: () => NOW },
    );
    assert.equal(
      sql.calls.filter((call) => call.text.startsWith("UPDATE")).length,
      0,
      "a failed prune must not be followed by a normalisation",
    );
    assert.ok(
      !spy.rows.some((r) => r.lane === "neon:nominator-positions-normalize"),
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

// --- the tally is REPORTED, not merely written (#10109) ---------------------
//
// It was written and dropped on the floor. That was survivable while D1 held
// the ledger; once this lane is Neon's, nominator_positions_passes has NO
// other writer, so a caller that cannot see the tally failed will answer ok
// over an empty completeness ledger -- the one table whose whole job is to say
// whether a pass was complete.
test("the outcome carries the pass result", async () => {
  const sql = fakeSql();
  const out = await mirrorNominatorPositionsToNeon(
    { NEON_DUAL_WRITE_LANES: "nominator-positions" },
    { waitUntil: () => undefined },
    {
      rows,
      coldkeyMaxCapturedAt: new Map(),
      pass: { expectedRows: 1, receivedRows: 1, capturedAt: 1, nowMs: NOW },
    },
    { sql, laneHealthDb: null },
  );
  assert.equal(out.pass?.ok, true);
});

test("a withheld tally is reported as failed, not as absent", async () => {
  // `prune did not land; tally withheld` is a FAILURE the caller must see. An
  // undefined pass would read as "this batch declared none", which is a
  // legitimate state and would let the 502 be skipped.
  const sql = fakeSql("delete");
  const out = await mirrorNominatorPositionsToNeon(
    { NEON_DUAL_WRITE_LANES: "nominator-positions" },
    { waitUntil: () => undefined },
    {
      rows,
      coldkeyMaxCapturedAt: new Map([["ck", 1]]),
      pass: { expectedRows: 1, receivedRows: 1, capturedAt: 1, nowMs: NOW },
    },
    { sql, laneHealthDb: null },
  );
  assert.equal(out.pass?.ok, false);
  assert.match(String(out.pass?.reason), /withheld/);
});

test("no declared pass leaves the result undefined", async () => {
  const sql = fakeSql();
  const out = await mirrorNominatorPositionsToNeon(
    { NEON_DUAL_WRITE_LANES: "nominator-positions" },
    { waitUntil: () => undefined },
    { rows, coldkeyMaxCapturedAt: new Map() },
    { sql, laneHealthDb: null },
  );
  assert.equal(out.pass, undefined);
});

// metagraphed-infra#414: the normalisation that lets the producer stop buffering
// the whole 762,577-row Alpha keyspace to compute a pool-relative fraction.
describe("normalizeShareFractionsInNeon", () => {
  test("divides each row's shares by its own (hotkey, netuid) pool total", async () => {
    const sql = fakeSql();
    const result = await normalizeShareFractionsInNeon(sql, NOW);
    assert.deepEqual(result, { ok: true, rows: 1, statements: 1 });
    assert.equal(sql.calls.length, 1);
    const text = sql.calls[0].text;
    // The GROUP BY is the whole correctness claim: share_fraction is this
    // coldkey's shares over ALL delegators' shares for the SAME pool, so a
    // denominator grouped on anything else publishes a plausible wrong number.
    assert.match(text, /GROUP BY hotkey, netuid/);
    assert.match(text, /SUM\(shares\) AS total/);
    assert.match(text, /p\.hotkey = t\.hotkey/);
    assert.match(text, /p\.netuid = t\.netuid/);
    // Scoped to ONE pass on both sides of the join. Without it the denominator
    // would include superseded rows the prune has not reached yet.
    assert.equal(sql.calls[0].values[0], NOW);
    assert.match(text, /p\.captured_at = \$1/);
    assert.match(text, /WHERE captured_at = \$1/);
  });

  test("skips rows with no shares, which is what makes it inert today", async () => {
    // The producer that sends shares does not exist yet. Until it does this
    // statement must match nothing and leave the fraction the producer computed
    // standing -- that property is what lets this ship ahead of the poller.
    const sql = fakeSql();
    await normalizeShareFractionsInNeon(sql, NOW);
    const text = sql.calls[0].text;
    assert.match(text, /AND shares IS NOT NULL/);
    assert.match(text, /AND p\.shares IS NOT NULL/);
  });

  test("never divides by zero", async () => {
    // A pool whose every delegator holds zero shares has no meaningful
    // fraction. Postgres raises on numeric division by zero, which would fail
    // the statement for every OTHER pool in the same pass.
    const sql = fakeSql();
    await normalizeShareFractionsInNeon(sql, NOW);
    assert.match(sql.calls[0].text, /t\.total > 0/);
  });

  test("an unusable captured_at is refused before it reaches SQL", async () => {
    // `captured_at = NaN` would match no rows and report success, which reads as
    // "normalised" for a pass that was not.
    const sql = fakeSql();
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const result = await normalizeShareFractionsInNeon(sql, bad);
      assert.equal(result.ok, false, String(bad));
      assert.match(String(result.reason), /unusable captured_at/);
    }
    assert.deepEqual(sql.calls, [], "nothing may reach the database");
  });

  test("an unbound store declines rather than throwing", async () => {
    assert.deepEqual(await normalizeShareFractionsInNeon(null, NOW), {
      ok: false,
      rows: 0,
      statements: 0,
      reason: "unbound",
    });
  });

  test("a failed statement is a reason, not an exception", async () => {
    // The caller treats this as non-fatal: the rows are correct, just not
    // re-derived. It must therefore report rather than throw.
    const sql = {
      async unsafe() {
        throw new Error("deadlock detected");
      },
    };
    const result = await normalizeShareFractionsInNeon(sql, NOW);
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /deadlock detected/);
  });
});
