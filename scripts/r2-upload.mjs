import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readJson, repoRoot, sha256Hex, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const uploadHistory = process.env.METAGRAPH_R2_UPLOAD_HISTORY === "1";
const uploadLimit = parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_LIMIT);
const manifest = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
const plannedArtifacts = uploadLimit
  ? manifest.artifacts.slice(0, uploadLimit)
  : manifest.artifacts;
const plannedObjectCount =
  plannedArtifacts.length + (uploadHistory ? plannedArtifacts.length : 0);

if (!write) {
  console.log(
    stableStringify({
      mode: "dry-run",
      artifact_count: manifest.artifact_count,
      bucket_name: manifest.bucket_name,
      limited_artifact_count: plannedArtifacts.length,
      latest_prefix: manifest.latest_prefix,
      run_prefix: manifest.run_prefix,
      upload_history: uploadHistory,
      upload_limit: uploadLimit,
      planned_object_count: plannedObjectCount,
    }),
  );
  process.exit(0);
}

if (process.env.METAGRAPH_ALLOW_R2_UPLOAD !== "1") {
  console.error(
    "Refusing to upload to R2 without METAGRAPH_ALLOW_R2_UPLOAD=1.",
  );
  process.exit(1);
}

for (const artifact of plannedArtifacts) {
  const localPath = path.join(
    repoRoot,
    "public/metagraph",
    artifact.path.replace(/^\/metagraph\//, ""),
  );
  verifyLocalArtifact(localPath, artifact);
  putObject(localPath, artifact.latest_key, manifest.bucket_name);
  if (uploadHistory) {
    putObject(localPath, artifact.key, manifest.bucket_name);
  }
}

console.log(
  `Uploaded ${plannedObjectCount} object(s) for ${plannedArtifacts.length} artifact(s) to R2 bucket ${manifest.bucket_name}.`,
);

function parsePositiveInteger(value) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error("METAGRAPH_R2_UPLOAD_LIMIT must be a positive integer.");
  }
  return parsed;
}

function verifyLocalArtifact(localPath, artifact) {
  const actual = sha256Hex(readFileSync(localPath));
  if (actual !== artifact.sha256) {
    throw new Error(
      `local artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
    );
  }
}

function putObject(localPath, key, bucketName) {
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(
    wranglerBin,
    [
      "r2",
      "object",
      "put",
      `${bucketName}/${key}`,
      "--file",
      localPath,
      "--remote",
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler r2 object put failed for ${key}`);
  }
}
