// Compare the staged registry with the last verified KV publication.
// A configured publisher preserves its live generation if the baseline is unreadable.
import { readPublishedRegistryJson } from "./registry-kv-context.ts";
import path from "node:path";
import { buildChangelog, subnetsOf, type ArtifactEntry } from "./changelog.ts";
import { artifactFilePath, readJson, repoRoot, writeJson } from "./lib.ts";
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

  const previousSubnets = await readPublishedRegistryJson("subnets.json");
  const previousCoverage = await readPublishedRegistryJson("coverage.json");
  const previousManifest = await readPublishedRegistryJson("r2-manifest.json");

  if (!previousSubnets && !previousCoverage && !previousManifest) {
    console.log(
      "build-changelog: no previous registry publication found (first publish or no creds); leaving empty placeholder.",
    );
    return;
  }

  const currentSubnets = await readStagedJson("subnets.json");
  const currentCoverage = await readStagedJson("coverage.json");

  const changelog = buildChangelog({
    contractVersion: placeholder.contract_version,
    generatedAt: placeholder.generated_at,
    currentArtifacts: manifestDigests(stagedManifest),
    currentCoverage: currentCoverage || {},
    currentSubnets: { subnets: subnetsOf(currentSubnets) },
    previousArtifacts: manifestDigests(previousManifest),
    previousCoverage: previousCoverage || null,
    previousSubnets: previousSubnets
      ? { subnets: subnetsOf(previousSubnets) }
      : null,
  });
  const summary = changelog.summary as Row;

  if (dryRun) {
    console.log(
      "build-changelog (dry-run) — diff vs previous registry publication:",
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
    `build-changelog: failed, preserving the current published registry: ${(error as Error)?.message ?? error}`,
  );
  throw error;
});
