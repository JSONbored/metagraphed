// The hotkey-alpha D1 write path (#9502) and the schema it writes into.
//
// Two things are checked here and they fail in different ways. The MIGRATION
// check is anti-drift: a column the writer binds but the table lacks makes D1
// reject the whole batch, and a column the table has but the writer never
// sends is a permanently-NULL field that reads like real data -- the same
// guarantee 0017's tests/account-balances-d1-write.test.ts makes for its table.
// The WRITER checks are about the composite key and the staleness guard: this
// lane posts a ~762k-row pass across many requests, so a chunk that overran the
// binding's parameter limit would fail the whole batch, and a replayed request
// must never walk a pool total backwards.
//
// The composite key is what separates this lane from every sibling. A hotkey
// holds a SEPARATE alpha pool on every subnet it is staked to, so collapsing
// (hotkey, netuid) to (hotkey) would misprice every position on all but the
// last-written subnet -- and mispricing is the exact failure #9502 exists to
// avoid, not a smaller version of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  HOTKEY_ALPHA_INSERT_COLUMNS,
  writeHotkeyAlphaToD1,
} from "../src/hotkey-alpha-d1-write.ts";
import { D1_JSON_BUDGET_BYTES } from "../src/neurons-d1-write.ts";

const MIGRATION = readFileSync("migrations/d1/0019_hotkey_alpha.sql", "utf8");

const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

/** Column names of one CREATE TABLE block, in declaration order. */
function tableColumns(table: string): string[] {
  const match = MIGRATION.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(match, `no CREATE TABLE for ${table} in the migration`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("--") &&
        !line.startsWith("PRIMARY KEY") &&
        !line.startsWith("CHECK"),
    )
    .map((line) => line.split(/\s+/)[0]);
}

/** Records every prepared statement and its bindings, in order. */
function d1Stub() {
  const statements: { sql: string; params: unknown[] }[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const entry = { sql, params };
          statements.push(entry);
          return entry as never;
        },
      };
    },
    async batch(slice: unknown[]) {
      batches.push(slice.length);
      return [];
    },
  };
  return { statements, batches, db };
}

function row(hotkey: string, netuid: number, alpha: number, at: number) {
  return { hotkey, netuid, total_alpha: alpha, captured_at: at };
}

describe("the hotkey_alpha D1 schema matches its writer", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.equal(tableColumns("hotkey_alpha").length, 4);
  });

  test("the table holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("hotkey_alpha").sort(),
      [...HOTKEY_ALPHA_INSERT_COLUMNS].sort(),
    );
  });

  test("the upsert key is one row per (hotkey, netuid) pool", () => {
    // NOT (hotkey) alone. A delegate accrues alpha on every subnet it is
    // staked to; a single-column key would collapse those pools into one.
    assert.match(
      MIGRATION,
      /PRIMARY KEY \(hotkey, netuid\)/,
      "the PRIMARY KEY must be the same key the writer declares as its conflict target",
    );
  });

  test("total_alpha is REAL, so a pool total is numeric", () => {
    // The one thing TEXT would silently break: "9" outranking "10" wherever a
    // priced position is compared.
    assert.match(MIGRATION, /total_alpha\s+REAL\s+NOT NULL/);
  });

  test("the column stores ALPHA, and the migration says so", () => {
    // Storing TAO here would need the subnet's daily alpha price at WRITE
    // time, freezing a conversion the reader should make. Pinned because the
    // unit is invisible in the column name.
    assert.match(MIGRATION, /ALPHA, not TAO/);
  });

  test("both serving reads have an index to seek", () => {
    // Pricing a coldkey's positions looks up by (netuid, hotkey); the
    // staleness watchdog scans by capture time. Without either, both are full
    // scans of a ~762k-row table.
    assert.match(
      MIGRATION,
      /idx_hotkey_alpha_netuid\s+ON hotkey_alpha \(netuid, hotkey\)/,
    );
    assert.match(
      MIGRATION,
      /idx_hotkey_alpha_captured\s+ON hotkey_alpha \(captured_at\)/,
    );
  });
});

