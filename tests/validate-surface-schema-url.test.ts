// Regression coverage for #6331: validate-surface.ts now fails when a
// surface declares schema_status: "machine-readable" with no schema_url —
// the claim ("a schema is fetchable") needs the URL that backs it up.
// Mirrors validate-surface-duplicate-url.test.mjs's subprocess-fixture pattern.
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

describe("validate-surface.ts schema_url check", () => {
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
    tempDir = mkdtempSync(
      `${tmpdir()}/metagraphed-validate-surface-schema-url-`,
    );
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));
    return fixturePath;
  }

  test("fails when schema_status is machine-readable with no schema_url", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-openapi",
        kind: "openapi",
        name: "Fixture OpenAPI schema",
        url: "https://api.fixture.example/openapi.json",
        provider: "academia",
        authority: "official",
        auth_required: false,
        public_safe: true,
        schema_status: "machine-readable",
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(output, /fixture-openapi/);
    assert.match(
      output,
      /schema_status "machine-readable" requires a non-empty schema_url/,
    );
  });

  test("passes when schema_status is machine-readable and schema_url is set", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-openapi",
        kind: "openapi",
        name: "Fixture OpenAPI schema",
        url: "https://api.fixture.example/openapi.json",
        provider: "academia",
        authority: "official",
        auth_required: false,
        public_safe: true,
        schema_status: "machine-readable",
        schema_url: "https://api.fixture.example/openapi.json",
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 0);
    assert.match(output, /Surface validation passed/);
  });

  test("passes when schema_status is not machine-readable and schema_url is absent", () => {
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
        schema_status: "not-captured",
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 0);
    assert.match(output, /Surface validation passed/);
  });

  test("the full registry has no unresolved schema_url findings", () => {
    // Sanity check the check itself against real data: running with no file
    // args (validates every subnet file) must be clean.
    const { status, output } = runNode(["scripts/validate-surface.ts"]);
    assert.equal(status, 0, output);
  });
});

describe("validate-surface.ts schema_url check does not misfire", () => {
  test("every real subnet file individually passes (no false-positive schema_url findings)", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 0);
    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      ...files,
    ]);
    assert.equal(status, 0, output);
  });
});
