// Bulk writes into Neon (src/neon-write.ts, metagraphed-infra#336).
//
// The load-bearing properties, all of them shaped by how the pilot broke:
//
//   * PLACEHOLDER NUMBERING. Postgres binds positionally and an off-by-one does
//     not throw -- it writes the wrong column, confidently. The built text is
//     asserted directly for that reason.
//   * A FAILED WRITE MUST SAY HOW MUCH LANDED, because "3 of 4 chunks" and
//     "0 of 4" are different outages.
//   * EVERY ATTEMPT RECORDS A LANE VERDICT. A store with no lane is invisible
//     to #9698's reader, which is exactly how a frozen Neon served the public
//     API for two days.
//   * THE FLAG DEFAULTS OFF. A flag defaulting on would repeat the pilot's
//     failure on the very deploy that introduced it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildPgUpsert,
  neonDualWriteEnabled,
  neonDualWriteLanes,
  neonReadEnabled,
  neonReadLanes,
  PG_PARAM_BUDGET,
  PG_PARAM_LIMIT,
  pgFlatValues,
  pgValuesClause,
  recordNeonWriteVerdict,
  rowsPerPgStatement,
  writeRowsToNeon,
} from "../src/neon-write.ts";

const NOW = 1_785_800_000_000;

/** A Postgres runner double: records every statement, or fails on demand. */
function fakeSql(failOn: number | null = null) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async unsafe(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failOn !== null && calls.length === failOn) {
        throw new Error("duplicate key value violates unique constraint");
      }
      return [];
    },
  };
}

describe("pgValuesClause", () => {
  test("numbers placeholders across rows, 1-based and continuous", () => {
    // The contract. A wrong number here binds a value to the wrong column
    // rather than failing, so this is asserted as text.
    assert.equal(pgValuesClause(3, 2), "($1, $2), ($3, $4), ($5, $6)");
  });

  test("a single row of a single column is `($1)`", () => {
    assert.equal(pgValuesClause(1, 1), "($1)");
  });

  test("no rows produces no groups", () => {
    assert.equal(pgValuesClause(0, 4), "");
  });
});

describe("rowsPerPgStatement", () => {
  test("fills the budget without exceeding the protocol ceiling", () => {
    const columns = 22;
    const rows = rowsPerPgStatement(columns);
    assert.ok(rows * columns <= PG_PARAM_BUDGET);
    assert.ok(
      rows * columns > PG_PARAM_BUDGET - columns,
      "must not waste room",
    );
    // And comfortably inside the real wire limit, with the headroom intact.
    assert.ok(rows * columns < PG_PARAM_LIMIT);
  });

  test("beats D1's batching by three orders of magnitude", () => {
    // The reason this file exists rather than reusing neurons-d1-write.ts:
    // D1 caps a statement at 100 parameters, so a 22-column write gets four
    // rows. The JSON smuggling there is a workaround for a limit Postgres
    // does not have.
    assert.ok(rowsPerPgStatement(22) > 2_000);
  });

  test("never returns zero, whatever it is handed", () => {
    // A zero would write nothing and report success. A row wider than the
    // budget instead gets its own statement, so Postgres names the real
    // problem.
    assert.equal(rowsPerPgStatement(0), 1);
    assert.equal(rowsPerPgStatement(-5), 1);
    assert.equal(rowsPerPgStatement(PG_PARAM_BUDGET * 2), 1);
  });
});

describe("buildPgUpsert", () => {
  const columns = ["netuid", "uid", "stake_tao"] as const;

  test("a plain append when nothing conflicts", () => {
    assert.equal(
      buildPgUpsert("neurons", columns, [], 2),
      "INSERT INTO neurons (netuid, uid, stake_tao) VALUES ($1, $2, $3), ($4, $5, $6)",
    );
  });

  test("updates exactly the non-key columns", () => {
    assert.equal(
      buildPgUpsert("neurons", columns, ["netuid", "uid"], 1),
      "INSERT INTO neurons (netuid, uid, stake_tao) VALUES ($1, $2, $3) " +
        "ON CONFLICT (netuid, uid) DO UPDATE SET stake_tao = EXCLUDED.stake_tao",
    );
  });

  test("DO NOTHING when every column is part of the key", () => {
    // An empty SET is a syntax error, and this shape is reachable: a pure
    // membership table has no non-key columns.
    assert.equal(
      buildPgUpsert("t", ["a", "b"], ["a", "b"], 1),
      "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT (a, b) DO NOTHING",
    );
  });

  test("carries the out-of-order guard onto the update", () => {
    // The Postgres spelling of what buildUpsert does in D1: an older capture
    // arriving after a newer one must be a no-op, not a regression. Two lanes
    // here retry, so this is a real event.
    const sql = buildPgUpsert(
      "neurons",
      columns,
      ["netuid", "uid"],
      1,
      "neurons.captured_at < EXCLUDED.captured_at",
    );
    assert.ok(
      sql.endsWith(" WHERE neurons.captured_at < EXCLUDED.captured_at"),
    );
  });
});

