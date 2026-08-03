// The chain-detail D1 tables must hold exactly what the writer writes (#9208).
//
// Same anti-drift guarantee as tests/neurons-d1-schema.test.ts, and it fails
// the same silent way: a column the writer binds but the table lacks makes D1
// reject the whole batch, and a column the table has but the writer never sends
// is a permanently-NULL field that reads like real data.
//
// The natural keys get the same treatment, because they are what makes a
// re-POSTed block a no-op instead of a duplicate-key failure -- an upsert whose
// ON CONFLICT target is not the table's PRIMARY KEY is a runtime error, not a
// typecheck one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
  CHAIN_DETAIL_BLOCK_COLUMNS,
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  CHAIN_DETAIL_CONFLICT_KEYS,
  CHAIN_DETAIL_EXTRINSIC_COLUMNS,
} from "../src/chain-detail-d1-write.ts";

const MIGRATION = readFileSync("migrations/d1/0010_chain_detail.sql", "utf8");

function tableBody(table: string): string {
  const match = MIGRATION.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(match, `no CREATE TABLE for ${table} in the migration`);
  return match[1];
}

/** Column names of one CREATE TABLE block, in declaration order. */
function tableColumns(table: string): string[] {
  return tableBody(table)
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

/** The declared PRIMARY KEY of one table, in declaration order. */
function primaryKey(table: string): string[] {
  const match = tableBody(table).match(/PRIMARY KEY \(([^)]*)\)/);
  assert.ok(match, `no PRIMARY KEY for ${table}`);
  return match[1].split(",").map((column) => column.trim());
}

const TABLES = [
  ["chain_detail_blocks", CHAIN_DETAIL_BLOCK_COLUMNS],
  ["chain_detail_extrinsics", CHAIN_DETAIL_EXTRINSIC_COLUMNS],
  ["chain_detail_chain_events", CHAIN_DETAIL_CHAIN_EVENT_COLUMNS],
  ["chain_detail_account_events", CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS],
] as const;

describe("the chain-detail D1 schema matches its writer (#9208)", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    for (const [table] of TABLES) {
      assert.ok(
        tableColumns(table).length >= 8,
        `expected ${table}'s columns, found ${tableColumns(table).length}`,
      );
    }
  });

  for (const [table, columns] of TABLES) {
    test(`${table} holds exactly the columns the sync binds`, () => {
      assert.deepEqual(
        tableColumns(table).sort(),
        [...columns].sort(),
        "a column the writer sends but the table lacks makes D1 reject the " +
          "whole batch; a column the table has but the writer never sends is " +
          "a permanently-NULL field that reads like real data",
      );
    });

    test(`${table}'s upsert key IS its PRIMARY KEY`, () => {
      assert.deepEqual(
        [...CHAIN_DETAIL_CONFLICT_KEYS[table]],
        primaryKey(table),
        "ON CONFLICT against anything but a unique index is a runtime error",
      );
    });
  }

  test("the TAO amounts are TEXT, so an exact decimal survives storage", () => {
    // A REAL column would round-trip a rao-precision value through float64 and
    // lose it inside our own store, which is the whole reason the contract
    // sends decimal STRINGS.
    for (const [table, column] of [
      ["chain_detail_extrinsics", "fee_tao"],
      ["chain_detail_extrinsics", "tip_tao"],
      ["chain_detail_account_events", "amount_tao"],
      ["chain_detail_account_events", "alpha_amount"],
    ] as const) {
      assert.match(
        tableBody(table),
        new RegExp(`${column}\\s+TEXT`),
        `${table}.${column} must be TEXT, not REAL`,
      );
    }
  });

  test("the three columns whose NULL is load-bearing are nullable", () => {
    // signer is null for inherents, success is null when no
    // ExtrinsicSuccess/Failed correlated, and an event's extrinsic_index is
    // null outside the ApplyExtrinsic phase. NOT NULL on any of them would
    // reject real blocks.
    const extrinsics = tableBody("chain_detail_extrinsics");
    assert.doesNotMatch(extrinsics, /signer\s+TEXT\s+NOT NULL/);
    assert.doesNotMatch(extrinsics, /success\s+INTEGER\s+NOT NULL/);
    assert.doesNotMatch(
      tableBody("chain_detail_chain_events"),
      /extrinsic_index\s+INTEGER\s+NOT NULL/,
    );
  });
});
