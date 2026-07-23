// Publish-time surface alias map (#1005).
//
// surfaces.json is R2-only, so a normal deterministic build cannot compare
// against the previous publish. The build emits an empty placeholder; this
// publish-only script fetches previous latest/ surfaces + aliases from R2 and
// overwrites the staged surface-aliases.json before r2-upload.
//
// BEST-EFFORT BY DESIGN: failures leave the placeholder in place and exit 0.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { artifactFilePath, readJson, repoRoot, writeJson } from "./lib.ts";
import {
  buildSurfaceAliasArtifact,
  SURFACE_ALIASES_RELATIVE_PATH,
} from "../src/surface-aliases.ts";
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

function getRemoteR2Json(bucketName: string, key: string): Row | null {
  const result = spawnSync(
    wranglerBin(),
    ["r2", "object", "get", `${bucketName}/${key}`, "--remote", "--pipe"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe" },
  );
  if (result.status !== 0) return null;
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

async function main(): Promise<void> {
  const placeholder = await readStagedJson(SURFACE_ALIASES_RELATIVE_PATH);
  if (!placeholder) {
    console.log("build-surface-aliases: no staged placeholder; skipping.");
    return;
  }

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
      "build-surface-aliases: no staged r2-manifest bucket; leaving placeholder.",
    );
    return;
  }

  const currentSurfaces = await readStagedJson("surfaces.json");
  const previousSurfaces = getRemoteR2Json(bucket, "latest/surfaces.json");
  const previousAliases = getRemoteR2Json(
    bucket,
    `latest/${SURFACE_ALIASES_RELATIVE_PATH}`,
  );

  if (!previousSurfaces && !previousAliases) {
    console.log(
      "build-surface-aliases: no previous R2 surface baseline found; leaving placeholder.",
    );
    return;
  }

  const aliases = buildSurfaceAliasArtifact({
    contractVersion: placeholder.contract_version,
    currentSurfaces: (currentSurfaces?.surfaces as Row[]) || [],
    generatedAt: placeholder.generated_at,
    previousAliases,
    previousSurfaces: (previousSurfaces?.surfaces as Row[]) || [],
  });
  const summary = aliases.summary as Row;

  if (dryRun) {
    console.log(
      "build-surface-aliases (dry-run):",
      JSON.stringify(summary, null, 2),
    );
    return;
  }

  await writeJson(artifactFilePath(SURFACE_ALIASES_RELATIVE_PATH), aliases);
  console.log(
    `build-surface-aliases: wrote ${summary.alias_count} deprecated surface alias(es).`,
  );
}

main().catch((error) => {
  console.warn(
    `build-surface-aliases: failed, leaving the placeholder in place: ${(error as Error)?.message ?? error}`,
  );
});
