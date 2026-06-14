import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import {
  buildTimestamp,
  readJson,
  repoRoot,
  sha256Hex,
  stableStringify,
  writeJson,
} from "./lib.mjs";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const manifestPath = path.join(repoRoot, "public/metagraph/r2-manifest.json");
const fullManifestPath = path.join(
  repoRoot,
  R2_STAGING_RELATIVE_ROOT,
  "r2-manifest.json",
);
const r2StagingRoot = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
const manifest = write ? null : await readJson(manifestPath);
const fullManifest = write
  ? await buildManifest()
  : existsSync(r2StagingRoot)
    ? await buildManifest(manifest.generated_at)
    : await readJson(fullManifestPath).catch(() => null);
const compactManifest = write ? buildCompactManifest(fullManifest) : manifest;
const validationManifest = fullManifest || compactManifest;

if (!write && fullManifest) {
  const expectedManifest = buildCompactManifest(fullManifest);
  if (stableStringify(compactManifest) !== stableStringify(expectedManifest)) {
    console.error(
      stableStringify({
        error: "r2 compact manifest is stale",
        expected_artifact_count: expectedManifest.artifact_count,
        actual_artifact_count: compactManifest.artifact_count,
        expected_full_artifact_count: expectedManifest.full_artifact_count,
        actual_full_artifact_count: compactManifest.full_artifact_count,
      }),
    );
    process.exit(1);
  }
}

const summary = {
  artifact_count: compactManifest.artifact_count,
  artifact_size_bytes: compactManifest.artifact_size_bytes,
  bucket_binding: compactManifest.bucket_binding,
  bucket_name: compactManifest.bucket_name,
  full_artifact_count:
    compactManifest.full_artifact_count || compactManifest.artifact_count,
  manifest_kind: compactManifest.manifest_kind || "full",
  latest_prefix: compactManifest.latest_prefix,
  run_prefix: compactManifest.run_prefix,
};

if (write) {
  await mkdir(path.dirname(fullManifestPath), { recursive: true });
  await writeJson(fullManifestPath, fullManifest);
  await writeJson(manifestPath, compactManifest);
}

for (const artifact of validationManifest.artifacts) {
  if (
    !artifact.key ||
    !artifact.latest_key ||
    !artifact.path ||
    !artifact.sha256 ||
    !Number.isInteger(artifact.size_bytes)
  ) {
    console.error(
      `Invalid R2 manifest artifact entry: ${stableStringify(artifact)}`,
    );
    process.exit(1);
  }
}

console.log(stableStringify(summary));

async function buildManifest(generatedAt = buildTimestamp()) {
  const version = generatedAt.replace(/[:.]/g, "-");
  const publicRoot = path.join(repoRoot, "public/metagraph");
  const r2Root = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
  const files = await listManifestArtifactFiles({ publicRoot, r2Root });
  const artifacts = [];
  for (const { file, root } of files) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (["build-summary.json", "r2-manifest.json"].includes(relative)) {
      continue;
    }
    const raw = await readFile(file);
    const fileStat = await stat(file);
    artifacts.push({
      content_type: contentTypeFor(relative),
      key: `runs/${version}/${relative}`,
      latest_key: `latest/${relative}`,
      path: `/metagraph/${relative}`,
      sha256: sha256Hex(raw),
      size_bytes: fileStat.size,
      storage_tier: artifactStorageTierForRelativePath(relative),
    });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema_version: 1,
    contract_version: "2026-06-06.1",
    generated_at: generatedAt,
    bucket_binding: "METAGRAPH_ARCHIVE",
    bucket_name: "metagraphed-artifacts",
    latest_prefix: "latest/",
    run_prefix: `runs/${version}/`,
    artifact_count: artifacts.length,
    artifact_size_bytes: artifacts.reduce(
      (sum, artifact) => sum + artifact.size_bytes,
      0,
    ),
    artifacts,
  };
}

function buildCompactManifest(fullManifest) {
  const compactArtifacts = fullManifest.artifacts.filter(
    (artifact) => artifact.storage_tier !== "r2",
  );
  return {
    ...fullManifest,
    manifest_kind: "compact",
    full_manifest_key: `${fullManifest.latest_prefix}r2-manifest.json`,
    full_manifest_run_key: `${fullManifest.run_prefix}r2-manifest.json`,
    full_artifact_count: fullManifest.artifact_count,
    full_artifact_size_bytes: fullManifest.artifact_size_bytes,
    artifact_count: compactArtifacts.length,
    artifact_size_bytes: compactArtifacts.reduce(
      (sum, artifact) => sum + artifact.size_bytes,
      0,
    ),
    required_artifact_paths: [
      "/metagraph/candidates.json",
      "/metagraph/review-queue.json",
      "/metagraph/review/enrichment-evidence.json",
      "/metagraph/review/enrichment-targets.json",
      "/metagraph/source-snapshots.json",
      "/metagraph/types.d.ts",
      "/metagraph/verification/latest.json",
    ],
    storage_tier_counts: countByStorageTier(fullManifest.artifacts),
    storage_tier_size_bytes: sumBytesByStorageTier(fullManifest.artifacts),
    artifacts: compactArtifacts,
  };
}

function countByStorageTier(artifacts) {
  return artifacts.reduce((counts, artifact) => {
    counts[artifact.storage_tier] = (counts[artifact.storage_tier] || 0) + 1;
    return counts;
  }, {});
}

function sumBytesByStorageTier(artifacts) {
  return artifacts.reduce((counts, artifact) => {
    counts[artifact.storage_tier] =
      (counts[artifact.storage_tier] || 0) + artifact.size_bytes;
    return counts;
  }, {});
}

async function listManifestArtifactFiles({ publicRoot, r2Root }) {
  const publicFiles = (await listArtifactFiles(publicRoot))
    .filter((file) => {
      const relative = path.relative(publicRoot, file).replace(/\\/g, "/");
      return artifactStorageTierForRelativePath(relative) !== "r2";
    })
    .map((file) => ({ file, root: publicRoot }));
  const r2Files = (await listArtifactFiles(r2Root)).map((file) => ({
    file,
    root: r2Root,
  }));
  return [...publicFiles, ...r2Files].sort((a, b) => {
    const left = path.relative(a.root, a.file).replace(/\\/g, "/");
    const right = path.relative(b.root, b.file).replace(/\\/g, "/");
    return left.localeCompare(right);
  });
}

async function listArtifactFiles(dirPath) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(entryPath)));
    } else if (entry.isFile() && isManifestedArtifact(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isManifestedArtifact(fileName) {
  return fileName.endsWith(".json") || fileName.endsWith(".d.ts");
}

function contentTypeFor(relativePath) {
  if (relativePath.endsWith(".d.ts")) {
    return "text/plain; charset=utf-8";
  }
  return "application/json";
}
