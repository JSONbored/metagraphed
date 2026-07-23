// Regression coverage for #6330: validate-surface.mjs now warns (advisory,
// not blocking) when a surface declares auth_required: true with no
// structured auth{} object -- the mistake #6330's audit found 13 live
// instances of across 12 files. Mirrors validate-surface-reviewed-convention
// .test.mjs's subprocess-fixture pattern (spawnSync, not execFileSync, so
// stderr is captured even on a passing run -- the advisory itself is written
// via console.warn).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { listJsonFiles, repoRoot } from "../scripts/lib.ts";

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("validate-surface.mjs auth_required/auth{} advisory", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeFixture(surfaces) {
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
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-auth-`);
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));
    return fixturePath;
  }

  test("warns (advisory, still exits 0) when auth_required is true with no auth object", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-api",
        kind: "subnet-api",
        name: "Fixture API",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: true,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.match(output, /auth_required advisory/);
    assert.match(output, /fixture-api/);
    assert.match(
      output,
      /auth_required is true with no structured auth\{\} object/,
    );
  });

  test("does not warn when auth_required is true and auth is set", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-api",
        kind: "subnet-api",
        name: "Fixture API",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: true,
        auth: { scheme: "bearer" },
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /auth_required advisory/);
  });

  test("does not warn when auth_required is false or absent", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-a",
        kind: "subnet-api",
        name: "Fixture A",
        url: "https://api.fixture.example/a",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
      {
        id: "fixture-b",
        kind: "docs",
        name: "Fixture B",
        url: "https://docs.fixture.example/",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /auth_required advisory/);
  });

  test('auth: { scheme: "custom" } with no location/name satisfies the advisory (custom is a valid honest fallback)', () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-api",
        kind: "subnet-api",
        name: "Fixture API",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: true,
        auth: {
          scheme: "custom",
          scopes_note: "Exact mechanism not publicly documented.",
        },
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /auth_required advisory/);
  });

  test("the full registry has no unresolved auth_required/auth{} advisories", () => {
    // Sanity check the check itself against real data: after #6330's fix,
    // running with no file args (validates every subnet file) must be clean.
    const { status, output } = runNode(["scripts/validate-surface.mjs"]);
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /auth_required advisory/);
  });
});

describe("validate-surface.mjs auth_required/auth{} advisory does not misfire", () => {
  test("every real subnet file individually passes with no advisory (no false positive)", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 0);
    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /auth_required advisory/);
  });
});
