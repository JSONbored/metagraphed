// Regression coverage for #5737: validate-surface.ts now fails when two
// surfaces[] entries in the same subnet file register the identical URL
// under different ids/kinds (the mistake #5736 found 3 live instances of).
// Mirrors validate-error-messages.test.mjs's subprocess-fixture pattern.
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

describe("validate-surface.ts duplicate-URL check", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeFixture(surfaces: Row[]) {
    const document = {
      schema_version: 1,
      netuid: 999,
      slug: "fixture",
      name: "Fixture Subnet",
      status: "active",
      categories: [],
      links: [],
      surfaces,
    };
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-dup-`);
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));
    return fixturePath;
  }

  test("fails when two surfaces register the exact same URL under different kinds", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-subnet-api",
        kind: "subnet-api",
        name: "Fixture API",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
      {
        id: "fixture-data-artifact",
        kind: "data-artifact",
        name: "Fixture data artifact",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(output, /https:\/\/api\.fixture\.example\/status/);
    assert.match(output, /fixture-subnet-api/);
    assert.match(output, /fixture-data-artifact/);
    assert.match(output, /registered by 2 surfaces/);
  });

  test("catches a duplicate even when only a trailing slash differs", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-a",
        kind: "subnet-api",
        name: "Fixture A",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
      {
        id: "fixture-b",
        kind: "data-artifact",
        name: "Fixture B",
        url: "https://api.fixture.example/status/",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(output, /registered by 2 surfaces/);
  });

  test("passes when every surface's URL is distinct", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-a",
        kind: "subnet-api",
        name: "Fixture A",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
      {
        id: "fixture-b",
        kind: "docs",
        name: "Fixture docs",
        url: "https://docs.fixture.example/",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 0);
    assert.match(output, /Surface validation passed/);
  });

  test("the full registry has no unresolved duplicate-URL findings", () => {
    // Sanity check the check itself against real data: after #5736's fix,
    // running with no file args (validates every subnet file) must be clean.
    const { status, output } = runNode(["scripts/validate-surface.ts"]);
    assert.equal(status, 0, output);
  });
});

describe("validate-surface.ts duplicate-URL check does not misfire", () => {
  test("every real subnet file individually passes (no false-positive dedupe)", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 0);
    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      ...files,
    ]);
    assert.equal(status, 0, output);
  });
});
