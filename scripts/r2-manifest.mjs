import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
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
const manifest = write ? await buildManifest() : await readJson(manifestPath);

const summary = {
  artifact_count: manifest.artifact_count,
  artifact_size_bytes: manifest.artifact_size_bytes,
  bucket_binding: manifest.bucket_binding,
  bucket_name: manifest.bucket_name,
  latest_prefix: manifest.latest_prefix,
  run_prefix: manifest.run_prefix,
};

if (write) {
  await writeJson(manifestPath, manifest);
}

for (const artifact of manifest.artifacts) {
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

async function buildManifest() {
  const generatedAt = buildTimestamp();
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
