import { readFileSync } from "node:fs";
import path from "node:path";
import { readJson, repoRoot, sha256Hex, stableStringify } from "./lib.ts";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForPath,
} from "../src/artifact-storage.ts";

type Row = Record<string, unknown>;

interface Artifact {
  content_type: string;
  key: string;
  latest_key: string;
  path: string;
  sha256: string;
  size_bytes: number;
  storage_tier: string;
}

interface ControlArtifact {
  content_type: string;
  key: string;
  latest_key: string;
  local_path: string;
  path: string;
}

interface UploadJob {
  bucketName: string;
  contentType: string;
  key: string;
  kind: string;
  localPath: string;
}

interface RemoteManifestResult {
  status: string;
  manifest: Row | null;
}

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const uploadHistory = process.env.METAGRAPH_R2_UPLOAD_HISTORY === "1";
const forceUpload = process.env.METAGRAPH_R2_UPLOAD_FORCE === "1";
const uploadLimit = parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_LIMIT);
// #stale-publish-pipeline/B: each object upload spawns its own `wrangler`
// subprocess (see putObjectOnce below), so wall-clock time scales with
// object_count / concurrency, not raw bytes. METAGRAPH_R2_UPLOAD_HISTORY=1
// (always set in publish-cloudflare.yml) uploads BOTH a "latest" and a
// "history" copy of every tracked artifact every run (~2,325 artifacts as of
// 2026-07-26, so ~4,650 uploads/run) -- registry growth since this default
// was set had pushed the publish job's "Upload artifact history to R2" step
// to consistently exceed the job's 45-minute timeout-minutes ceiling at the
// old concurrency of 8, cancelling the step (and the whole publish -- R2
// never gets the fresh artifacts, KV `latest` pointer never flips) on every
// run since ~2026-07-23. Raised with real headroom, paired with a matching
// timeout-minutes increase in publish-cloudflare.yml as a safety margin (see
// that workflow's own comment) rather than relying on concurrency alone.
const uploadConcurrency =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_CONCURRENCY) || 24;
const progressInterval =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_PROGRESS_INTERVAL) || 25;
const uploadRetries =
  parseNonNegativeInteger(process.env.METAGRAPH_R2_UPLOAD_RETRIES) ?? 3;
const uploadRetryBaseDelayMs =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_RETRY_BASE_DELAY_MS) ||
  1000;
const uploadTimeoutMs =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_TIMEOUT_MS) || 45_000;
// #stale-publish-pipeline/D: replacing the per-object wrangler subprocess with
// direct API fetches (#8209) removed the CLI overhead and exposed the next
// ceiling — Cloudflare's client-API rate limit (documented ~1,200 requests /
// 5 minutes per token; every HEAD dedupe probe and every PUT counts). The
// 2026-07-26 run died in mass HTTP 429s ("code 971: Please wait and consider
// throttling your request speed"): 24 workers kept firing while each failing
// object burned its 3 quick retries (1s/2s/4s — meaningless against a
// 5-minute window) and the first object to exhaust them aborted the whole
// publish. Two-part fix: a request-rate gate shared by every worker (default
// 3.5 rps ≈ 1,050 per 5 minutes, ~12% under the ceiling), and 429-aware
// retries that honor Retry-After, back off in tens of seconds, and push a
// shared cooldown so ALL workers pause together instead of 23 siblings
// draining the budget while one sleeps.
const uploadMaxRps =
  parsePositiveNumber(process.env.METAGRAPH_R2_UPLOAD_MAX_RPS) || 3.5;
const uploadRateLimitRetries =
  parseNonNegativeInteger(process.env.METAGRAPH_R2_UPLOAD_429_RETRIES) ?? 6;
const uploadRateLimitBaseDelayMs =
  parsePositiveInteger(process.env.METAGRAPH_R2_UPLOAD_429_BASE_DELAY_MS) ||
  15_000;
const uploadRateLimitMaxDelayMs = 120_000;

// Shared pacing across all workers. Each request claims the next slot on a
// common clock (Node is single-threaded, so the read-modify-write below is
// race-free), and a 429 pushes a shared cooldown so every worker stalls
// together instead of the survivors draining the 5-minute budget while one
// backs off. Declared here, above the script's top-level execution, so the
// bindings exist before the first upload runs (class/let are not hoisted).
let nextRequestSlot = 0;
let cooldownUntil = 0;

