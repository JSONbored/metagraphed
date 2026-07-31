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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

import { createArtifactBuildHarness } from "./helpers/artifact-build-harness.ts";
import type { Row } from "./row-type.ts";

const harness = createArtifactBuildHarness("artifacts-build-determinism");

// #510 refactor invariant: the artifact build is deterministic, so two
// consecutive builds (epoch timestamp, no METAGRAPH_BUILD_TIMESTAMP) must emit a
// byte-identical R2 staging tree. This is the regression guard that lets the
// build-artifacts/lib decomposition stay safe — any future code-motion that
// silently reorders keys, changes a number, or drops an artifact flips this hash.
// It deliberately compares the whole staging tree (not a hardcoded golden), so it
// never needs touching when the committed source data legitimately refreshes.
function digestArtifactTree(root: string) {
  const hash = createHash("sha256");
  for (const file of harness
    .walkFiles(root)
    .filter((file) => path.basename(file) !== ".DS_Store") // OS noise, not an artifact
    .sort()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

test("artifact build is deterministic (byte-identical across rebuilds)", () => {
  const supportArtifacts = harness.snapshotSupportArtifacts();
  const buildEnv: Row = {
    ...harness.env,
    METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
  };
  delete buildEnv.METAGRAPH_BUILD_TIMESTAMP; // force the reproducible epoch
  const runBuild = () =>
    execFileSync(process.execPath, ["scripts/build-artifacts.ts"], {
      cwd: harness.scriptCwd,
      encoding: "utf8",
      env: buildEnv as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
    });
  try {
    runBuild();
    const firstDigest = digestArtifactTree(harness.r2StagingRoot);

    // The build must actually produce the artifacts whose derivation was
    // extracted to scripts/lib/ — a broken import would yield empty/missing
    // output, which this asserts before the cheaper hash comparison.
    for (const relativePath of [
      "endpoints.json",
      "rpc-endpoints.json",
      "economics.json",
      "endpoint-pools.json",
      "endpoint-incidents.json",
    ]) {
      const artifact = harness.readArtifact(relativePath);
      assert.ok(
        artifact && typeof artifact === "object",
        `${relativePath} should build to a non-empty object`,
      );
    }

    runBuild();
    const secondDigest = digestArtifactTree(harness.r2StagingRoot);

    assert.equal(
      secondDigest,
      firstDigest,
      "two consecutive builds must emit a byte-identical R2 staging tree",
    );
  } finally {
    runBuild();
    harness.restoreSupportArtifacts(supportArtifacts);
  }
}, 120_000);
