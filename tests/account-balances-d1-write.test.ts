// The account-balances D1 write path (#9478) and the schema it writes into.
//
// Two things are checked here and they fail in different ways. The MIGRATION
// check is anti-drift: a column the writer binds but the table lacks makes D1
// reject the whole batch, and a column the table has but the writer never
// sends is a permanently-NULL field that reads like real data (0007's
// tests/neurons-d1-schema.test.ts and 0011/0012's own writer tests make the
// same guarantee for their tables). The WRITER checks are about the parameter
// budget and the staleness guard: this lane posts a ~540k-row pass across ~22
// requests, so a chunk that overran the binding's limit would fail the whole
// batch, and a replayed request must never walk a balance backwards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  ACCOUNT_BALANCE_INSERT_COLUMNS,
  writeAccountBalancesToD1,
} from "../src/account-balances-d1-write.ts";
import { D1_JSON_BUDGET_BYTES } from "../src/neurons-d1-write.ts";

const MIGRATION = readFileSync(
  "migrations/d1/0017_account_balances.sql",
  "utf8",
);

const SS58 = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

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

function row(ss58: string, free: number, reserved: number, at: number) {
  return { ss58, free_tao: free, reserved_tao: reserved, captured_at: at };
}

describe("the account_balances D1 schema matches its writer", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.equal(tableColumns("account_balances").length, 4);
  });

  test("the table holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("account_balances").sort(),
      [...ACCOUNT_BALANCE_INSERT_COLUMNS].sort(),
    );
  });

  test("the upsert key is one row per account", () => {
    // Latest-only: the Postgres original was PRIMARY KEY (ss58) with an
    // ON CONFLICT upsert, and the leaderboard that reads this assumes one row
    // per account.
    assert.match(
      MIGRATION,
      /PRIMARY KEY \(ss58\)/,
      "the PRIMARY KEY must be the same key the writer declares as its conflict target",
    );
  });

  test("the balances are REAL, so the leaderboard's sort is numeric", () => {
    // The one thing TEXT would silently break: "9" outranking "10". The
    // migration's header argues the tradeoff against the producer's exact
    // decimal string; this pins the outcome.
    assert.match(MIGRATION, /free_tao\s+REAL\s+NOT NULL/);
    assert.match(MIGRATION, /reserved_tao\s+REAL\s+NOT NULL/);
  });

  test("the watchdog's MAX(captured_at) read has an index to seek", () => {
    // Without it the twice-hourly tick is a full scan of ~540k rows.
    assert.match(
      MIGRATION,
      /CREATE INDEX IF NOT EXISTS idx_account_balances_captured_at\s+ON account_balances \(captured_at DESC\)/,
    );
  });
});

describe("writeAccountBalancesToD1", () => {
  test("upserts on ss58 with the staleness guard", async () => {
    const { statements, db } = d1Stub();
    const { statements: count } = await writeAccountBalancesToD1(db as never, [
      row(SS58, 1000.5, 25.25, 1_000),
      row("5G9", 3, 0, 1_000),
    ]);

    assert.equal(count, statements.length);
    assert.equal(statements.length, 1, "two narrow rows fit one statement");
    assert.match(
      statements[0]!.sql,
      /INSERT INTO account_balances \(ss58, free_tao, reserved_tao, captured_at\)/,
    );
    assert.match(statements[0]!.sql, /ON CONFLICT \(ss58\) DO UPDATE SET/);
    assert.match(
      statements[0]!.sql,
      /WHERE account_balances\.captured_at <= excluded\.captured_at/,
      "an older capture must never overwrite a newer one",
    );
    // One json_each parameter carrying both rows as positional tuples, in
    // the statement's own column order.
    assert.equal(statements[0]!.params.length, 1);
    assert.deepEqual(JSON.parse(statements[0]!.params[0] as string), [
      [SS58, 1000.5, 25.25, 1_000],
      ["5G9", 3, 0, 1_000],
    ]);
  });

  test("issues no DELETE -- this lane never prunes", async () => {
    // The one behaviour it must not borrow from the nominator-positions
    // sibling. The producer skips an account whose free and reserved are both
    // zero, so "absent from this batch" carries no information about the
    // account's balance and a prune would delete the wallets that emptied.
    const { statements, db } = d1Stub();
    await writeAccountBalancesToD1(db as never, [
      row(SS58, 1, 0, 1_000),
      row("5G9", 2, 0, 2_000),
    ]);
    assert.ok(statements.length > 0, "the fixture must actually write");
    for (const statement of statements) {
      assert.doesNotMatch(statement.sql, /DELETE/i);
    }
  });

  test("binds ONE parameter per statement, whatever the row count", async () => {
    // 100 per statement on the BINDING -- not the 1,200 `wrangler d1 execute`
    // permits from the CLI. The first 15 production neurons syncs all failed on
    // exactly that confusion. A chunk now travels as a single json_each
    // parameter, so the count is 1 rather than merely under the ceiling, and a
    // 25,000-row request is a handful of statements instead of 1,000.
    const { statements, db } = d1Stub();
    await writeAccountBalancesToD1(
      db as never,
      Array.from({ length: 500 }, (_unused, i) =>
        row(`acct-${i}`, i, 0, 1_000),
      ),
    );
    assert.equal(statements.length, 1, "500 rows fit in a single statement");
    for (const statement of statements) {
      assert.equal(statement.params.length, 1);
      assert.ok((statement.params[0] as string).length <= D1_JSON_BUDGET_BYTES);
    }
  });

  test("an empty batch issues no statements and never calls batch()", async () => {
    // An empty `db.batch([])` is a round trip that can only fail. The route
    // rejects an empty body with a 400 before reaching here, so this guard is
    // reachable only by a direct caller -- which is exactly why it is asserted
    // rather than assumed.
    const { statements, batches, db } = d1Stub();
    const result = await writeAccountBalancesToD1(db as never, []);
    assert.equal(result.statements, 0);
    assert.equal(statements.length, 0);
    assert.deepEqual(batches, []);
  });
});