async function rateGate(): Promise<void> {
  const interval = 1000 / uploadMaxRps;
  for (;;) {
    const slot = Math.max(Date.now(), nextRequestSlot, cooldownUntil);
    nextRequestSlot = slot + interval;
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
    // A 429 may have pushed the shared cooldown past our claimed slot while
    // we slept — re-claim instead of firing into a known-throttled window.
    if (Date.now() >= cooldownUntil) return;
  }
}

function pushCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

class R2PutError extends Error {
  status?: number;
  retryAfterMs?: number;
}
// Test-only seam (mirrors the old METAGRAPH_WRANGLER_BIN override this
// replaced): lets tests/r2-upload.test.ts point at a local mock HTTP server
// instead of the real Cloudflare API. Never set in production.
const r2ApiBaseUrl =
  process.env.METAGRAPH_R2_API_BASE_URL ||
  "https://api.cloudflare.com/client/v4";
const manifest: Row = await readJson(
  path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, "r2-manifest.json"),
);
const allArtifacts = manifest.artifacts as Artifact[];
const plannedArtifacts = uploadLimit
  ? allArtifacts.slice(0, uploadLimit)
  : allArtifacts;
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
      upload_timeout_ms: uploadTimeoutMs,
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

const remoteManifestResult: RemoteManifestResult = forceUpload
  ? { status: "not-checked", manifest: null }
  : await getRemoteManifest(
      manifest.bucket_name as string,
      "latest/r2-manifest.json",
    );
const remoteManifestShaByPath = new Map(
  (
    (remoteManifestResult.manifest?.artifacts as Artifact[] | undefined) ?? []
  ).map((artifact) => [artifact.path, artifact.sha256]),
);
let changedArtifactCount = 0;
let skippedArtifactCount = 0;
const artifactUploadJobs: UploadJob[] = [];
const controlUploadJobs: UploadJob[] = [];

for (const artifact of plannedArtifacts) {
  const localPath = artifactLocalPath(artifact.path);
  verifyLocalArtifact(localPath, artifact);
  const changed =
    forceUpload ||
    remoteManifestResult.status !== "found" ||
    remoteManifestShaByPath.get(artifact.path) !== artifact.sha256;
  if (changed) {
    changedArtifactCount += 1;
    artifactUploadJobs.push(
      uploadJob(
        localPath,
        artifact.latest_key,
        manifest.bucket_name as string,
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
        manifest.bucket_name as string,
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
      manifest.bucket_name as string,
      controlArtifact.content_type,
      "control",
    ),
  );
  if (uploadHistory) {
    controlUploadJobs.push(
      uploadJob(
        controlArtifact.local_path,
        controlArtifact.key,
        manifest.bucket_name as string,
        controlArtifact.content_type,
        "history",
      ),
    );
  }
}

const artifactHistoryDedupedCount = await putObjects(artifactUploadJobs, {
  concurrency: uploadConcurrency,
  progressInterval,
  retryBaseDelayMs: uploadRetryBaseDelayMs,
  retries: uploadRetries,
});
const controlHistoryDedupedCount = await putObjects(controlUploadJobs, {
  concurrency: uploadConcurrency,
  progressInterval,
  retryBaseDelayMs: uploadRetryBaseDelayMs,
  retries: uploadRetries,
});
const dedupedHistoryCount =
  artifactHistoryDedupedCount + controlHistoryDedupedCount;

const uploadJobs = [...artifactUploadJobs, ...controlUploadJobs];
const uploadedLatestCount = uploadJobs.filter(
  (job) => job.kind === "latest",
).length;
const historyJobCount = uploadJobs.filter(
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
    upload_timeout_ms: uploadTimeoutMs,
    uploaded_control_count: uploadedControlCount,
    // #8208: history objects are content-addressed (by-hash/<sha256>, see
    // r2-manifest.ts), so a history job whose object already exists remotely
    // is skipped rather than re-uploaded -- deduplicated_history_count is how
    // many of historyJobCount avoided a real PUT this run.
    uploaded_history_count: historyJobCount - dedupedHistoryCount,
    deduplicated_history_count: dedupedHistoryCount,
    uploaded_latest_count: uploadedLatestCount,
    uploaded_object_count:
      uploadedLatestCount +
      (historyJobCount - dedupedHistoryCount) +
      uploadedControlCount,
  }),
);

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error("METAGRAPH_R2_UPLOAD_LIMIT must be a positive integer.");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error("Expected a non-negative integer value.");
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Expected a positive number value.");
  }
  return parsed;
}

