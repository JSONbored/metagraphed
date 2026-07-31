import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, test } from "vitest";
import { createRepoSandbox } from "./helpers/repo-sandbox.ts";

// build-summary.json lives at the R2 staging root (#1003). It is the artifact the
// refresh script rewrites, so — like the canonical writer in build-artifacts.ts
// and r2-manifest.ts — it must exclude build-summary.json (and r2-manifest.json)
// from its own artifact inventory. A stale self-entry would inflate
// artifact_count / artifact_size_bytes and embed a hash of the pre-rewrite file.
//
// refresh-build-summary.ts re-scans the whole staging tree to compute the
// count/size fields, so there is no isolated-fixture equivalent — it has to
// rewrite a real build-summary.json at a real staging root. It gets its OWN
// staging root (#8937) rather than the shared one, so it no longer races the
// tests that read that tree and no longer needs the serial pass.
const sandbox = createRepoSandbox("refresh-build-summary");
afterAll(() => sandbox.cleanup());

test("refresh-build-summary excludes build-summary.json from its own inventory", () => {
  const summaryPath = path.join(sandbox.r2StagingRoot, "build-summary.json");
  if (!existsSync(summaryPath)) {
    // Requires a populated R2 staging tier (npm run build / artifacts:prepare-local).
    return;
  }

  execFileSync(process.execPath, ["scripts/refresh-build-summary.ts"], {
    cwd: sandbox.scriptCwd,
    encoding: "utf8",
    stdio: "pipe",
    env: sandbox.env,
  });

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const selfEntries = summary.artifacts.filter(
    (artifact: { path: string }) =>
      artifact.path === "build-summary.json" ||
      artifact.path === "r2-manifest.json",
  );

  assert.deepEqual(selfEntries, []);
});
