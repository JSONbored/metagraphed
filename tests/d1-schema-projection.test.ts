import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
  projectD1Schema,
  snapshotD1Schema,
  type SchemaObject,
} from "../scripts/snapshot-d1-schema.ts";

const SQL = "db/d1-schema.sql";
const JSON_SCHEMA = "generated/db/d1-schema.json";
const PENDING = "0002_payment_attempts.sql";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "d1-projection-"));
  mkdirSync(path.join(root, "migrations/d1"), { recursive: true });
  const baseline: SchemaObject[] = [
    {
      type: "index",
      name: "example_value_idx",
      tbl_name: "example",
      sql: "CREATE INDEX example_value_idx ON example(value)",
    },
    {
      type: "table",
      name: "example",
      tbl_name: "example",
      sql: "CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)",
    },
  ];
  await snapshotD1Schema(
    true,
    async () => [{ results: baseline.map((row) => ({ ...row })) }],
    root,
  );
  const migration =
    "CREATE TABLE payment_attempts(id TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID;\n" +
    "CREATE INDEX payment_attempt_state_idx ON payment_attempts(state);\n";
  writeFileSync(path.join(root, "migrations/d1", PENDING), migration);
  writeFileSync(
    path.join(root, "migrations/d1/0003_unselected.sql"),
    "CREATE TABLE unselected(id INTEGER PRIMARY KEY);\n",
  );
  return { root, migration };
}

test("expected projection restores indexes after tables, applies only named DDL, and retains snapshot formats without D1 access", async () => {
  const value = await fixture();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Projection must not contact D1"));
  try {
    const beforeSql = readFileSync(path.join(value.root, SQL), "utf8");
    const beforeJson = readFileSync(path.join(value.root, JSON_SCHEMA), "utf8");
    const preview = await projectD1Schema([PENDING], false, value.root);
    assert.equal(preview.mode, "expected-postmigration");
    assert.equal(preview.live_readback, false);
    assert.equal(preview.written, false);
    assert.deepEqual(preview.changed_objects, [
      "payment_attempt_state_idx",
      "payment_attempts",
    ]);
    assert.equal(readFileSync(path.join(value.root, SQL), "utf8"), beforeSql);
    assert.equal(
      readFileSync(path.join(value.root, JSON_SCHEMA), "utf8"),
      beforeJson,
    );
    const receipt = await projectD1Schema([PENDING], true, value.root);
    assert.equal(receipt.written, true);
    assert.deepEqual(receipt.baseline_sha256, {
      [SQL]: hash(beforeSql),
      [JSON_SCHEMA]: hash(beforeJson),
    });
    assert.deepEqual(receipt.migrations, [
      { name: PENDING, sha256: hash(value.migration) },
    ]);
    const sql = readFileSync(path.join(value.root, SQL), "utf8");
    const json = readFileSync(path.join(value.root, JSON_SCHEMA), "utf8");
    assert.match(sql, /CREATE TABLE payment_attempts/);
    assert.doesNotMatch(sql, /unselected/);
    assert.deepEqual(receipt.output_sha256, {
      [SQL]: hash(sql),
      [JSON_SCHEMA]: hash(json),
    });
    const projected: SchemaObject[] = JSON.parse(json);
    assert.equal(Array.isArray(projected), true);
    assert.equal(projected.length, 4);
    // An actual readback with the same catalog must compare byte-for-byte;
    // this fixture is not production evidence or a migration-ledger claim.
    await snapshotD1Schema(
      false,
      async () => [{ results: projected.map((row) => ({ ...row })) }],
      value.root,
    );
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    fetch.mockRestore();
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("projection refuses implicit, duplicate, unordered, skipped, missing and symlinked migration selections", async () => {
  const value = await fixture();
  try {
    for (const names of [
      [],
      ["../0002_payment_attempts.sql"],
      [PENDING, PENDING],
      ["0003_unselected.sql", PENDING],
      [PENDING, "0004_skipped.sql"],
      Array.from(
        { length: 11 },
        (_, i) => `${String(i + 1).padStart(4, "0")}_many.sql`,
      ),
    ]) {
      await assert.rejects(projectD1Schema(names, true, value.root));
    }
    await assert.rejects(
      projectD1Schema(["0004_missing.sql"], true, value.root),
      /ENOENT/,
    );
    symlinkSync(
      path.join(value.root, "migrations/d1/0003_unselected.sql"),
      path.join(value.root, "migrations/d1/0004_link.sql"),
    );
    await assert.rejects(
      projectD1Schema(["0004_link.sql"], true, value.root),
      /regular repository files/,
    );
    assert.doesNotMatch(
      readFileSync(path.join(value.root, SQL), "utf8"),
      /payment_attempts|unselected/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("projection leaves both snapshots intact when baseline identity or native SQL fails", async () => {
  const value = await fixture();
  try {
    const sqlPath = path.join(value.root, SQL);
    const jsonPath = path.join(value.root, JSON_SCHEMA);
    const originalSql = readFileSync(sqlPath, "utf8");
    const originalJson = readFileSync(jsonPath, "utf8");
    writeFileSync(sqlPath, originalSql + "-- unexpected baseline\n");
    await assert.rejects(
      projectD1Schema([PENDING], true, value.root),
      /must match/,
    );
    assert.equal(readFileSync(jsonPath, "utf8"), originalJson);
    writeFileSync(sqlPath, originalSql);
    writeFileSync(
      path.join(value.root, "migrations/d1", PENDING),
      "CREATE TABLE broken (",
    );
    await assert.rejects(projectD1Schema([PENDING], true, value.root));
    assert.equal(readFileSync(sqlPath, "utf8"), originalSql);
    assert.equal(readFileSync(jsonPath, "utf8"), originalJson);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
