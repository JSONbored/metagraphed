import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { r2StagingRoot, repoRoot } from "../scripts/lib.ts";

// build-summary.json lives at the R2 staging root (#1003). It is the artifact the
// refresh script rewrites, so — like the canonical writer in build-artifacts.ts
// and r2-manifest.ts — it must exclude build-summary.json (and r2-manifest.json)
// from its own artifact inventory. A stale self-entry would inflate
// artifact_count / artifact_size_bytes and embed a hash of the pre-rewrite file.
//
// This test rewrites the REAL build-summary.json at the R2 staging root in
// place (refresh-build-summary.ts re-scans the whole staging tree to
// compute the count/size fields, so there's no isolated-fixture equivalent),
// which raced other tests concurrently reading/writing that same tree under
// vitest's default parallel file execution -- pinned to serial execution in
// package.json's test:ci exclude list (see public-safety.test.mjs's header
// comment for the original incident writeup this pattern follows).
test("refresh-build-summary excludes build-summary.json from its own inventory", () => {
  const summaryPath = path.join(r2StagingRoot, "build-summary.json");
  if (!existsSync(summaryPath)) {
    // Requires a populated R2 staging tier (npm run build / artifacts:prepare-local).
    return;
  }

  execFileSync(process.execPath, ["scripts/refresh-build-summary.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const selfEntries = summary.artifacts.filter(
    (artifact) =>
      artifact.path === "build-summary.json" ||
      artifact.path === "r2-manifest.json",
  );

  assert.deepEqual(selfEntries, []);
});
