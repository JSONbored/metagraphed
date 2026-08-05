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
import { D1_PARAM_BUDGET } from "../src/neurons-d1-write.ts";

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
    // Both rows in one statement, bound in the writer's column order.
    assert.deepEqual(statements[0]!.params, [
      HOTKEY,
      7,
      1234.5,
      1_000,
      HOTKEY,
      83,
      20,
      1_000,
    ]);
  });

  test("chunks to stay inside the binding's parameter budget", async () => {
    // 4 columns against D1's 100-parameter ceiling is 25 rows a statement.
    // Exceeding it fails the whole batch, which is what #9157 hit live.
    const perStatement = Math.floor(
      D1_PARAM_BUDGET / HOTKEY_ALPHA_INSERT_COLUMNS.length,
    );
    const { statements, db } = d1Stub();
    const rows = Array.from({ length: perStatement * 2 + 1 }, (_unused, i) =>
      row(HOTKEY, i, i, 1_000),
    );
    const { statements: count } = await writeHotkeyAlphaToD1(db as never, rows);
    assert.equal(count, 3);
    for (const statement of statements) {
      assert.ok(
        statement.params.length <= D1_PARAM_BUDGET,
        `a statement bound ${statement.params.length} parameters`,
      );
    }
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
