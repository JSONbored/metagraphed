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
import path from "node:path";
import { test } from "vitest";

import { createArtifactBuildHarness } from "./helpers/artifact-build-harness.ts";
import type { Row } from "./row-type.ts";

const harness = createArtifactBuildHarness("artifacts-build-health");

test("artifact build does not preserve forged endpoint index health", () => {
  const endpointsPath = harness.artifactFilePath("endpoints.json");
  // Sandbox-rooted, for the same reason the harness roots its support-artifact
  // paths. Relative, this pointed at the real repo, which also made the setup a
  // no-op against its own purpose: the build reads the SANDBOX's .cache, so
  // clearing the real one never removed the health cache the rebuild consults.
  const cachePath = path.join(
    harness.root,
    ".cache/metagraphed/health/latest.json",
  );
  const original = readFileSync(endpointsPath, "utf8");
  const originalCache = existsSync(cachePath)
    ? readFileSync(cachePath, "utf8")
    : null;
  const supportArtifacts = harness.snapshotSupportArtifacts();
  rmSync(cachePath, { force: true });
  const tampered = JSON.parse(original);
  const target = tampered.endpoints.find(
    (endpoint: Row) => endpoint.public_safe === true,
  );
  assert(target, "expected a public-safe endpoint row to tamper");

  target.health_source = "probe-derived";
  target.monitoring_status = "monitored";
  target.status = "ok";
  target.classification = "live";
  target.last_checked = "2999-01-01T00:00:00.000Z";
  target.last_ok = "2999-01-01T00:00:00.000Z";
  target.observed_at = "2999-01-01T00:00:00.000Z";
  target.latency_ms = 7;
  target.latest_block = 4242424242;
  target.archive_support = true;

  try {
    writeFileSync(endpointsPath, `${JSON.stringify(tampered, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: { ...harness.env, METAGRAPH_PRESERVE_PROBE_HEALTH: "1" },
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(endpointsPath, "utf8"));
    const rebuiltTarget = rebuilt.endpoints.find(
      (endpoint: Row) => endpoint.surface_id === target.surface_id,
    );
    assert.equal(rebuiltTarget.status, "unknown");
    assert.equal(rebuiltTarget.classification, "unknown");
    assert.equal(rebuiltTarget.last_checked, null);
    assert.equal(rebuiltTarget.latency_ms, null);
    assert.equal(rebuiltTarget.latest_block, null);
    assert.equal(rebuiltTarget.archive_support, null);
    assert.equal(rebuiltTarget.health_source, "missing-probe");
  } finally {
    writeFileSync(endpointsPath, original);
    if (originalCache === null) {
      rmSync(cachePath, { force: true });
    } else {
      writeFileSync(cachePath, originalCache);
    }
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: {
        ...harness.env,
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
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
