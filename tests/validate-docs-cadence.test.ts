// Regression coverage for #5993: validate-docs.ts's stale-cadence guard must
// scan scripts/*.mjs|ts (and README.md), not only docs/**/*.md — otherwise the
// exact drift class that survived in build-artifacts / refresh-candidates is
// structurally invisible to the check meant to prevent it.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  collectCadenceScanFiles,
  findStaleCadenceHits,
} from "../scripts/validate-docs.ts";

describe("validate-docs.ts stale cadence guard (#5993)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("findStaleCadenceHits catches a deliberately-reintroduced 6h string in a scripts/*.mjs file", () => {
    const relativePath = "scripts/fixture-stale-cadence.mjs";
    const text = [
      "// Tolerant refresh for the production publish.",
      "// without this the 6h publish starts failing ~24h after the last sync.",
      "export const noop = true;",
      "",
    ].join("\n");

    const hits = findStaleCadenceHits(relativePath, text);

    assert.equal(hits.length, 1);
    assert.match(hits[0], /^scripts\/fixture-stale-cadence\.mjs:2:/);
    assert.match(hits[0], /stale six-hour publish cadence/);
    assert.match(hits[0], /6h publish/);
  });

  test("collectCadenceScanFiles includes scripts/*.mjs|ts and README.md alongside docs", async () => {
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-docs-cadence-`);
    mkdirSync(path.join(tempDir, "docs", "adr"), { recursive: true });
    mkdirSync(path.join(tempDir, "scripts"), { recursive: true });
    writeFileSync(path.join(tempDir, "docs", "ops.md"), "# ops\n");
    writeFileSync(path.join(tempDir, "docs", "adr", "0007.md"), "# adr\n");
    writeFileSync(path.join(tempDir, "scripts", "example.mjs"), "// ok\n");
    // TypeScript-migration coverage (metagraphed#7510): as scripts/ converts
    // file by file, the cadence guard must keep seeing the converted .ts
    // files too, not just whatever hasn't been converted yet.
    writeFileSync(path.join(tempDir, "scripts", "example.ts"), "// ok\n");
    writeFileSync(path.join(tempDir, "README.md"), "# readme\n");

    const files = await collectCadenceScanFiles(tempDir);
    const rels = files
      .map((file) => path.relative(tempDir!, file).split(path.sep).join("/"))
      .sort();

    assert.deepEqual(rels, [
      "README.md",
      "docs/ops.md",
      "scripts/example.mjs",
      "scripts/example.ts",
    ]);
    assert.ok(!rels.includes("docs/adr/0007.md"));
  });
});
