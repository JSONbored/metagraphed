// Regression coverage for the enum-mismatch message clarity fix: both
// scripts/validate-surface.ts and scripts/validate-schemas.ts previously
// surfaced ajv's bare "must be equal to one of the allowed values" for an
// invalid `kind`, with no indication of what those values actually are.
// Both scripts now append the allowed-values list (and the offending value)
// to enum-keyword error messages.
//
// The "validate-schemas.ts enum error messages" describe block below
// mutates a REAL registry/subnets/*.json file in place (validate-schemas.ts
// takes no file argument, unlike validate-surface.ts, so there's no way to
// point it at an isolated fixture) and restores it in afterEach. That
// transient window raced other tests scanning the same directory under
// vitest's default parallel file execution -- this file is pinned to serial
// execution in package.json's test:ci exclude list (see
// public-safety.test.ts's header comment for the original incident
// writeup). Do not remove it from that list without either fixing
// validate-schemas.ts to accept a file argument or re-verifying there's no
// concurrent full-registry scan left to race.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { listJsonFiles, readJson } from "../scripts/lib.ts";
import { createRepoSandbox } from "./helpers/repo-sandbox.ts";
import type { Row } from "./row-type.ts";

// Every test here spawns a validator as a BLOCKING subprocess, so its wall
// time is whatever a loaded machine gives it -- not what the work costs.
// Measured on a 12-core machine: `node scripts/validate-schemas.ts` takes
// ~2.0s idle and **7.2-7.4s** under 4x CPU oversubscription, which is what a
// full parallel suite looks like. Vitest's 5s default sits inside that band,
// so this file failed a full local `npm test` with a bare "Test timed out in
// 5000ms" while passing in ~1.2s when run alone.
//
// CI never saw it: `test:ci` (scripts/run-ci-tests.ts) passes
// `--testTimeout=30000` for exactly this class of test, and vitest.config.ts's
// comment says so. But `npm test` is plain `vitest run`, as is running one
// file in an editor -- so the timeout belonged to the runner invocation rather
// than to the tests that need it, and every other way of running the suite was
// quietly wrong.
//
// Declaring it here makes the file correct under any runner, and matches
// tests/public-safety.test.ts's SCANNER_TEST_TIMEOUT_MS precedent. 30s is what
// CI already grants -- ~4x the measured loaded worst case -- so this changes no
// CI behaviour, it just stops depending on a flag only one npm script passes.
const VALIDATOR_TEST_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: VALIDATOR_TEST_TIMEOUT_MS });

// The validate-schemas cases below mutate a real registry/subnets file in place
// (the script re-scans the whole registry, so there is no isolated-fixture
// equivalent) and restore it in afterEach. Against the shared tree that raced
// every other full-registry scan -- tests/validate-surface-schema-url.test.ts
// would see the deliberately-invalid `kind` mid-mutation. It gets its own copy
// instead (#8937), which is what let this file leave the serial pass.
// "full" scope: validate-schemas.ts reads beyond the artifact/registry dirs
// (docs/examples/**, among others), so a data-only copy leaves it ENOENT-ing
// partway through the scan.
const sandbox = createRepoSandbox("validate-error-messages", {
  scope: "full",
});
const repoRoot = sandbox.root;
afterAll(() => sandbox.cleanup());

function runNode(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: sandbox.scriptCwd,
      encoding: "utf8",
      env: sandbox.env,
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

describe("validate-surface.ts enum error messages", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("lists the allowed kind values and the offending value on an invalid kind", async () => {
    const [sourceFile] = await listJsonFiles(
      path.join(repoRoot, "registry/subnets"),
    );
    const document = JSON.parse(readFileSync(sourceFile, "utf8"));
    assert.ok(
      Array.isArray(document.surfaces) && document.surfaces.length > 0,
      "fixture subnet file must have at least one surface",
    );
    document.surfaces[0].kind = "totally-invalid-kind";

    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-`);
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode([
      "scripts/validate-surface.ts",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(output, /must be equal to one of the allowed values/);
    // The allowed-values list must actually be present, not just the bare
    // ajv message — this is the behavior being fixed.
    assert.match(output, /subnet-api/);
    assert.match(output, /data-artifact/);
    assert.match(output, /got "totally-invalid-kind"/);
  });
});

describe("validate-schemas.ts enum error messages", () => {
  let mutatedFile: string | undefined;
  let originalContents: string | undefined;

  afterEach(() => {
    if (mutatedFile) {
      writeFileSync(mutatedFile, originalContents!);
      mutatedFile = undefined;
      originalContents = undefined;
    }
  });

  test("lists the allowed kind values and the offending value on an invalid kind", async () => {
    const subnetFiles = await listJsonFiles(
      path.join(repoRoot, "registry/subnets"),
    );
    let targetFile;
    let targetDocument;
    for (const file of subnetFiles) {
      const document = await readJson(file);
      if (Array.isArray(document.surfaces) && document.surfaces.length > 0) {
        targetFile = file;
        targetDocument = document;
        break;
      }
    }
    assert.ok(targetFile, "at least one subnet file must have a surface");

    mutatedFile = targetFile;
    originalContents = readFileSync(mutatedFile, "utf8");
    targetDocument.surfaces[0].kind = "totally-invalid-kind";
    writeFileSync(mutatedFile, JSON.stringify(targetDocument, null, 2));

    const { status, output } = runNode(["scripts/validate-schemas.ts"]);

    assert.equal(status, 1);
    assert.match(output, /must be equal to one of the allowed values/);
    assert.match(output, /subnet-api/);
    assert.match(output, /data-artifact/);
    assert.match(output, /got "totally-invalid-kind"/);
  });

  // #5171: partnership.tier is a deliberately closed enum (just "pilot" today)
  // — a subnet claiming any other tier must be rejected the same way an
  // invalid surface kind is, with the allowed-values list surfaced.
  test("lists the allowed partnership.tier values and the offending value on an invalid tier", async () => {
    const subnetFiles = await listJsonFiles(
      path.join(repoRoot, "registry/subnets"),
    );
    let targetFile;
    let targetDocument;
    for (const file of subnetFiles) {
      const document = await readJson(file);
      if (document.partnership) {
        targetFile = file;
        targetDocument = document;
        break;
      }
    }
    assert.ok(targetFile, "at least one subnet file must have a partnership");

    mutatedFile = targetFile;
    originalContents = readFileSync(mutatedFile, "utf8");
    targetDocument.partnership.tier = "sponsor";
    writeFileSync(mutatedFile, JSON.stringify(targetDocument, null, 2));

    const { status, output } = runNode(["scripts/validate-schemas.ts"]);

    assert.equal(status, 1);
    assert.match(output, /must be equal to one of the allowed values/);
    assert.match(output, /pilot/);
    assert.match(output, /got "sponsor"/);
  });
});
