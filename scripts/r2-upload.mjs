import { spawn, spawnSync } from "node:child_process";
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
const uploadConcurrency =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_CONCURRENCY) || 8;
const progressInterval =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_PROGRESS_INTERVAL) || 25;
const uploadRetries =
  parseNonNegativeInteger(process.env.METAGRAPH_R2_UPLOAD_RETRIES) ?? 3;
const uploadRetryBaseDelayMs =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_RETRY_BASE_DELAY_MS) ||
  1000;
const manifest = await readJson(
  path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, "r2-manifest.json"),
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
      upload_retries: uploadRetries,
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
const artifactUploadJobs = [];
const controlUploadJobs = [];

for (const artifact of plannedArtifacts) {
  const localPath = artifactLocalPath(artifact.path);
  verifyLocalArtifact(localPath, artifact);
  const changed =
    forceUpload ||
    remoteManifestResult.status !== "found" ||
    remoteManifestByPath.get(artifact.path) !== artifact.sha256;
  if (changed) {
    changedArtifactCount += 1;
    artifactUploadJobs.push(
      uploadJob(
        localPath,
        artifact.latest_key,
        manifest.bucket_name,
        artifact.content_type,
        "latest",
      ),
    );
  } else {
    skippedArtifactCount += 1;
  }
  if (uploadHistory) {
    artifactUploadJobs.push(
      uploadJob(
        localPath,
        artifact.key,
        manifest.bucket_name,
        artifact.content_type,
        "history",
      ),
    );
  }
}

for (const controlArtifact of plannedControlArtifacts) {
  controlUploadJobs.push(
    uploadJob(
      controlArtifact.local_path,
      controlArtifact.latest_key,
      manifest.bucket_name,
      controlArtifact.content_type,
      "control",
    ),
  );
  if (uploadHistory) {
    controlUploadJobs.push(
      uploadJob(
        controlArtifact.local_path,
        controlArtifact.key,
        manifest.bucket_name,
        controlArtifact.content_type,
        "history",
      ),
    );
  }
}

await putObjects(artifactUploadJobs, {
  concurrency: uploadConcurrency,
  progressInterval,
  retryBaseDelayMs: uploadRetryBaseDelayMs,
  retries: uploadRetries,
});
await putObjects(controlUploadJobs, {
  concurrency: uploadConcurrency,
  progressInterval,
  retryBaseDelayMs: uploadRetryBaseDelayMs,
  retries: uploadRetries,
});

const uploadJobs = [...artifactUploadJobs, ...controlUploadJobs];
const uploadedLatestCount = uploadJobs.filter(
  (job) => job.kind === "latest",
).length;
const uploadedHistoryCount = uploadJobs.filter(
  (job) => job.kind === "history",
).length;
const uploadedControlCount = uploadJobs.filter(
  (job) => job.kind === "control",
).length;

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
    upload_concurrency: uploadConcurrency,
    upload_limit: uploadLimit,
    upload_retries: uploadRetries,
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

function parseNonNegativeInteger(value) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error("Expected a non-negative integer value.");
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
      local_path: path.join(
        repoRoot,
        R2_STAGING_RELATIVE_ROOT,
        "r2-manifest.json",
      ),
      path: "/metagraph/r2-manifest.json",
    },
    {
      content_type: "application/json; charset=utf-8",
      key: `${manifest.run_prefix}r2-manifest.compact.json`,
      latest_key: "latest/r2-manifest.compact.json",
      local_path: path.join(repoRoot, "public/metagraph/r2-manifest.json"),
      path: "/metagraph/r2-manifest.compact.json",
    },
    {
      content_type: "application/json; charset=utf-8",
      key: `${manifest.run_prefix}build-summary.json`,
      latest_key: "latest/build-summary.json",
      // build-summary.json is R2-only (#1003): the build writes it to the R2
      // staging tier, not public/metagraph/. Read it from staging like the full
      // r2-manifest.json above — the old public/ path was left stale by #1003
      // and broke every publish at the control-artifact upload step.
      local_path: path.join(
        repoRoot,
        R2_STAGING_RELATIVE_ROOT,
        "build-summary.json",
      ),
      path: "/metagraph/build-summary.json",
    },
  ];
}

function uploadJob(localPath, key, bucketName, contentType, kind) {
  return {
    bucketName,
    contentType,
    key,
    kind,
    localPath,
  };
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

async function putObjects(
  jobs,
  { concurrency, progressInterval, retries, retryBaseDelayMs },
) {
  if (jobs.length === 0) {
    return;
  }

  let nextIndex = 0;
  let completedCount = 0;
  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex];
        nextIndex += 1;
        await putObject(job, { retries, retryBaseDelayMs });
        completedCount += 1;
        if (
          completedCount === jobs.length ||
          completedCount % progressInterval === 0
        ) {
          console.error(
            `Uploaded ${completedCount}/${jobs.length} R2 object(s).`,
          );
        }
      }
    }),
  );
}

async function putObject(job, { retries, retryBaseDelayMs }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await putObjectOnce(job);
      return;
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      const retryNumber = attempt + 1;
      console.error(
        `Retrying R2 object upload ${job.key} (${retryNumber}/${retries}) after ${summarizeError(error)}`,
      );
      await sleep(retryBaseDelayMs * 2 ** attempt);
    }
  }
}

function putObjectOnce({ localPath, key, bucketName, contentType }) {
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
  return new Promise((resolve, reject) => {
    const child = spawn(wranglerBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          [
            `wrangler r2 object put failed for ${key}`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(error) {
  return String(error?.message || error)
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 240);
}

function wranglerBin() {
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
