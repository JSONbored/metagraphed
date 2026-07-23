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
// public-safety.test.mjs's header comment for the original incident
// writeup). Do not remove it from that list without either fixing
// validate-schemas.ts to accept a file argument or re-verifying there's no
// concurrent full-registry scan left to race.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { listJsonFiles, readJson, repoRoot } from "../scripts/lib.ts";

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

describe("validate-surface.ts enum error messages", () => {
  let tempDir;

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
  let mutatedFile;
  let originalContents;

  afterEach(() => {
    if (mutatedFile) {
      writeFileSync(mutatedFile, originalContents);
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
