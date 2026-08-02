// The D1 tables must hold exactly what the writer writes (#9146).
//
// A migration is a hand-written artifact and the writer's column list is
// generated from `NEURON_INSERT_COLUMNS`. Left unchecked those are two
// declarations of one fact -- the same shape as #9127's limit ceiling and
// #9138's health_source enum, and it fails the same silent way: a column added
// to the writer but not the table makes D1 reject the whole batch, and a column
// in the table the writer never sends is a permanently-NULL field that reads
// like real data.
//
// So the migration is parsed and compared against the writer, both directions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "../src/neurons-d1-write.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";

const MIGRATION = readFileSync("migrations/d1/0007_neurons.sql", "utf8");

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

describe("the neurons D1 schema matches its writer (#9146)", () => {
  test("the migration parser actually finds columns", () => {
    // A regex that silently matched nothing would make every comparison below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.ok(
      tableColumns("neurons").length >= 20,
      `expected the neurons columns, found ${tableColumns("neurons").length}`,
    );
  });

  test("neurons holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("neurons").sort(),
      [...NEURON_INSERT_COLUMNS].sort(),
      "a column the writer sends but the table lacks makes D1 reject the whole " +
        "batch; a column the table has but the writer never sends is a " +
        "permanently-NULL field that reads like real data",
    );
  });

  test("neuron_daily adds only the day and the write stamp", () => {
    assert.deepEqual(
      tableColumns("neuron_daily").sort(),
      [...NEURON_DAILY_COLUMNS].sort(),
    );
  });

  test("account_position_daily holds exactly its re-keyed projection", () => {
    assert.deepEqual(
      tableColumns("account_position_daily").sort(),
      [...ACCOUNT_POSITION_DAILY_COLUMNS].sort(),
    );
  });

  test("every table can enforce the staleness guard the writer relies on", () => {
    // buildUpsert ends every statement with
    // `WHERE <table>.captured_at <= excluded.captured_at`, so a table without
    // captured_at would make that clause a syntax error at sync time -- long
    // after the migration looked fine.
    for (const table of ["neurons", "neuron_daily", "account_position_daily"]) {
      assert.ok(
        tableColumns(table).includes("captured_at"),
        `${table} needs captured_at for the upsert's staleness guard`,
      );
    }
  });

  test("the upsert keys are declared as primary keys", () => {
    // ON CONFLICT (...) requires a matching uniqueness constraint; without it
    // SQLite raises "ON CONFLICT clause does not match any PRIMARY KEY or
    // UNIQUE constraint" and every sync fails.
    for (const [table, key] of [
      ["neurons", "PRIMARY KEY (netuid, uid)"],
      ["neuron_daily", "PRIMARY KEY (netuid, uid, snapshot_date)"],
      [
        "account_position_daily",
        "PRIMARY KEY (account, netuid, snapshot_date)",
      ],
    ]) {
      assert.ok(
        MIGRATION.includes(key),
        `${table} must declare ${key} or its ON CONFLICT target does not exist`,
      );
    }
  });
});
