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
import { beforeEach, describe, test } from "vitest";
import {
  buildPgUpsert,
  PG_PARAM_BUDGET,
  PG_PARAM_LIMIT,
  pgFlatValues,
  pgValuesClause,
  NEON_WRITE_VERDICT_COALESCE_MS,
  recordNeonWriteVerdict,
  resetNeonWriteVerdictMemo,
  rowsPerPgStatement,
  shouldWriteNeonWriteVerdict,
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

describe("buildPgUpsert with a filter (#9832)", () => {
  test("switches the row source to a SELECT so a predicate can reject rows", () => {
    const text = buildPgUpsert(
      "hotkey_alpha",
      ["hotkey", "netuid", "total_alpha", "captured_at"],
      ["hotkey", "netuid"],
      2,
      "hotkey_alpha.captured_at < EXCLUDED.captured_at",
      "EXISTS (SELECT 1 FROM nominator_positions np WHERE np.hotkey = src.hotkey AND np.netuid = src.netuid)",
    );
    // The rows arrive as a VALUES list aliased `src`, and the predicate reads
    // its columns by name -- the Postgres spelling of the EXISTS the D1 writer
    // has passed to chunkStatements since #9558.
    assert.match(
      text,
      /FROM \(VALUES .*\) AS src \(hotkey, netuid, total_alpha, captured_at\)/,
    );
    assert.match(text, /WHERE EXISTS \(SELECT 1 FROM nominator_positions/);
    // The conflict clause and the out-of-order guard survive the switch.
    assert.match(text, /ON CONFLICT \(hotkey, netuid\) DO UPDATE SET/);
    assert.match(
      text,
      /WHERE hotkey_alpha\.captured_at < EXCLUDED\.captured_at/,
    );
  });

  test("placeholder count is unchanged, so the caller's values still line up", () => {
    const cols = ["a", "b"];
    const plain = buildPgUpsert("t", cols, ["a"], 3);
    const filtered = buildPgUpsert("t", cols, ["a"], 3, undefined, "src.b > 0");
    const count = (s: string) => (s.match(/\$\d+/g) ?? []).length;
    assert.equal(count(filtered), count(plain));
    assert.equal(count(filtered), 6, "3 rows x 2 columns");
  });

  test("no filter leaves the statement exactly as it was", () => {
    // Every other lane must be untouched by this: the filtered form is opt-in
    // and only hotkey-alpha opts in.
    const cols = ["a", "b"];
    assert.equal(
      buildPgUpsert("t", cols, ["a"], 2, "t.a < EXCLUDED.a", undefined),
      buildPgUpsert("t", cols, ["a"], 2, "t.a < EXCLUDED.a"),
    );
    assert.match(buildPgUpsert("t", cols, ["a"], 2), /VALUES \(\$1, \$2\)/);
    assert.doesNotMatch(buildPgUpsert("t", cols, ["a"], 2), /SELECT/);
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
  // The coalescing memo is module-level and every test here shares one frozen
  // clock, so without this a later test's unchanged `ok` reads as unwritten.
  beforeEach(resetNeonWriteVerdictMemo);

  function spy() {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) {
            rows.push({
              lane: values[0],
              verdict: values[1],
              age_ms: values[2],
              detail: values[3],
            });
          }
          return { changes: 1 };
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

describe("shouldWriteNeonWriteVerdict", () => {
  // The POLICY, asserted directly rather than inferred from a mock's call
  // count. What matters is not that writes get skipped -- it is exactly WHICH
  // ones never can.
  const PREV_OK = { verdict: "ok" as const, checkedAt: NOW };

  test("a failure always writes, however often it repeats", () => {
    // Failures are rare, so they cost no volume, and their detail carries the
    // reason triage needs. Withholding it for the window would trade the only
    // thing worth having for nothing.
    assert.equal(
      shouldWriteNeonWriteVerdict(
        { verdict: "stale", checkedAt: NOW },
        "stale",
        NOW + 1,
      ),
      true,
    );
  });

  test("a lane this isolate has not seen writes", () => {
    assert.equal(shouldWriteNeonWriteVerdict(undefined, "ok", NOW), true);
  });

  test("a RECOVERY writes immediately, not on the next heartbeat", () => {
    // stale -> ok is a transition, and a transition delayed is a transition
    // suppressed.
    assert.equal(
      shouldWriteNeonWriteVerdict(
        { verdict: "stale", checkedAt: NOW },
        "ok",
        NOW + 1,
      ),
      true,
    );
  });

  test("a clock that moved backwards writes rather than guessing", () => {
    // A replay, a fixed clock, or two isolates disagreeing. Unknown state
    // resolves to "write", never to "skip".
    assert.equal(shouldWriteNeonWriteVerdict(PREV_OK, "ok", NOW - 1), true);
  });

  test("an unchanged ok inside the window does NOT write", () => {
    assert.equal(
      shouldWriteNeonWriteVerdict(
        PREV_OK,
        "ok",
        NOW + NEON_WRITE_VERDICT_COALESCE_MS - 1,
      ),
      false,
    );
  });

  test("an unchanged ok AT the window writes -- the heartbeat", () => {
    // Boundary is inclusive, so a lane cannot drift past its own freshness
    // bound by repeatedly landing one millisecond short of it.
    assert.equal(
      shouldWriteNeonWriteVerdict(
        PREV_OK,
        "ok",
        NOW + NEON_WRITE_VERDICT_COALESCE_MS,
      ),
      true,
    );
  });

  test("the window is twelve heartbeats inside lane_health's own bound", () => {
    // src/table-freshness-watchdog.ts holds lane_health to 2 * HOUR. If this
    // ever exceeds that, a healthy lane starts tripping its own watchdog.
    assert.ok(NEON_WRITE_VERDICT_COALESCE_MS * 12 <= 2 * 60 * 60 * 1000);
  });
});

describe("verdict coalescing, end to end", () => {
  beforeEach(resetNeonWriteVerdictMemo);

  function countingDb() {
    const inserts: Record<string, unknown>[] = [];
    return {
      inserts,
      db: {
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT"))
            inserts.push({ lane: values[0], verdict: values[1] });
          return { changes: 1 };
        },
      },
    };
  }

  test("a repeated ok costs ONE row, not one per write", async () => {
    const s = countingDb();
    for (let i = 0; i < 50; i += 1) {
      await recordNeonWriteVerdict(
        s.db,
        "blocks-head",
        { ok: true, rows: 1, statements: 1 },
        NOW + i * 1000,
      );
    }
    assert.equal(s.inserts.length, 1);
  });

  test("and reports true while coalescing -- the verdict IS on record", async () => {
    // `false` means "not on record". Every call site awaits this bare today,
    // so nothing would catch a wrong value until the first caller reads it as
    // health -- which is why it has to be right before one does.
    const s = countingDb();
    const first = await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW,
    );
    const second = await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW + 1000,
    );
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(s.inserts.length, 1);
  });

  test("a failure lands even between two coalesced oks", async () => {
    const s = countingDb();
    await recordNeonWriteVerdict(
      s.db,
      "chain-detail",
      { ok: true, rows: 1, statements: 1 },
      NOW,
    );
    await recordNeonWriteVerdict(
      s.db,
      "chain-detail",
      { ok: false, rows: 0, statements: 0, reason: "deadlock" },
      NOW + 1000,
    );
    await recordNeonWriteVerdict(
      s.db,
      "chain-detail",
      { ok: true, rows: 1, statements: 1 },
      NOW + 2000,
    );
    assert.deepEqual(
      s.inserts.map((r) => r.verdict),
      ["ok", "stale", "ok"],
    );
  });

  test("a write that did NOT land cannot suppress the next one", async () => {
    // Recording the attempt rather than the landing would let a database
    // outage silence the lane for the whole window -- the lane going quiet at
    // precisely the moment it matters most.
    const s = countingDb();
    assert.equal(
      await recordNeonWriteVerdict(
        null,
        "blocks-head",
        { ok: true, rows: 1, statements: 1 },
        NOW,
      ),
      false,
    );
    await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW + 1000,
    );
    assert.equal(s.inserts.length, 1);
  });

  test("lanes coalesce independently of one another", async () => {
    const s = countingDb();
    for (const lane of ["blocks-head", "chain-detail", "account-balances"]) {
      await recordNeonWriteVerdict(
        s.db,
        lane,
        { ok: true, rows: 1, statements: 1 },
        NOW,
      );
    }
    assert.deepEqual(
      s.inserts.map((r) => r.lane),
      ["neon:blocks-head", "neon:chain-detail", "neon:account-balances"],
    );
  });

  test("the memo reset makes the next verdict unconditional", async () => {
    const s = countingDb();
    await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW,
    );
    resetNeonWriteVerdictMemo();
    await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW + 1000,
    );
    assert.equal(s.inserts.length, 2);
  });
});

