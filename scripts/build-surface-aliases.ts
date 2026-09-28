// Carry surface aliases forward from the last verified KV publication.
// An unreadable baseline must not silently erase established aliases.
import { readPublishedRegistryJson } from "./registry-kv-context.ts";
import path from "node:path";
import { artifactFilePath, readJson, repoRoot, writeJson } from "./lib.ts";
import {
  buildSurfaceAliasArtifact,
  SURFACE_ALIASES_RELATIVE_PATH,
} from "../src/surface-aliases.ts";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";

type Row = Record<string, unknown>;

const dryRun = process.argv.includes("--dry-run");

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
  const previousSurfaces = await readPublishedRegistryJson("surfaces.json");
  const previousAliases = await readPublishedRegistryJson(
    SURFACE_ALIASES_RELATIVE_PATH,
  );

  if (!previousSurfaces && !previousAliases) {
    console.log(
      "build-surface-aliases: no previous registry surface baseline found; leaving placeholder.",
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
    `build-surface-aliases: failed, preserving the current published registry: ${(error as Error)?.message ?? error}`,
  );
  throw error;
});
