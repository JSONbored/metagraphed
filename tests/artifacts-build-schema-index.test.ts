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
  // spec-valid, OAI-registered media type. schemaIndexEntryMismatch used
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

test("a renamed subnet does not wholesale-discard the committed schema index", () => {
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const capturedBefore = (schemaIndex.schemas ?? []).filter(
    (schema: Row) => schema.status === "captured",
  );
  const indexTarget = capturedBefore[0];
  assert(indexTarget, "expected a captured schema index entry to rename");
  assert(
    capturedBefore.length > 1,
    "need >1 captured entry to prove wholesale",
  );

  // Same failure shape as the content-type case above (metagraphed#6411), with
  // a cause nobody can prevent: the subnet renamed itself on chain. Since #9748
  // the chain names the subnet, so that new name flows into surface.subnet_name
  // -- and the reconciler compared snapshot.subnet_name to it, called the
  // mismatch a forgery, and discarded EVERY captured schema for EVERY subnet.
  // Measured on the real registry: 26 renamed subnets took all 227 captured
  // schemas down with them (metagraphed#9909).
  //
  // A display name is not identity. surface_id, netuid, subnet_slug, the
  // surface url, the schema url and the document hash all still have to match.
  (indexTarget.snapshot ??= {}).subnet_name = "Renamed On Chain";

  try {
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(schemaIndexPath, "utf8"));
    // The whole point: the index is REUSED, not replaced by the placeholder.
    assert.equal(rebuilt.source, "openapi-snapshot");
    const capturedAfter = (rebuilt.schemas ?? []).filter(
      (schema: Row) => schema.status === "captured",
    );
    assert.equal(
      capturedAfter.length,
      capturedBefore.length,
      "a rename must not drop any captured schema",
    );
    // And the renamed entry itself keeps its captured document.
    const rebuiltTarget = rebuilt.schemas.find(
      (schema: Row) => schema.surface_id === indexTarget.surface_id,
    );
    assert.equal(rebuiltTarget?.status, "captured");
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

test("one tampered entry is dropped, and only that entry (#11147)", () => {
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const summaryPath = harness.artifactFilePath("build-summary.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const originalSummary = readFileSync(summaryPath, "utf8");
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const target = schemaIndex.schemas?.find(
    (schema: Row) => schema.status === "captured",
  );
  assert(target, "expected a captured schema index entry to tamper");
  const capturedBefore = schemaIndex.schemas.filter(
    (schema: Row) => schema.status === "captured",
  ).length;

  // #9909 made the discard loud; #11147 made it PROPORTIONATE. Refusing a
  // tampered entry is still correct and still happens -- what changed is that it
  // no longer takes every other subnet's captured schema with it. In production
  // one subnet changing its published spec cost the other 56 their schema on
  // every publish for 11 days, which is a denial of service the guard was never
  // meant to grant.
  (target.snapshot ??= {}).hash = "forged-by-this-test";

  try {
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    // The build must still SUCCEED. Failing here would let a tampered committed
    // file deny the whole pipeline, which is why the CI control lives in
    // validate.ts instead -- see tests/artifacts-build-schema.test.ts for the
    // attacker case this protects.
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(schemaIndexPath, "utf8"));
    const entry = rebuilt.schemas.find(
      (schema: Row) => schema.surface_id === target.surface_id,
    );
    // The tampered entry loses its captured claim -- the forgery is refused.
    assert(entry, "the surface must still be listed");
    assert.equal(entry.status, "not-captured");
    assert.equal(entry.hash, null);
    // ...and nothing else does. This is the whole point: the index survives.
    const capturedAfter = rebuilt.schemas.filter(
      (schema: Row) => schema.status === "captured",
    ).length;
    assert.equal(capturedAfter, capturedBefore - 1);
    assert.equal(rebuilt.source, "openapi-snapshot");
    // A proportionate rejection is not a wholesale discard, so the CI gate --
    // which fails on ANY dropped_captured -- must not fire for it.
    assert.equal(
      JSON.parse(readFileSync(summaryPath, "utf8")).schema_index_discard,
      null,
    );
  } finally {
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    writeFileSync(summaryPath, originalSummary);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    harness.restoreSupportArtifacts(supportArtifacts);
  }
}, 120_000);

test("a structurally unusable index is still discarded wholesale, and recorded for CI", () => {
  // The wholesale path stays, and validate.ts still gates on it: an index that
  // is not a schema snapshot at all cannot be vetted entry by entry, because
  // there is nothing to trust about its shape.
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const summaryPath = harness.artifactFilePath("build-summary.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const originalSummary = readFileSync(summaryPath, "utf8");
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const capturedBefore = schemaIndex.schemas.filter(
    (schema: Row) => schema.status === "captured",
  ).length;
  schemaIndex.source = "not-an-openapi-snapshot";

  try {
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    const discard = JSON.parse(readFileSync(summaryPath, "utf8"))
      .schema_index_discard as Row;
    assert(discard, "the discard must be recorded on the build summary");
    assert.equal(discard.dropped_captured, capturedBefore);
    assert.match(String(discard.reason), /no reusable committed index/);
  } finally {
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    writeFileSync(summaryPath, originalSummary);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    harness.restoreSupportArtifacts(supportArtifacts);
  }
}, 120_000);

test("a healthy build records no discard", () => {
  const summary = JSON.parse(
    readFileSync(harness.artifactFilePath("build-summary.json"), "utf8"),
  );
  // Positive control: without this, the assertions above could pass against a
  // build that always records a discard.
  assert.equal(summary.schema_index_discard, null);
});
