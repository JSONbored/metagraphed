// Split out of tests/artifacts.test.ts (#8937 follow-up). Each test here runs a
// full scripts/build-artifacts.ts, which is 7-25s of CI on its own; six of them
// sharing one file made artifacts.test.ts 118.8s of a 144.3s pass and the floor
// for the whole shared-registry run, because vitest parallelizes across FILES
// and never within one. One file per build lets them run on separate workers.
//
// The per-file sandbox clone is ~0.6s against a ~20s build, so the split pays
// for itself many times over.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "vitest";

import { createArtifactBuildHarness } from "./helpers/artifact-build-harness.ts";
import type { Row } from "./row-type.ts";

const harness = createArtifactBuildHarness("artifacts-build-schema-index");

test("artifact build preserves committed schema index without R2 schema details", () => {
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const originalSchemaIndexJson = JSON.parse(originalSchemaIndex);
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const backupDir = mkdtempSync(`${tmpdir()}/metagraphed-schema-r2-`);
  const stagingBackup = `${backupDir}/metagraph-r2`;
  const hadStagingRoot = existsSync(harness.r2StagingRoot);
  if (hadStagingRoot) {
    cpSync(harness.r2StagingRoot, stagingBackup, { recursive: true });
  }

  assert.equal(originalSchemaIndexJson.source, "openapi-snapshot");
  assert.equal(originalSchemaIndexJson.schemas.length > 0, true);

  try {
    rmSync(harness.r2StagingRoot, { recursive: true, force: true });
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });

    const rebuiltSchemaIndex = readFileSync(schemaIndexPath, "utf8");
    assert.deepEqual(JSON.parse(rebuiltSchemaIndex), originalSchemaIndexJson);
  } finally {
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    rmSync(harness.r2StagingRoot, { recursive: true, force: true });
    if (hadStagingRoot) {
      cpSync(stagingBackup, harness.r2StagingRoot, { recursive: true });
    }
    harness.restoreSupportArtifacts(supportArtifacts);
    rmSync(backupDir, { recursive: true, force: true });
  }
}, 120_000);

test("artifact build accepts an OpenAPI-vendor JSON content-type for a captured schema entry", () => {
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const indexTarget = schemaIndex.schemas?.find(
    (schema: Row) => schema.status === "captured",
  );
  assert(indexTarget, "expected a captured schema index entry to retype");

  // A real subnet (SN-71 Leadpoet) serves its OpenAPI document as
  // application/vnd.oai.openapi+json rather than plain application/json -- a
  // spec-valid, OAI-registered media type. schemaIndexEntryMatchesSurface used
  // to require an exact "application/json" match, so this one entry failed the
  // reconciler's forgery/staleness guard and wholesale-discarded the entire
  // committed index down to an empty placeholder (metagraphed#6411).
  indexTarget.content_type = "application/vnd.oai.openapi+json; charset=utf-8";

  try {
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });

    const rebuiltSchemaIndex = JSON.parse(
      readFileSync(schemaIndexPath, "utf8"),
    );
    assert.equal(rebuiltSchemaIndex.source, "openapi-snapshot");
    const rebuiltTarget = rebuiltSchemaIndex.schemas.find(
      (schema: Row) => schema.surface_id === indexTarget.surface_id,
    );
    assert.equal(rebuiltTarget?.content_type, indexTarget.content_type);
    assert.equal(rebuiltTarget?.hash, indexTarget.hash);
  } finally {
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    harness.restoreSupportArtifacts(supportArtifacts);
  }
}, 120_000);
