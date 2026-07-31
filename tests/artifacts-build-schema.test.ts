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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "vitest";

import { createArtifactBuildHarness } from "./helpers/artifact-build-harness.ts";
import type { Row } from "./row-type.ts";

const harness = createArtifactBuildHarness("artifacts-build-schema");

test("artifact build does not preserve forged schema snapshot metadata", () => {
  const schemaDriftPath = harness.artifactFilePath("schema-drift.json");
  const schemaIndexPath = harness.artifactFilePath("schemas/index.json");
  const originalSchemaDrift = existsSync(schemaDriftPath)
    ? readFileSync(schemaDriftPath, "utf8")
    : null;
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const schemaDrift = originalSchemaDrift
    ? JSON.parse(originalSchemaDrift)
    : null;
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const driftTarget = schemaDrift?.surfaces?.[0];
  const indexTarget =
    schemaIndex.schemas?.find(
      (schema: Row) => schema.surface_id === driftTarget?.surface_id,
    ) ||
    schemaIndex.schemas?.find((schema: Row) => schema.status === "captured");
  assert(indexTarget, "expected a schema index entry to tamper");

  const forgedMarker = "AUTOVALIDATOR_FORGED_METADATA_SHOULD_NOT_SURVIVE_BUILD";
  if (driftTarget) {
    driftTarget.netuid = 999999;
    driftTarget.subnet_slug = forgedMarker;
    driftTarget.url = "https://attacker.invalid/openapi";
    driftTarget.schema_url = "https://attacker.invalid/openapi.json";
    driftTarget.hash = "forged-hash";
  }
  indexTarget.netuid = 999999;
  indexTarget.subnet_slug = forgedMarker;
  indexTarget.url = "https://attacker.invalid/openapi";
  indexTarget.schema_url = "https://attacker.invalid/openapi.json";
  indexTarget.hash = "forged-hash";
  indexTarget.path = "/metagraph/schemas/forged-by-autovalidator.json";
  indexTarget.snapshot = {
    ...indexTarget.snapshot,
    netuid: 999999,
    subnet_slug: forgedMarker,
    surface_url: "https://attacker.invalid/openapi",
    schema_url: "https://attacker.invalid/openapi.json",
    hash: "forged-hash",
    title: forgedMarker,
  };

  try {
    if (schemaDrift) {
      writeFileSync(
        schemaDriftPath,
        `${JSON.stringify(schemaDrift, null, 2)}\n`,
      );
    }
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });

    const rebuiltSchemaDrift = existsSync(schemaDriftPath)
      ? readFileSync(schemaDriftPath, "utf8")
      : "";
    const rebuiltSchemaIndex = readFileSync(schemaIndexPath, "utf8");
    assert.equal(rebuiltSchemaDrift.includes(forgedMarker), false);
    assert.equal(rebuiltSchemaIndex.includes(forgedMarker), false);
    if (rebuiltSchemaDrift) {
      assert.equal(JSON.parse(rebuiltSchemaDrift).source, "artifact-build");
    }
    assert.equal(JSON.parse(rebuiltSchemaIndex).source, "artifact-build");
  } finally {
    if (originalSchemaDrift) {
      writeFileSync(schemaDriftPath, originalSchemaDrift);
    } else {
      rmSync(schemaDriftPath, { force: true });
    }
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-types.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-client.ts", "--write"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/r2-manifest.ts", "--write"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: harness.env,
      stdio: "pipe",
    });
    harness.restoreSupportArtifacts(supportArtifacts);
  }
}, 120_000);
