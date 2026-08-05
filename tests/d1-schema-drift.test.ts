// SELECT/INSERT-list drift protection, checked against the D1 schema itself (#9426).
//
// tests/db-row-types.test.ts does this today as type-level assertions against
// generated/db -- Kanel output produced by introspecting a scratch POSTGRES container
// loaded from deploy/postgres/schema.sql. Two things are wrong with that as the guard:
//
//   1. It checks the wrong database. These queries run on D1. A column present in the
//      Postgres schema and absent from D1 passes that gate and fails in production.
//   2. Its column lists are HAND-WRITTEN in the test. So the thing protecting us from
//      drift is itself a list someone has to remember to update, which is the shape of
//      problem it exists to prevent.
//
// This checks the column constants the code ACTUALLY USES against the DDL that is
// ACTUALLY APPLIED. Nothing is hand-listed in between and there is no codegen step: the
// migrations are executed into an in-memory SQLite via node:sqlite, and the column set
// is read back with PRAGMA table_info. If a migration drops a column a query still
// names, this fails.
//
// Only D1-resident tables belong here. The cold tier (blocks, extrinsics,
// account_events, chain_events) lives in the R2 lakehouse and is a different engine
// with a different dialect -- asserting its columns against D1 DDL would be the same
// wrong-database mistake in a new place.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  NEURON_COLUMNS,
  NEURON_INSERT_COLUMNS,
} from "../src/metagraph-neurons.ts";
import { ACCOUNT_POSITION_DAILY_COLUMNS } from "../src/neurons-d1-write.ts";
import { ACCOUNT_BALANCE_INSERT_COLUMNS } from "../src/account-balances-d1-write.ts";
import {
  CHAIN_DETAIL_BLOCK_COLUMNS,
  CHAIN_DETAIL_EXTRINSIC_COLUMNS,
  CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
} from "../src/chain-detail-d1-write.ts";

/** Every D1 migration, executed in order, exactly as production had them applied. */
function d1Database(): DatabaseSync {
  const dir = path.join(process.cwd(), "migrations/d1");
  const db = new DatabaseSync(":memory:");
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  return db;
}

const db = d1Database();

function columnsOf(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Normalise a column constant to a list.
 *
 * These constants are not consistently shaped: the INSERT-side ones are arrays, while
 * NEURON_COLUMNS is a comma-separated SELECT-list STRING. That inconsistency is worth
 * fixing at the source, but a drift guard that only understood one shape would silently
 * skip the other -- so this accepts both and the guard covers everything today.
 */
function columnList(value: readonly string[] | string): string[] {
  return (typeof value === "string" ? value.split(",") : [...value])
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Table -> the column lists the code names when reading or writing it. */
const GUARDED: Array<[string, string, readonly string[] | string]> = [
  ["neurons", "NEURON_COLUMNS", NEURON_COLUMNS],
  ["neurons", "NEURON_INSERT_COLUMNS", NEURON_INSERT_COLUMNS],
  [
    "account_position_daily",
    "ACCOUNT_POSITION_DAILY_COLUMNS",
    ACCOUNT_POSITION_DAILY_COLUMNS,
  ],
  [
    "chain_detail_blocks",
    "CHAIN_DETAIL_BLOCK_COLUMNS",
    CHAIN_DETAIL_BLOCK_COLUMNS,
  ],
  [
    "chain_detail_extrinsics",
    "CHAIN_DETAIL_EXTRINSIC_COLUMNS",
    CHAIN_DETAIL_EXTRINSIC_COLUMNS,
  ],
  [
    "chain_detail_account_events",
    "CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS",
    CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
  ],
  [
    "chain_detail_chain_events",
    "CHAIN_DETAIL_CHAIN_EVENT_COLUMNS",
    CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  ],
  [
    "account_balances",
    "ACCOUNT_BALANCE_INSERT_COLUMNS",
    ACCOUNT_BALANCE_INSERT_COLUMNS,
  ],
];

describe("the D1 migrations apply", () => {
  test("every migration in migrations/d1 executes in order", () => {
    // The precondition for everything below. If this fails, the migration set is not
    // self-consistent and no drift assertion beneath it means anything.
    assert.ok(columnsOf("neurons").size > 0, "neurons did not get created");
  });

  test("each guarded table exists", () => {
    // A positive control for the assertions below: columnsOf() on a table that does
    // not exist returns an EMPTY set, and "every column in [] is present" is vacuously
    // true. Without this, a renamed table would make its drift test pass by having
    // nothing left to check.
    for (const [table] of GUARDED) {
      assert.ok(
        columnsOf(table).size > 0,
        `${table} is missing from migrations/d1 -- the drift test for it would ` +
          `otherwise pass vacuously`,
      );
    }
  });
});

describe("column constants match the applied D1 schema", () => {
  for (const [table, name, columns] of GUARDED) {
    test(`${name} exists on ${table}`, () => {
      const named = columnList(columns);
      assert.ok(
        named.length > 0,
        `${name} is empty -- nothing would be checked`,
      );
      const actual = columnsOf(table);
      const missing = named.filter((c) => !actual.has(c));
      assert.deepEqual(
        missing,
        [],
        `${name} names ${missing.length} column(s) that migrations/d1 does not ` +
          `create on ${table}: ${missing.join(", ")}`,
      );
    });
  }
});