function verifyLocalArtifact(localPath: string, artifact: Artifact): void {
  const actual = sha256Hex(readFileSync(localPath));
  if (actual !== artifact.sha256) {
    throw new Error(
      `local artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
    );
  }
}

function artifactLocalPath(artifactPath: string): string {
  const relativePath = artifactPath.replace(/^\/metagraph\//, "");
  const tier = artifactStorageTierForPath(artifactPath);
  return path.join(
    repoRoot,
    tier === "r2" ? R2_STAGING_RELATIVE_ROOT : "public/metagraph",
    relativePath,
  );
}

function buildControlArtifacts(manifest: Row): ControlArtifact[] {
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

function uploadJob(
  localPath: string,
  key: string,
  bucketName: string,
  contentType: string,
  kind: string,
): UploadJob {
  return {
    bucketName,
    contentType,
    key,
    kind,
    localPath,
  };
}

async function getRemoteManifest(
  bucketName: string,
  key: string,
): Promise<RemoteManifestResult> {
  const { accountId, apiToken } = requireCloudflareCredentials();
  try {
    const res = await fetch(r2ObjectUrl(accountId, bucketName, key), {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });
    if (!res.ok) {
      return { status: "missing", manifest: null };
    }
    const parsed = await res.json();
    if (!Array.isArray((parsed as Row)?.artifacts)) {
      return { status: "unavailable", manifest: null };
    }
    return { status: "found", manifest: parsed as Row };
  } catch {
    return { status: "unavailable", manifest: null };
  }
}

async function putObjects(
  jobs: UploadJob[],
  {
    concurrency,
    progressInterval,
    retries,
    retryBaseDelayMs,
  }: {
    concurrency: number;
    progressInterval: number;
    retries: number;
    retryBaseDelayMs: number;
  },
): Promise<number> {
  if (jobs.length === 0) {
    return 0;
  }

  let nextIndex = 0;
  let completedCount = 0;
  let dedupedCount = 0;
  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex];
        nextIndex += 1;
        const { deduped } = await putObject(job, { retries, retryBaseDelayMs });
        if (deduped) {
          dedupedCount += 1;
        }
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
  return dedupedCount;
}

async function putObject(
  job: UploadJob,
  { retries, retryBaseDelayMs }: { retries: number; retryBaseDelayMs: number },
): Promise<{ deduped: boolean }> {
  let rateLimitAttempt = 0;
  let otherAttempt = 0;
  for (;;) {
    try {
      return await putObjectOnce(job);
    } catch (error) {
      // Rate limiting gets its own, much larger retry budget and backoff
      // scale: Cloudflare's window is 5 minutes, so the generic 1s/2s/4s
      // ladder below only burns more budget. Honor Retry-After when the API
      // sends one; otherwise back off in tens of seconds with jitter so the
      // workers don't re-align on the same instant.
      if (error instanceof R2PutError && error.status === 429) {
        if (rateLimitAttempt >= uploadRateLimitRetries) {
          throw error;
        }
        const backoff =
          error.retryAfterMs ??
          Math.min(
            uploadRateLimitBaseDelayMs * 2 ** rateLimitAttempt,
            uploadRateLimitMaxDelayMs,
          );
        const delay = backoff + Math.floor(Math.random() * 1000);
        pushCooldown(delay);
        rateLimitAttempt += 1;
        console.error(
          `Rate-limited (HTTP 429) on ${job.key}; cooling all workers down ${Math.round(delay / 1000)}s (retry ${rateLimitAttempt}/${uploadRateLimitRetries})`,
        );
        await sleep(delay);
        continue;
      }
      if (otherAttempt >= retries) {
        throw error;
      }
      otherAttempt += 1;
      console.error(
        `Retrying R2 object upload ${job.key} (${otherAttempt}/${retries}) after ${summarizeError(error)}`,
      );
      await sleep(retryBaseDelayMs * 2 ** (otherAttempt - 1));
    }
  }
}

// #stale-publish-pipeline/C: previously spawned a `wrangler r2 object put`
// CLI subprocess per object -- real, measured cost at this registry's current
// scale (~2,325 tracked artifacts, doubled by the always-on history copy):
// every non-upload step in the "publish" job finishes in under 2 minutes,
// while this step alone consistently ran the full 45-minute job timeout
// before being killed (see #8208). A subprocess spawn pays full Node/CLI
// startup + its own credential/account resolution on every single call;
// a direct fetch() reuses Node's built-in undici connection pool across
// concurrent calls to the same host, paying that cost once. Same
// CLOUDFLARE_API_TOKEN this job already has (proven live: it's the exact
// token wrangler itself was authenticating with) against the same public,
// stable Cloudflare API v4 R2 endpoint wrangler's CLI calls under the hood --
// verified directly (2026-07-26): a real object write + read round-trip via
// `wrangler r2 object put/get --remote` against this bucket confirms the
// endpoint shape and bucket name; this fetch call targets the identical
// REST resource, just from this process instead of a spawned CLI.
function requireCloudflareCredentials(): {
  accountId: string;
  apiToken: string;
} {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for R2 access.",
    );
  }
  return { accountId, apiToken };
}

// R2 keys are hierarchical ("latest/subnets.json", "runs/<id>/..."): encode
// each path segment individually so the literal `/` separators survive while
// any segment containing reserved characters is still safely escaped.
function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function r2ObjectUrl(
  accountId: string,
  bucketName: string,
  key: string,
): string {
  return `${r2ApiBaseUrl}/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeR2Key(key)}`;
}

async function putObjectOnce({
  localPath,
  key,
  bucketName,
  contentType,
  kind,
}: UploadJob): Promise<{ deduped: boolean }> {
  const { accountId, apiToken } = requireCloudflareCredentials();
  // History objects are content-addressed (by-hash/<sha256>, see
  // r2-manifest.ts): if this exact key already exists remotely, its bytes are
  // necessarily identical (the key IS the hash of the content), so a HEAD
  // check-then-skip avoids re-uploading a full body for an artifact that
  // hasn't changed since some earlier run (#8208) -- unlike "latest"/"control"
  // keys, which are always overwritten in place regardless of content.
  if (
    kind === "history" &&
    (await objectExists(accountId, bucketName, key, apiToken))
  ) {
    return { deduped: true };
  }
  const body = readFileSync(localPath);
  let res: Response;
  try {
    await rateGate();
    res = await fetch(r2ObjectUrl(accountId, bucketName, key), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": contentType || "application/octet-stream",
      },
      body,
      // A single stalled call (network stall, hung TLS handshake, R2 API
      // wedge) previously had no ceiling and blocked this promise forever --
      // Promise.all in putObjects() then never resolved, wedging the whole
      // publish job until GitHub Actions' job-level timeout-minutes killed it
      // (up to 45m of stale production data). Force a bounded failure instead
      // so the existing retry/backoff loop in putObject() can recover in
      // seconds.
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new Error(
        `R2 object put timed out after ${uploadTimeoutMs}ms for ${key}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const error = new R2PutError(
      [`R2 object put failed for ${key} (HTTP ${res.status})`, text.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, 500),
    );
    error.status = res.status;
    // Retry-After is seconds on Cloudflare's API; only trust a positive one.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfterMs = retryAfter * 1000;
    }
    throw error;
  }
  return { deduped: false };
}

// Fail-safe: any non-2xx/network outcome (including a timeout) is treated as
// "not confirmed present" so the caller falls through to a real PUT -- worst
// case a redundant upload, never a missed one.
async function objectExists(
  accountId: string,
  bucketName: string,
  key: string,
  apiToken: string,
): Promise<boolean> {
  try {
    // HEAD probes spend the same client-API rate budget as PUTs — gate them
    // too, or the dedupe pass alone can trip the 429 window.
    await rateGate();
    const res = await fetch(r2ObjectUrl(accountId, bucketName, key), {
      method: "HEAD",
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(error: unknown): string | undefined {
  return String((error as Error)?.message || error)
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 240);
}