describe("writeHotkeyAlphaToD1", () => {
  test("upserts on the composite key with the staleness guard", async () => {
    const { statements, db } = d1Stub();
    const { statements: count } = await writeHotkeyAlphaToD1(db as never, [
      row(HOTKEY, 7, 1234.5, 1_000),
      row(HOTKEY, 83, 20, 1_000),
    ]);
    assert.equal(count, 1);
    const sql = statements[0]!.sql;
    assert.match(sql, /INSERT INTO hotkey_alpha/);
    assert.match(sql, /ON CONFLICT\s*\(hotkey, netuid\)/);
    // A pass arrives across many requests and the producer re-sends on
    // failure, so a replayed batch must be a no-op rather than a regression.
    assert.match(sql, /captured_at\s*<=\s*excluded\.captured_at/);
    // Both rows in one statement, as positional tuples inside a single
    // json_each parameter, in the writer's column order.
    assert.equal(statements[0]!.params.length, 1);
    assert.deepEqual(JSON.parse(statements[0]!.params[0] as string), [
      [HOTKEY, 7, 1234.5, 1_000],
      [HOTKEY, 83, 20, 1_000],
    ]);
  });

  test("binds ONE parameter per statement, whatever the row count", async () => {
    // The old shape spent one parameter per column per row, so 4 columns
    // against the 90-parameter budget was 22 rows a statement -- and a full
    // 762k-pool pass was tens of thousands of statements against curl's
    // 60-second timeout. A chunk now travels as one json_each parameter, which
    // is the strongest possible form of "inside the binding's limit": one.
    const { statements, db } = d1Stub();
    const rows = Array.from({ length: 500 }, (_unused, i) =>
      row(HOTKEY, i, i, 1_000),
    );
    const { statements: count } = await writeHotkeyAlphaToD1(db as never, rows);
    assert.equal(count, 1, "500 rows fit in a single statement");
    for (const statement of statements) {
      assert.equal(statement.params.length, 1);
      assert.ok(
        (statement.params[0] as string).length <= D1_JSON_BUDGET_BYTES,
        "the chunk stays inside the byte budget",
      );
    }
    const tuples = JSON.parse(statements[0]!.params[0] as string);
    assert.equal(tuples.length, 500);
    assert.deepEqual(tuples[0], [HOTKEY, 0, 0, 1_000]);
  });

  test("splits once the byte budget is reached", async () => {
    const { statements, db } = d1Stub();
    const oneRow = JSON.stringify([HOTKEY, 0, 0, 1_000]).length + 1;
    const perStatement = Math.floor(D1_JSON_BUDGET_BYTES / oneRow);
    const rows = Array.from({ length: perStatement + 1 }, (_unused, i) =>
      row(HOTKEY, i, i, 1_000),
    );
    await writeHotkeyAlphaToD1(db as never, rows);
    assert.equal(statements.length, 2, "one row past the budget splits");
  });

  test("an empty batch issues no statements at all", async () => {
    // Not an empty db.batch([]), which D1 rejects.
    const { statements, batches, db } = d1Stub();
    const { statements: count } = await writeHotkeyAlphaToD1(db as never, []);
    assert.equal(count, 0);
    assert.deepEqual(statements, []);
    assert.deepEqual(batches, []);
  });

  test("never issues a DELETE -- this lane does not prune", async () => {
    // The producer skips a zero pool rather than writing a zero row, so
    // "absent from the batch" says nothing about a pool's size. A prune would
    // delete exactly the hotkeys that emptied.
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(db as never, [row(HOTKEY, 7, 1, 1_000)]);
    for (const statement of statements) {
      assert.doesNotMatch(statement.sql, /DELETE/i);
    }
  });
});

// --- the pass tally (#9502, migrations/d1/0021) ------------------------------
//
// Why this lane needs a tally at all is the migration's subject: absence in
// `hotkey_alpha` is AMBIGUOUS by design, because the producer skips a genuine
// zero pool rather than writing a zero row. So "no row for this (hotkey,
// netuid)" means either "scanned, empty" or "never scanned", and no query over
// the table distinguishes them. Only the writer knows, so only the writer can
// state it.
describe("the hotkey_alpha pass tally", () => {
  const PASS = {
    capturedAt: 1_785_910_000_000,
    expectedRows: 148_211,
    receivedRows: 5_000,
    nowMs: 1_785_910_500_000,
  };

  test("no pass declared means no tally statement at all", async () => {
    // The producer may post without declaring, and a lane that invented a
    // pass_total would mark an unproven load complete.
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(db as never, [row(HOTKEY, 7, 1, 1)]);
    assert.equal(
      statements.some((s) => s.sql.includes("hotkey_alpha_passes")),
      false,
    );
  });

  test("the tally statement is appended LAST, so a mid-run failure under-counts", async () => {
    // batchInSlices splits a long statement list across several batch() calls,
    // so no single transaction spans them. Rows first, tally second: a pass can
    // look less complete than it is, never more. The reverse would mark a pass
    // complete over rows that never arrived.
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(
      db as never,
      [row(HOTKEY, 7, 1, PASS.capturedAt), row(HOTKEY, 8, 2, PASS.capturedAt)],
      PASS,
    );
    const last = statements.at(-1)!;
    assert.match(last.sql, /INSERT INTO hotkey_alpha_passes/);
    assert.equal(
      statements.slice(0, -1).some((s) => s.sql.includes("_passes")),
      false,
      "exactly one tally statement, and it is the final one",
    );
  });

  test("an empty batch writes no tally either", async () => {
    // An empty request must not advance a pass it delivered nothing for.
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(db as never, [], PASS);
    assert.deepEqual(statements, []);
  });

  test("completed_at is stamped only when the running total reaches the declared one", async () => {
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(
      db as never,
      [row(HOTKEY, 7, 1, PASS.capturedAt)],
      PASS,
    );
    const tally = statements.at(-1)!;
    // The CASE compares this request's rows against the declared total, and the
    // ON CONFLICT arm compares the accumulated total -- so a single short
    // request cannot stamp a completion.
    assert.match(tally.sql, /WHEN \? >= \? THEN \? ELSE NULL END/);
    assert.match(
      tally.sql,
      /received_rows = hotkey_alpha_passes\.received_rows \+ excluded\.received_rows/,
    );
    assert.deepEqual(tally.params, [
      PASS.capturedAt,
      PASS.expectedRows,
      PASS.receivedRows,
      PASS.receivedRows,
      PASS.expectedRows,
      PASS.nowMs,
      PASS.nowMs,
    ]);
  });

  test("a replay never un-completes a finished pass", async () => {
    // The producer is at-least-once, so received_rows can exceed expected_rows.
    // COALESCE keeps the original stamp rather than recomputing it.
    const { statements, db } = d1Stub();
    await writeHotkeyAlphaToD1(
      db as never,
      [row(HOTKEY, 7, 1, PASS.capturedAt)],
      PASS,
    );
    assert.match(
      statements.at(-1)!.sql,
      /completed_at = COALESCE\(\s*hotkey_alpha_passes\.completed_at/,
    );
  });
});
