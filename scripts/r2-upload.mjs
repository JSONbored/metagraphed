import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readJson, repoRoot, sha256Hex, stableStringify } from "./lib.mjs";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForPath,
} from "../src/artifact-storage.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const uploadHistory = process.env.METAGRAPH_R2_UPLOAD_HISTORY === "1";
const forceUpload = process.env.METAGRAPH_R2_UPLOAD_FORCE === "1";
const uploadLimit = parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_LIMIT);
const manifest = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
const plannedArtifacts = uploadLimit
  ? manifest.artifacts.slice(0, uploadLimit)
  : manifest.artifacts;
const controlArtifacts = buildControlArtifacts(manifest);
const plannedControlArtifacts = uploadLimit ? [] : controlArtifacts;
const plannedObjectCount =
  plannedArtifacts.length +
  plannedControlArtifacts.length +
  (uploadHistory
    ? plannedArtifacts.length + plannedControlArtifacts.length
    : 0);

if (!write) {
  console.log(
    stableStringify({
      mode: "dry-run",
      artifact_count: manifest.artifact_count,
      bucket_name: manifest.bucket_name,
      control_artifact_count: plannedControlArtifacts.length,
      skipped_control_artifact_count:
        controlArtifacts.length - plannedControlArtifacts.length,
      force_upload: forceUpload,
      limited_artifact_count: plannedArtifacts.length,
      latest_prefix: manifest.latest_prefix,
      run_prefix: manifest.run_prefix,
      upload_history: uploadHistory,
      upload_limit: uploadLimit,
      planned_object_count: plannedObjectCount,
      remote_manifest_status: "not-checked",
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

const remoteManifestResult = forceUpload
  ? { status: "not-checked", manifest: null }
  : getRemoteManifest(manifest.bucket_name, "latest/r2-manifest.json");
const remoteManifestByPath = new Map(
  (remoteManifestResult.manifest?.artifacts ?? []).map((artifact) => [
    artifact.path,
    artifact.sha256,
  ]),
);
let changedArtifactCount = 0;
let skippedArtifactCount = 0;
let uploadedLatestCount = 0;
let uploadedHistoryCount = 0;
let uploadedControlCount = 0;

for (const artifact of plannedArtifacts) {
  const localPath = artifactLocalPath(artifact.path);
  verifyLocalArtifact(localPath, artifact);
  const changed =
    forceUpload ||
    remoteManifestResult.status !== "found" ||
    remoteManifestByPath.get(artifact.path) !== artifact.sha256;
  if (!changed) {
    skippedArtifactCount += 1;
    continue;
  }
  changedArtifactCount += 1;
  putObject(
    localPath,
    artifact.latest_key,
    manifest.bucket_name,
    artifact.content_type,
  );
  uploadedLatestCount += 1;
  if (uploadHistory) {
    putObject(
      localPath,
      artifact.key,
      manifest.bucket_name,
      artifact.content_type,
    );
    uploadedHistoryCount += 1;
  }
}

for (const controlArtifact of plannedControlArtifacts) {
  putObject(
    controlArtifact.local_path,
    controlArtifact.latest_key,
    manifest.bucket_name,
    controlArtifact.content_type,
  );
  uploadedControlCount += 1;
  if (uploadHistory) {
    putObject(
      controlArtifact.local_path,
      controlArtifact.key,
      manifest.bucket_name,
      controlArtifact.content_type,
    );
    uploadedHistoryCount += 1;
  }
}

console.log(
  stableStringify({
    mode: "write",
    artifact_count: manifest.artifact_count,
    bucket_name: manifest.bucket_name,
    changed_artifact_count: changedArtifactCount,
    control_artifact_count: plannedControlArtifacts.length,
    skipped_control_artifact_count:
      controlArtifacts.length - plannedControlArtifacts.length,
    force_upload: forceUpload,
    limited_artifact_count: plannedArtifacts.length,
    latest_prefix: manifest.latest_prefix,
    planned_object_count: plannedObjectCount,
    remote_manifest_status: remoteManifestResult.status,
    run_prefix: manifest.run_prefix,
    skipped_artifact_count: skippedArtifactCount,
    upload_history: uploadHistory,
    upload_limit: uploadLimit,
    uploaded_control_count: uploadedControlCount,
    uploaded_history_count: uploadedHistoryCount,
    uploaded_latest_count: uploadedLatestCount,
    uploaded_object_count:
      uploadedLatestCount + uploadedHistoryCount + uploadedControlCount,
  }),
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

function artifactLocalPath(artifactPath) {
  const relativePath = artifactPath.replace(/^\/metagraph\//, "");
  const tier = artifactStorageTierForPath(artifactPath);
  return path.join(
    repoRoot,
    tier === "r2" ? R2_STAGING_RELATIVE_ROOT : "public/metagraph",
    relativePath,
  );
}

function buildControlArtifacts(manifest) {
  return [
    {
      content_type: "application/json; charset=utf-8",
      key: `${manifest.run_prefix}r2-manifest.json`,
      latest_key: "latest/r2-manifest.json",
      local_path: path.join(repoRoot, "public/metagraph/r2-manifest.json"),
      path: "/metagraph/r2-manifest.json",
    },
    {
      content_type: "application/json; charset=utf-8",
      key: `${manifest.run_prefix}build-summary.json`,
      latest_key: "latest/build-summary.json",
      local_path: path.join(repoRoot, "public/metagraph/build-summary.json"),
      path: "/metagraph/build-summary.json",
    },
  ];
}

function getRemoteManifest(bucketName, key) {
  const result = spawnSync(
    wranglerBin(),
    ["r2", "object", "get", `${bucketName}/${key}`, "--remote", "--pipe"],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    return { status: "missing", manifest: null };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.artifacts)) {
      return { status: "unavailable", manifest: null };
    }
    return { status: "found", manifest: parsed };
  } catch {
    return { status: "unavailable", manifest: null };
  }
}

function putObject(localPath, key, bucketName, contentType) {
  const args = [
    "r2",
    "object",
    "put",
    `${bucketName}/${key}`,
    "--file",
    localPath,
    "--remote",
  ];
  if (contentType) {
    args.push("--content-type", contentType);
  }
  const result = spawnSync(wranglerBin(), args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler r2 object put failed for ${key}`);
  }
}

function wranglerBin() {
  return path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
}
