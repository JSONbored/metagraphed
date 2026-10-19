import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test.each(["true", "false"])(
  "schema verification emits only a fixed failure with GITHUB_ACTIONS=%s",
  (actions) => {
    const entry = fileURLToPath(
      new URL("../scripts/snapshot-d1-schema.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 10_000,
      // No account/database configuration: fail before any request.
      env: {
        GITHUB_ACTIONS: actions,
        NODE_NO_WARNINGS: "1",
        CLOUDFLARE_API_TOKEN: "fixture-private-marker",
      } as NodeJS.ProcessEnv,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const prefix = actions === "true" ? "::error::" : "";
    assert.equal(
      result.stderr,
      `${prefix}D1 schema verification failed (unclassified)\n`,
    );
    assert.equal(result.stderr.includes("fixture-private-marker"), false);
  },
);