describe("pgFlatValues", () => {
  test("flattens in column order, not key order", () => {
    // Row key order is whatever the producer happened to build; the parameter
    // order must follow the COLUMN list or every value lands one column off.
    assert.deepEqual(
      pgFlatValues(
        [
          { b: 2, a: 1 },
          { a: 3, b: 4 },
        ],
        ["a", "b"],
      ),
      [1, 2, 3, 4],
    );
  });

  test("normalises a missing key to null rather than undefined", () => {
    // `pg` rejects undefined outright. A row missing an optional column is an
    // ordinary shape here, not an error.
    assert.deepEqual(pgFlatValues([{ a: 1 }], ["a", "b"]), [1, null]);
  });

  test("keeps a real zero and a real false", () => {
    // The `?? null` mistake this repo keeps catching: zero and false are
    // measurements, and erasing them loses exactly the rows worth having.
    assert.deepEqual(pgFlatValues([{ a: 0, b: false }], ["a", "b"]), [
      0,
      false,
    ]);
  });
});

describe("writeRowsToNeon", () => {
  test("writes one statement when the rows fit", async () => {
    const sql = fakeSql();
    const result = await writeRowsToNeon(
      sql,
      "neurons",
      ["netuid", "uid"],
      [
        { netuid: 1, uid: 2 },
        { netuid: 1, uid: 3 },
      ],
      ["netuid", "uid"],
    );
    assert.deepEqual(result, { ok: true, rows: 2, statements: 1 });
    assert.equal(sql.calls.length, 1);
    assert.deepEqual(sql.calls[0].values, [1, 2, 1, 3]);
  });

  test("chunks to the parameter budget", async () => {
    const sql = fakeSql();
    const columns = Array.from({ length: 22 }, (_, i) => `c${i}`);
    const perStatement = rowsPerPgStatement(columns.length);
    const rows = Array.from({ length: perStatement + 5 }, () =>
      Object.fromEntries(columns.map((c) => [c, 1])),
    );
    const result = await writeRowsToNeon(sql, "t", columns, rows);
    assert.equal(result.statements, 2);
    assert.equal(result.rows, rows.length);
    for (const call of sql.calls) {
      assert.ok(call.values.length <= PG_PARAM_BUDGET);
    }
  });

  test("stops at the first failed chunk and says how much landed", async () => {
    // Unlike the poller's chunked POST, where each chunk was an independent
    // set of netuids. Here every chunk is part of one write into one table, so
    // continuing would leave a partial state the row count calls nearly whole.
    const sql = fakeSql(2);
    const columns = Array.from({ length: 22 }, (_, i) => `c${i}`);
    const perStatement = rowsPerPgStatement(columns.length);
    const rows = Array.from({ length: perStatement * 3 }, () =>
      Object.fromEntries(columns.map((c) => [c, 1])),
    );
    const result = await writeRowsToNeon(sql, "t", columns, rows);
    assert.equal(result.ok, false);
    assert.equal(result.rows, perStatement, "the first chunk did land");
    assert.equal(result.statements, 1);
    assert.match(String(result.reason), /unique constraint/);
    assert.equal(
      sql.calls.length,
      2,
      "it stopped rather than trying the third",
    );
  });

  test("an unbound runner is reported, not thrown", async () => {
    // During dual-write the D1 write is the one routes read, so a Neon problem
    // must cost a mirror and a lane verdict -- never the pass.
    assert.deepEqual(await writeRowsToNeon(null, "t", ["a"], [{ a: 1 }]), {
      ok: false,
      rows: 0,
      statements: 0,
      reason: "unbound",
    });
    assert.deepEqual(
      await writeRowsToNeon({} as never, "t", ["a"], [{ a: 1 }]),
      { ok: false, rows: 0, statements: 0, reason: "unbound" },
    );
  });

  test("no rows is a success that touched nothing", async () => {
    const sql = fakeSql();
    assert.deepEqual(await writeRowsToNeon(sql, "t", ["a"], []), {
      ok: true,
      rows: 0,
      statements: 0,
    });
    assert.equal(sql.calls.length, 0);
  });

  test("no columns is a refusal, not an empty INSERT", async () => {
    const sql = fakeSql();
    const result = await writeRowsToNeon(sql, "t", [], [{ a: 1 }]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_columns");
    assert.equal(sql.calls.length, 0);
  });

  test("a non-Error rejection still produces a readable reason", async () => {
    const sql = {
      async unsafe() {
        throw "connection terminated";
      },
    };
    const result = await writeRowsToNeon(sql, "t", ["a"], [{ a: 1 }]);
    assert.equal(result.reason, "connection terminated");
  });
});

describe("recordNeonWriteVerdict", () => {
  function spy() {
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
                    rows.push({
                      lane: values[0],
                      verdict: values[1],
                      age_ms: values[2],
                      detail: values[3],
                    });
                  }
                },
              };
            },
          };
        },
      },
    };
  }

  test("a successful write records ok, namespaced by store", async () => {
    // The lane name carries the STORE, so `neon:neurons` and the D1 lane can
    // both be stale independently and be told apart in one glance at the table.
    const s = spy();
    await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: true, rows: 30_109, statements: 11 },
      NOW,
    );
    assert.equal(s.rows[0].lane, "neon:neurons");
    assert.equal(s.rows[0].verdict, "ok");
    assert.equal(s.rows[0].detail, "30109 row(s) in 11 statement(s)");
  });

  test("a failed write records stale and how much landed first", async () => {
    const s = spy();
    await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: false, rows: 2_978, statements: 1, reason: "deadlock detected" },
      NOW,
    );
    assert.equal(s.rows[0].verdict, "stale");
    assert.match(
      String(s.rows[0].detail),
      /2978 row\(s\) written before failure/,
    );
    assert.match(String(s.rows[0].detail), /deadlock detected/);
  });

  test("age_ms is null rather than a fabricated number", async () => {
    // A write outcome has no meaningful "how far behind". Inventing one puts a
    // made-up value in the column triage reads.
    const s = spy();
    await recordNeonWriteVerdict(
      s.db,
      "x",
      { ok: true, rows: 1, statements: 1 },
      NOW,
    );
    assert.equal(s.rows[0].age_ms, null);
  });

  test("names the reason as unknown rather than omitting it", async () => {
    const s = spy();
    await recordNeonWriteVerdict(
      s.db,
      "x",
      { ok: false, rows: 0, statements: 0 },
      NOW,
    );
    assert.match(String(s.rows[0].detail), /unknown/);
  });

  test("a missing sink is reported, never thrown", async () => {
    assert.equal(
      await recordNeonWriteVerdict(
        null,
        "x",
        { ok: true, rows: 0, statements: 0 },
        NOW,
      ),
      false,
    );
  });
});

