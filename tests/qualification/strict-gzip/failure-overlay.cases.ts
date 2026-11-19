// Pure packaging regressions: omitted files stay in harness and every declared
// direct sibling import stays in the bounded native copy. No module is loaded.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownerOverlayFiles } from "./owner-overlay.ts";
const here = fileURLToPath(new URL(".", import.meta.url));
const runtime = ownerOverlayFiles().map((row) => path.basename(row.path));
const pureData = [
  "chain-summary-workspace-fixture.ts",
  "discarded-input-source-fixtures.json",
  "erasure-config-source-fixtures.json",
  "owner-pg-source-fixtures.json",
  "optional-pg-source-fixtures.json",
];
const pureCases = readdirSync(here).filter((name) =>
  name.endsWith(".cases.ts"),
);
test("all pure tests and their large data remain available outside copied runtime inventory", () => {
  assert.ok(pureCases.length >= 22);
  for (const name of [...pureCases, ...pureData]) {
    assert.ok(readFileSync(path.join(here, name)).byteLength > 0);
    assert.equal(runtime.includes(name), false);
  }
});
test("all direct sibling imports in copied runtime files have an exact inventory entry", () => {
  for (const name of runtime.filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(path.join(here, name), "utf8");
    for (const match of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*)["']\.\/([a-z0-9.-]+\.(?:ts|json))["']/g,
    ))
      assert.ok(
        runtime.includes(match[1]!),
        `${name}: undeclared direct sibling dependency`,
      );
    for (const excluded of [...pureCases, ...pureData])
      assert.equal(
        text.includes(excluded),
        false,
        `${name}: pure-only filename referenced`,
      );
  }
});
test("unchanged runtime caps retain all safety and owner evidence components", () => {
  const rows = ownerOverlayFiles();
  assert.ok(rows.length <= 64);
  assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= 2097152);
  for (const required of [
    "guard-preload.ts",
    "launch-policy.ts",
    "thread-policy.ts",
    "owner-build-evidence.ts",
    "owner-native-evidence.ts",
    "queue-owner-resource.test.ts",
    "raw-owner-resource.test.ts",
    "owner-public-source-index.json",
    "owner-proof-reason-codes.ts",
  ])
    assert.ok(runtime.includes(required));
});
