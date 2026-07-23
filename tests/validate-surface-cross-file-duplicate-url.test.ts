// Regression coverage for #6328: validate-surface.ts now fails when the
// identical URL is registered as a surface in TWO DIFFERENT subnet files
// under different netuids — the cross-file counterpart to #5737's within-file
// duplicate-URL check, which only ever sees one document at a time and so
// cannot catch a URL copy-pasted into a second subnet's manifest (the SN48/
// SN63 qbittensorlabs.com/api/health mistake this issue found). Mirrors
// validate-surface-duplicate-url.test.mjs's subprocess-fixture pattern.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { listJsonFiles, repoRoot } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

function runNode(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as Row;
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("validate-surface.ts cross-file duplicate-URL check", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeFixtures(docs: Row[]) {
    tempDir = mkdtempSync(
      `${tmpdir()}/metagraphed-validate-surface-cross-file-dup-`,
    );
    return docs.map((doc, index: number) => {
      const document = {
        schema_version: 1,
        netuid: doc.netuid,
        slug: `fixture-${index}`,
        name: `Fixture Subnet ${index}`,
        status: "active",
        categories: [],
        links: [],
        surfaces: doc.surfaces,
      };
      const fixturePath = path.join(tempDir!, `fixture-${index}.json`);
      writeFileSync(fixturePath, JSON.stringify(document, null, 2));
      return fixturePath;
    });
  }

  function surface(overrides: Row) {
    return {
      id: "fixture-surface",
      kind: "subnet-api",
      name: "Fixture surface",
      url: "https://api.fixture.example/status",
      provider: "academia",
      authority: "community",
      auth_required: false,
      public_safe: true,
      review: { state: "community-submitted" },
      ...overrides,
    };
  }

  test("fails when the identical URL is registered by two different netuids across files", () => {
    const [fileA, fileB] = writeFixtures([
      { netuid: 48, surfaces: [surface({ id: "fixture-a-health" })] },
      { netuid: 63, surfaces: [surface({ id: "fixture-b-health" })] },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fileA,
      fileB,
    ]);

    assert.equal(status, 1);
    assert.match(output, /Cross-file duplicate/);
    assert.match(output, /https:\/\/api\.fixture\.example\/status/);
    assert.match(output, /fixture-a-health/);
    assert.match(output, /fixture-b-health/);
    assert.match(output, /netuid=48/);
    assert.match(output, /netuid=63/);
  });

  test("does not flag the same URL claimed twice within one netuid's own file (that's the #5737 check's job)", () => {
    const [fileA] = writeFixtures([
      {
        netuid: 999,
        surfaces: [
          surface({ id: "fixture-a" }),
          surface({ id: "fixture-b", kind: "data-artifact" }),
        ],
      },
    ]);

    // Single-file run only — the within-file check (#5737) catches this one,
    // not the cross-file check, and asserting on that message here would
    // just re-test #5737's own coverage.
    const { status } = runNode(["scripts/validate-surface.ts", fileA]);
    assert.equal(status, 1);
  });

  test("allows an allowlisted SHARED_OPERATOR_URLS entry across distinct netuids", () => {
    const [fileA, fileB] = writeFixtures([
      {
        netuid: 48,
        surfaces: [
          surface({
            id: "fixture-a-website",
            kind: "website",
            url: "https://www.qbittensorlabs.com/",
            authority: "official",
          }),
        ],
      },
      {
        netuid: 63,
        surfaces: [
          surface({
            id: "fixture-b-website",
            kind: "website",
            url: "https://www.qbittensorlabs.com/",
            authority: "official",
          }),
        ],
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fileA,
      fileB,
    ]);

    assert.equal(status, 0, output);
  });

  test("skips the cross-file check on a single-file invocation (can't see what another netuid claims)", () => {
    const [fileA] = writeFixtures([
      { netuid: 48, surfaces: [surface({ id: "fixture-a-health" })] },
    ]);

    const { status, output } = runNode(["scripts/validate-surface.ts", fileA]);
    assert.equal(status, 0, output);
  });

  test("does not flag the same URL registered twice under the SAME netuid across two files (not a cross-netuid collision)", () => {
    const [fileA, fileB] = writeFixtures([
      { netuid: 48, surfaces: [surface({ id: "fixture-a-health" })] },
      { netuid: 48, surfaces: [surface({ id: "fixture-b-health" })] },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fileA,
      fileB,
    ]);

    assert.equal(status, 0, output);
  });

  test("the full registry has no unresolved cross-file duplicate-URL findings", () => {
    const { status, output } = runNode(["scripts/validate-surface.ts"]);
    assert.equal(status, 0, output);
  });
});

describe("validate-surface.ts cross-file duplicate-URL check does not misfire", () => {
  test("every real subnet file passes when validated together (no false-positive cross-file dedupe)", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 0);
    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      ...files,
    ]);
    assert.equal(status, 0, output);
  });
});
