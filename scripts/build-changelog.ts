// Publish-time changelog (#1003, ADR-0006).
//
// subnets/coverage are R2-only, so there is no committed baseline to diff at
// BUILD time — the build writes an empty placeholder changelog. This script runs
// in the PUBLISH job (which has Cloudflare creds), BEFORE r2-upload overwrites
// `latest/`, and computes the real "what changed since the last publish" diff by
// fetching the previous publish from R2 and diffing it against the freshly-built
// (staged) artifacts. It then overwrites the staged changelog.json so r2-upload
// publishes the real feed and dispatch-webhooks fires on it.
//
// BEST-EFFORT BY DESIGN: any failure (no creds, no wrangler, missing baseline,
// first publish, malformed remote) leaves the build's empty placeholder in place
// and exits 0. It must NEVER fail the publish — a stale/empty changelog for one
// run is recoverable on the next; a broken publish is not.

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  buildChangelog,
  type ArtifactEntry,
  type CoverageSnapshot,
  type SubnetEntry,
} from "./changelog.ts";
import { artifactFilePath, readJson, repoRoot, writeJson } from "./lib.mjs";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";

type Row = Record<string, unknown>;

const dryRun = process.argv.includes("--dry-run");

function wranglerBin(): string {
  return (
    process.env.METAGRAPH_WRANGLER_BIN ||
    path.join(
      repoRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    )
  );
}

// Read a JSON object from R2 `latest/` via the same wrangler call r2-upload uses.
// Returns null on any failure (missing object, no creds, parse error).
function getRemoteR2Json(bucketName: string, key: string): Row | null {
  const result = spawnSync(
    wranglerBin(),
    ["r2", "object", "get", `${bucketName}/${key}`, "--remote", "--pipe"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe" },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function readStagedJson(relativePath: string): Promise<Row | null> {
  try {
    return await readJson(artifactFilePath(relativePath));
  } catch {
    return null;
  }
}

function manifestDigests(manifest: Row | null | undefined): ArtifactEntry[] {
  return ((manifest?.artifacts as Row[] | undefined) || [])
    .filter((entry) => entry?.path)
    .map((entry) => ({
      path: entry.path as string,
      hash: entry.sha256 as string,
    }));
}

async function main(): Promise<void> {
  // The build's placeholder — reuse its stamping so the real changelog keeps the
  // same generated_at/contract_version markers. Its presence also confirms a build ran.
  const placeholder = await readStagedJson("changelog.json");
  if (!placeholder) {
    console.log("build-changelog: no staged changelog placeholder; skipping.");
    return;
  }

  // Read the FULL staged manifest (dist/) — it lists every artifact including
  // R2-tier, matching the full latest/r2-manifest.json we diff against. The
  // compact public/ manifest excludes R2-tier, which would mis-report every
  // R2-only artifact as "removed".
  let stagedManifest: Row | null;
  try {
    stagedManifest = await readJson(
      path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, "r2-manifest.json"),
    );
  } catch {
    stagedManifest = null;
  }
  const bucket = stagedManifest?.bucket_name as string | undefined;
  if (!bucket) {
    console.log(
      "build-changelog: no staged r2-manifest bucket; leaving placeholder.",
    );
    return;
  }

  const previousSubnets = getRemoteR2Json(bucket, "latest/subnets.json");
  const previousCoverage = getRemoteR2Json(bucket, "latest/coverage.json");
  const previousManifest = getRemoteR2Json(bucket, "latest/r2-manifest.json");

  if (!previousSubnets && !previousCoverage && !previousManifest) {
    console.log(
      "build-changelog: no previous R2 publish found (first publish or no creds); leaving empty placeholder.",
    );
    return;
  }

  const currentSubnets = await readStagedJson("subnets.json");
  const currentCoverage = await readStagedJson("coverage.json");

  const changelog = buildChangelog({
    contractVersion: placeholder.contract_version,
    generatedAt: placeholder.generated_at,
    currentArtifacts: manifestDigests(stagedManifest),
    currentCoverage: (currentCoverage || {}) as unknown as CoverageSnapshot,
    currentSubnets: {
      subnets: (currentSubnets?.subnets as SubnetEntry[] | undefined) || [],
    },
    previousArtifacts: manifestDigests(previousManifest),
    previousCoverage: (previousCoverage ||
      null) as unknown as CoverageSnapshot | null,
    previousSubnets: previousSubnets
      ? {
          subnets: (previousSubnets.subnets as SubnetEntry[] | undefined) || [],
        }
      : null,
  });
  const summary = changelog.summary as Row;

  if (dryRun) {
    console.log(
      "build-changelog (dry-run) — diff vs previous R2 publish:",
      JSON.stringify(summary, null, 2),
    );
    return;
  }

  await writeJson(artifactFilePath("changelog.json"), changelog);
  console.log(
    `build-changelog: wrote real diff (subnets +${summary.netuid_added_count}/-${summary.netuid_removed_count}, ${summary.artifact_modified_count} artifacts modified).`,
  );
}

main().catch((error) => {
  // Never fail the publish over the change feed.
  console.warn(
    `build-changelog: failed, leaving the placeholder changelog in place: ${(error as Error)?.message ?? error}`,
  );
});
