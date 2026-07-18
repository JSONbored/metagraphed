// Regression coverage for #6331: validate-surface.mjs now fails when a
// surface claims schema_status: "machine-readable" with no schema_url (the
// mistake #6331's audit found 6 live instances of, each an openapi-kind
// surface). Mirrors validate-surface-duplicate-url.test.mjs's subprocess-
// fixture pattern.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { listJsonFiles, repoRoot } from "../scripts/lib.mjs";

function runNode(args) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("validate-surface.mjs schema_status/schema_url check", () => {
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
        authority: "community",
        auth_required: false,
        public_safe: true,
        schema_status: "machine-readable",
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
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
        authority: "community",
        auth_required: false,
        public_safe: true,
        schema_status: "machine-readable",
        schema_url: "https://api.fixture.example/openapi.json",
        review: { state: "community-submitted" },
      },
    ]);

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0);
    assert.match(output, /Surface validation passed/);
  });

  test("passes when schema_status is ui-only or not-captured with no schema_url", () => {
    for (const schemaStatus of ["ui-only", "not-captured"]) {
      const fixturePath = writeFixture([
        {
          id: "fixture-docs",
          kind: "docs",
          name: "Fixture docs",
          url: "https://docs.fixture.example/",
          provider: "academia",
          authority: "community",
          auth_required: false,
          public_safe: true,
          schema_status: schemaStatus,
          review: { state: "community-submitted" },
        },
      ]);

      const { status, output } = runNode([
        "scripts/validate-surface.mjs",
        fixturePath,
      ]);

      assert.equal(status, 0, `${schemaStatus}: ${output}`);
    }
  });

  test("passes when a surface has neither field at all", () => {
    const fixturePath = writeFixture([
      {
        id: "fixture-api",
        kind: "subnet-api",
        name: "Fixture API",
        url: "https://api.fixture.example/status",
        provider: "academia",
        authority: "community",
        auth_required: false,
        public_safe: true,
        review: { state: "community-submitted" },
      },
    ]);

    const { status } = runNode(["scripts/validate-surface.mjs", fixturePath]);

    assert.equal(status, 0);
  });

  test("the full registry has no unresolved schema_status/schema_url findings", () => {
    // Sanity check the check itself against real data: after #6331's fix,
    // running with no file args (validates every subnet file) must be clean.
    const { status, output } = runNode(["scripts/validate-surface.mjs"]);
    assert.equal(status, 0, output);
  });
});

describe("validate-surface.mjs schema_status/schema_url check does not misfire", () => {
  test("every real subnet file individually passes (no false positive)", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 0);
    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);
    assert.equal(status, 0, output);
  });
});
