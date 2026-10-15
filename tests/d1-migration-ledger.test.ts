import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  normalizeSchema,
  snapshotD1Schema,
  verifyD1MigrationLedger,
  type SchemaObject,
} from "../scripts/snapshot-d1-schema.ts";

const files = ["0001_first.sql", "0002_second.sql"];
function tracked(names = files): string {
  const root = mkdtempSync(path.join(tmpdir(), "d1-ledger-"));
  const dir = path.join(root, "migrations/d1");
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(path.join(dir, name), "-- fixture\n");
  return root;
}

test("ledger verification makes one bounded read and accepts recorded filenames independently of row order", async () => {
  const root = tracked();
  let calls = 0;
  try {
    await verifyD1MigrationLedger(async (statements) => {
      calls++;
      assert.deepEqual(statements, [
        {
          sql: "SELECT name FROM d1_migrations ORDER BY name LIMIT ?",
          params: ["3"],
        },
      ]);
      return [{ results: [...files].reverse().map((name) => ({ name })) }];
    }, root);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger verification refuses missing, untracked, duplicate and malformed records", async () => {
  const root = tracked();
  try {
    for (const [names, reason] of [
      [[], /2 missing, 0 untracked/],
      [[files[1]], /1 missing, 0 untracked/],
      [[...files, "0003_untracked.sql"], /0 missing, 1 untracked/],
      [[files[0], files[0]], /invalid or duplicate/],
      [[files[0], "0003_gap.sql"], /invalid or duplicate/],
      [[null], /invalid or duplicate/],
      [[1], /invalid or duplicate/],
      [["provider text"], /invalid or duplicate/],
    ] as const) {
      await assert.rejects(
        verifyD1MigrationLedger(
          async () => [{ results: names.map((name) => ({ name })) }],
          root,
        ),
        reason,
      );
    }
    await assert.rejects(
      verifyD1MigrationLedger(async () => [], root),
      /response is unavailable/,
    );
    let attempts = 0;
    const original = new Error("D1 maintenance request failed with HTTP 403");
    await assert.rejects(
      verifyD1MigrationLedger(async () => {
        attempts++;
        throw original;
      }, root),
      (error) => error === original,
    );
    assert.equal(attempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid or empty tracked sequences fail before any credentialed read", async () => {
  for (const names of [[], ["bad.sql"], ["0001_a.sql", "0003_gap.sql"]]) {
    const root = tracked(names);
    let calls = 0;
    try {
      await assert.rejects(
        verifyD1MigrationLedger(async () => {
          calls++;
          return [];
        }, root),
        /empty or invalid/,
      );
      assert.equal(calls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the recorded0038 keeps its original bytes and matches the captured physical table", async () => {
  const migration = readFileSync(
    new URL(
      "../migrations/d1/0038_raw_capture_publications.sql",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(migration).digest("hex"),
    "b8dd7743860c28969602f6b40c0fa776ff18734dd78e43a0752bbb755482e3ac",
  );
  const schema = JSON.parse(
    readFileSync(
      new URL("../generated/db/d1-schema.json", import.meta.url),
      "utf8",
    ),
  ) as SchemaObject[];
  const table = schema.find(
    (object) => object.name === "raw_capture_publications",
  );
  assert.ok(table);
  const ddl = migration
    .toString("utf8")
    .split("-- statement-breakpoint")[0]!
    .replace(/^--.*$/gm, "")
    .trim();
  assert.deepEqual(normalizeSchema([{ ...table, sql: ddl }]), [table]);
  // Exercise the existing drift owner against the complete captured JSON/SQL pair.
  await snapshotD1Schema(false, async () => [
    { results: schema.map((object) => ({ ...object })) },
  ]);
});
