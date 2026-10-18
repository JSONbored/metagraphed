import assert from "node:assert/strict";
import { test } from "vitest";
import { d1BundleSourceColumns } from "../scripts/archive-policy-d1-source.ts";
import type { SchemaObject } from "../scripts/snapshot-d1-schema.ts";

const table = (sql = "CREATE TABLE fixture_rows(id TEXT NOT NULL)") => ({
  type: "table",
  name: "fixture_rows",
  tbl_name: "fixture_rows",
  sql,
});

test("empty mappings select nothing, even when unrelated DDL is unusable", async () => {
  assert.deepEqual(await d1BundleSourceColumns([table("invalid")], []), []);
});

test("SQLite supplies declared types, nullability and generated columns without reading rows", async () => {
  const columns = await d1BundleSourceColumns(
    [
      table(`CREATE TABLE fixture_rows(
        id TEXT NOT NULL PRIMARY KEY,
        quantity TEXT CHECK(quantity IS NULL OR length(quantity) < 40),
        page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 65535),
        label TEXT DEFAULT 'comma, parentheses() and semicolon;',
        derived TEXT GENERATED ALWAYS AS (id || ',') VIRTUAL
      )`),
      { type: "view", name: "ignored", tbl_name: "ignored", sql: "invalid" },
      { type: "trigger", name: "guard", tbl_name: "fixture_rows", sql: "invalid" },
    ],
    ["fixture_rows", "fixture_rows"],
  );
  assert.deepEqual(columns, [
    { table: "fixture_rows", column: "id", udt: "TEXT", nullable: false },
    { table: "fixture_rows", column: "quantity", udt: "TEXT", nullable: true },
    { table: "fixture_rows", column: "page_index", udt: "INTEGER", nullable: false },
    { table: "fixture_rows", column: "label", udt: "TEXT", nullable: true },
    { table: "fixture_rows", column: "derived", udt: "TEXT", nullable: true },
  ]);
});

test("table order is deterministic and TEXT primary keys do not imply NOT NULL", async () => {
  const other = {
    type: "table",
    name: "fixture_other",
    tbl_name: "fixture_other",
    sql: 'CREATE TABLE "fixture_other"(id TEXT PRIMARY KEY)',
  };
  const columns = await d1BundleSourceColumns(
    [table(), other],
    ["fixture_rows", "fixture_other"],
  );
  assert.equal(columns[0]!.table, "fixture_other");
  assert.equal(columns[0]!.nullable, true);
  assert.equal(columns[1]!.nullable, false);
});

const failures: [string, SchemaObject[], string[], RegExp][] = [
  ["missing table", [], ["fixture_rows"], /one physical table/],
  ["duplicate table", [table(), table()], ["fixture_rows"], /one physical table/],
  [
    "view masquerading as a table",
    [{ ...table(), type: "view" }],
    ["fixture_rows"],
    /one physical table/,
  ],
  [
    "mismatched snapshot identity",
    [{ ...table(), tbl_name: "different" }],
    ["fixture_rows"],
    /one physical table/,
  ],
  ["invalid selected name", [table()], ["fixture_rows;DROP"], /invalid D1 source/],
  [
    "mismatched DDL identity",
    [table("CREATE TABLE other(id TEXT)")],
    ["fixture_rows"],
    /unsupported D1 table definition/,
  ],
  [
    "virtual table",
    [table("CREATE VIRTUAL TABLE fixture_rows USING fts5(id)")],
    ["fixture_rows"],
    /unsupported D1 table definition/,
  ],
  [
    "second statement",
    [table("CREATE TABLE fixture_rows(id TEXT); CREATE TABLE extra(id TEXT)")],
    ["fixture_rows"],
    /trailing SQL/,
  ],
  [
    "row statement tail",
    [table("CREATE TABLE fixture_rows(id TEXT); INSERT INTO fixture_rows VALUES('x')")],
    ["fixture_rows"],
    /trailing SQL/,
  ],
  [
    "unsupported column name",
    [table('CREATE TABLE fixture_rows("odd-name" TEXT)')],
    ["fixture_rows"],
    /unsupported D1 source column/,
  ],
  [
    "undeclared column type",
    [table("CREATE TABLE fixture_rows(id)")],
    ["fixture_rows"],
    /unsupported D1 source column/,
  ],
];
for (const [name, snapshot, selected, expected] of failures) {
  test(`source extraction rejects ${name}`, async () => {
    await assert.rejects(d1BundleSourceColumns(snapshot, selected), expected);
    assert.equal((await d1BundleSourceColumns([table()], ["fixture_rows"])).length, 1);
  });
}