describe("a buffered lane's enqueue-time verdict", () => {
  beforeEach(resetNeonWriteVerdictMemo);

  function countingDb() {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT"))
            rows.push({ lane: values[0], verdict: values[1] });
          return { changes: 1 };
        },
      },
    };
  }

  test("a buffered SUCCESS records nothing -- the flush owns that verdict", async () => {
    // ~758 rows/hour of bookkeeping saying "ok" about rows that are enqueued
    // and not yet in Neon. The flush records the honest per-lane verdict once
    // it has actually written them.
    const s = countingDb();
    const landed = await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: true, rows: 30_000, statements: 11 },
      NOW,
      true,
    );
    assert.equal(landed, true, "the caller is not told this failed");
    assert.deepEqual(s.rows, []);
  });

  test("a buffered ONCE-PER-PASS success records, so its verdict can be cleared", async () => {
    // #10826. The suppression above is safe only because the flush records an
    // honest verdict for that lane later. It does not for `-pass` and `-prune`:
    // they share the base lane's buffered runner, so the flush's per-lane tally
    // NEVER names them, and a suppressed success here can be recorded by
    // nothing at all.
    //
    // Measured on production 2026-08-11: `neon:nominator-positions-prune` and
    // `-pass` held "prune did not land; tally withheld" from 10:23 UTC -- one
    // Durable Object reset during a deploy -- while nominator_positions wrote
    // 123,057 rows at 11:30 and the base lane went ok. The failure verdict
    // outlived its own recovery by eight hours and the lane alarm escalated
    // over it the whole time.
    const s = countingDb();
    const landed = await recordNeonWriteVerdict(
      s.db,
      "nominator-positions-pass",
      { ok: true, rows: 1, statements: 1 },
      NOW,
      true,
      true,
    );
    assert.equal(landed, true);
    assert.deepEqual(
      s.rows,
      [{ lane: "neon:nominator-positions-pass", verdict: "ok" }],
      "a once-per-pass success must reach lane_health, or nothing can clear it",
    );
  });

  test("...and it says ENQUEUED, because that is what is true at that point", async () => {
    // The reason #10690 suppressed these in the first place: at enqueue time
    // the rows are in the buffer, not in Neon. Recording the verdict is what
    // makes the lane clearable; claiming the rows LANDED would be the overclaim
    // that argument correctly refused. Both can hold at once, and the detail is
    // where the distinction lives.
    const details: string[] = [];
    const db = {
      query: async () => [],
      async run(sql: string, values: unknown[] = []) {
        if (sql.startsWith("INSERT")) details.push(String(values[3]));
        return { changes: 1 };
      },
    };
    await recordNeonWriteVerdict(
      db,
      "nominator-positions-prune",
      { ok: true, rows: 1, statements: 1 },
      NOW,
      true,
      true,
    );
    assert.equal(details.length, 1);
    assert.match(details[0]!, /enqueued/);
    assert.doesNotMatch(
      details[0]!,
      /^1 row\(s\) in /,
      "an enqueued write must not be reported as landed",
    );
  });

  test("a buffered FAILURE still records -- nothing else reports backpressure", async () => {
    // ok:false here is the ENQUEUE being refused (buffer full, DO unreachable).
    // The flush cannot report it: those rows never reached the flush. This is
    // the one path where suppressing would go quiet exactly when it matters.
    const s = countingDb();
    await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: false, rows: 0, statements: 0, reason: "buffer full" },
      NOW,
      true,
    );
    assert.deepEqual(
      s.rows.map((r) => [r.lane, r.verdict]),
      [["neon:neurons", "stale"]],
    );
  });

  test("an UNBUFFERED lane is unchanged", async () => {
    // blocks-head and chain-detail stay direct, so their verdicts must keep
    // reporting exactly as before.
    const s = countingDb();
    await recordNeonWriteVerdict(
      s.db,
      "blocks-head",
      { ok: true, rows: 1, statements: 1 },
      NOW,
    );
    assert.equal(s.rows.length, 1);
  });

  test("a buffered success does not poison the coalescing memo", async () => {
    // It records nothing, so it must also not remember having recorded --
    // otherwise the next DIRECT write on that lane would be coalesced away
    // against a row that was never written.
    const s = countingDb();
    await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: true, rows: 1, statements: 1 },
      NOW,
      true,
    );
    await recordNeonWriteVerdict(
      s.db,
      "neurons",
      { ok: true, rows: 1, statements: 1 },
      NOW + 1000,
    );
    assert.equal(s.rows.length, 1, "the direct write must still land");
  });
});
