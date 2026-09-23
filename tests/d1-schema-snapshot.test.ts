import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  normalizeSchema,
  schemaChanges,
  snapshotD1Schema,
} from "../scripts/snapshot-d1-schema.ts";
const row = {
  type: "table",
  name: "example",
  tbl_name: "example",
  sql: "CREATE TABLE example(id INTEGER);",
};
test("physical schema normalization excludes platform internals without changing logical row types", () => {
  const normalized = normalizeSchema([
    row,
    { ...row, name: "_cf_meta" },
    { ...row, type: "view", name: "z", sql: " SELECT 1; " },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(
    normalizeSchema([
      { ...row, sql: "CREATE TABLE example( \n id INTEGER \n);" },
    ])[0]?.sql,
    "CREATE TABLE example(\n id INTEGER\n)",
  );
  assert.equal(normalized[0]?.sql, "CREATE TABLE example(id INTEGER)");
  assert.deepEqual(schemaChanges(normalized, normalized), []);
  assert.deepEqual(
    schemaChanges(normalized, [{ ...normalized[0]!, sql: "changed" }]),
    ["example", "z"],
  );
  for (const bad of [
    { ...row, type: "unknown" },
    { ...row, name: null },
    { ...row, sql: "" },
  ])
    assert.throws(() => normalizeSchema([bad]), /invalid object/);
});
test("physical D1 schema snapshot writes, verifies and detects drift in both artifacts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "d1-schema-test-"));
  const batch = async () => [{ results: [row] }];
  try {
    await assert.rejects(snapshotD1Schema(false, batch, root), /drift/);
    await assert.rejects(
      snapshotD1Schema(true, async () => [{ results: [] }], root),
      /empty/,
    );
    await snapshotD1Schema(true, batch, root);
    await snapshotD1Schema(false, batch, root);
    assert.equal(
      readFileSync(path.join(root, "db/d1-schema.sql"), "utf8"),
      row.sql + "\n",
    );
    writeFileSync(path.join(root, "db/d1-schema.sql"), "changed");
    await assert.rejects(
      snapshotD1Schema(false, batch, root),
      /SQL snapshot differs/,
    );
    unlinkSync(path.join(root, "db/d1-schema.sql"));
    await assert.rejects(snapshotD1Schema(false, batch, root), /drift/);
    await assert.rejects(
      snapshotD1Schema(
        false,
        async () => [{ results: [{ ...row, name: "other" }] }],
        root,
      ),
      /example, other/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