describe("neonDualWriteLanes", () => {
  test("defaults to nothing, so the flag's own deploy changes nothing", () => {
    // The pilot's failure was a store used before it was ready. A flag that
    // defaulted on would repeat it on the deploy that introduced the flag.
    assert.deepEqual([...neonDualWriteLanes(undefined)], []);
    assert.deepEqual([...neonDualWriteLanes(null)], []);
    assert.deepEqual([...neonDualWriteLanes({})], []);
    assert.deepEqual(
      [...neonDualWriteLanes({ NEON_DUAL_WRITE_LANES: "" })],
      [],
    );
    assert.deepEqual(
      [...neonDualWriteLanes({ NEON_DUAL_WRITE_LANES: "  " })],
      [],
    );
    assert.deepEqual([...neonDualWriteLanes({ NEON_DUAL_WRITE_LANES: 7 })], []);
  });

  test("reads a comma list, tolerating spacing and empties", () => {
    assert.deepEqual(
      [
        ...neonDualWriteLanes({
          NEON_DUAL_WRITE_LANES: " neurons , ,neuron_daily ",
        }),
      ],
      ["neurons", "neuron_daily"],
    );
  });

  test("enables exactly the lanes named", () => {
    const env = { NEON_DUAL_WRITE_LANES: "neurons" };
    assert.equal(neonDualWriteEnabled(env, "neurons"), true);
    assert.equal(neonDualWriteEnabled(env, "neuron_daily"), false);
    assert.equal(neonDualWriteEnabled({}, "neurons"), false);
  });
});

describe("neonReadLanes", () => {
  test("is a SEPARATE flag from the write list", () => {
    // The conflation is what broke the pilot: the read gate was "is HYPERDRIVE
    // bound", so binding the config for a WRITE pilot silently moved a READ
    // onto a store nothing had ever written to.
    const env = { NEON_DUAL_WRITE_LANES: "neurons" };
    assert.equal(neonDualWriteEnabled(env, "neurons"), true);
    assert.equal(neonReadEnabled(env, "neurons"), false);
  });

  test("defaults to empty, so a binding alone moves nothing", () => {
    assert.deepEqual([...neonReadLanes(undefined)], []);
    assert.deepEqual([...neonReadLanes(null)], []);
    assert.deepEqual([...neonReadLanes({})], []);
    assert.deepEqual([...neonReadLanes({ NEON_READ_LANES: "" })], []);
    assert.deepEqual([...neonReadLanes({ NEON_READ_LANES: 7 })], []);
  });

  test("reads a comma list, tolerating spacing and empties", () => {
    assert.deepEqual(
      [
        ...neonReadLanes({
          NEON_READ_LANES: " account_position_daily , ,neurons ",
        }),
      ],
      ["account_position_daily", "neurons"],
    );
    assert.equal(
      neonReadEnabled(
        { NEON_READ_LANES: "account_position_daily" },
        "account_position_daily",
      ),
      true,
    );
  });
});
