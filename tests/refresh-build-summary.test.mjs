import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { r2StagingRoot, repoRoot } from "../scripts/lib.mjs";

// build-summary.json lives at the R2 staging root (#1003). It is the artifact the
// refresh script rewrites, so — like the canonical writer in build-artifacts.mjs
// and r2-manifest.mjs — it must exclude build-summary.json (and r2-manifest.json)
// from its own artifact inventory. A stale self-entry would inflate
// artifact_count / artifact_size_bytes and embed a hash of the pre-rewrite file.
test(
  "refresh-build-summary excludes build-summary.json from its own inventory",
  async () => {
  const summaryPath = path.join(r2StagingRoot, "build-summary.json");
  if (!existsSync(summaryPath)) {
    // Requires a populated R2 staging tier (npm run build / artifacts:prepare-local).
    return;
  }

    const scriptUrl = new URL(
      `?refresh-build-summary-test=${Date.now()}`,
      pathToFileURL(path.join(repoRoot, "scripts/refresh-build-summary.mjs")),
    );
    await import(/* @vite-ignore */ scriptUrl.href);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const selfEntries = summary.artifacts.filter(
      (artifact) =>
        artifact.path === "build-summary.json" ||
        artifact.path === "r2-manifest.json",
    );

    assert.deepEqual(selfEntries, []);
  },
  15_000,
);
