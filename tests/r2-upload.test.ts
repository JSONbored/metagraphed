import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { r2StagingRoot } from "../scripts/lib.ts";

const execFileAsync = promisify(execFile);

let server: http.Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

test("R2 latest upload uses real sha256 even when content hash matches", async () => {
  const manifest = JSON.parse(
    readFileSync(`${r2StagingRoot}/r2-manifest.json`, "utf8"),
  );
  const firstArtifact = manifest.artifacts[0];
  const remoteManifest = {
    ...manifest,
    artifacts: manifest.artifacts.map(
      (artifact: Record<string, unknown>, index: number) =>
        index === 0 ? { ...artifact, sha256: "0".repeat(64) } : artifact,
    ),
  };

  const putKeys: string[] = [];
  server = http.createServer((req, res) => {
    // Path shape: /accounts/{accountId}/r2/buckets/{bucket}/objects/{key...}
    const objectsMarker = "/objects/";
    const markerIndex = req.url?.indexOf(objectsMarker) ?? -1;
    if (markerIndex === -1) {
      res.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(
      req.url!.slice(markerIndex + objectsMarker.length),
    );
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(remoteManifest));
      return;
    }
    if (req.method === "PUT") {
      putKeys.push(key);
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200).end();
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  // execFile (async), not execFileSync: a sync child-process wait blocks this
  // process's event loop, starving the in-process mock HTTP server above of
  // any chance to service the child's requests -- a same-process deadlock,
  // not a real bug in the upload logic (confirmed by reproducing it in
  // isolation before switching to this async form).
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/r2-upload.ts", "--write"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        METAGRAPH_ALLOW_R2_UPLOAD: "1",
        METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${port}`,
        METAGRAPH_R2_UPLOAD_LIMIT: "1",
      },
    },
  );
  const summary = JSON.parse(stdout);

  assert.equal(summary.remote_manifest_status, "found");
  assert.equal(summary.changed_artifact_count, 1);
  assert.equal(summary.skipped_artifact_count, 0);
  assert.equal(summary.uploaded_latest_count, 1);
  assert.deepEqual(putKeys, [firstArtifact.latest_key]);
});

// #8240: Cloudflare's client API rate-limits aggressively (HTTP 429, code
// 971). The uploader must treat 429 as a cooldown signal — honoring
// Retry-After when present, backing off otherwise — and eventually succeed,
// instead of burning 3 quick generic retries and aborting the whole publish.
test("R2 upload recovers from HTTP 429 bursts instead of aborting", async () => {
  const manifest = JSON.parse(
    readFileSync(`${r2StagingRoot}/r2-manifest.json`, "utf8"),
  );
  const firstArtifact = manifest.artifacts[0];
  // Remote manifest reports a different hash for artifact 0 so exactly one
  // latest PUT is planned (same setup as the test above).
  const remoteManifest = {
    ...manifest,
    artifacts: manifest.artifacts.map(
      (artifact: Record<string, unknown>, index: number) =>
        index === 0 ? { ...artifact, sha256: "0".repeat(64) } : artifact,
    ),
  };

  let putAttempts = 0;
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(remoteManifest));
      return;
    }
    if (req.method === "PUT") {
      putAttempts += 1;
      req.resume();
      req.on("end", () => {
        if (putAttempts <= 2) {
          // First 429 carries Retry-After (the honored path); the second
          // omits it (the exponential-backoff path).
          const headers: Record<string, string> =
            putAttempts === 1 ? { "retry-after": "1" } : {};
          res.writeHead(429, headers);
          res.end(
            JSON.stringify({
              success: false,
              errors: [
                {
                  code: 971,
                  message:
                    "Please wait and consider throttling your request speed",
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200).end();
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/r2-upload.ts", "--write"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        METAGRAPH_ALLOW_R2_UPLOAD: "1",
        METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${port}`,
        METAGRAPH_R2_UPLOAD_LIMIT: "1",
        // Keep the test fast: high rps ceiling, tiny 429 backoff base. The
        // Retry-After: 1 response above still exercises the honored path.
        METAGRAPH_R2_UPLOAD_MAX_RPS: "200",
        METAGRAPH_R2_UPLOAD_429_BASE_DELAY_MS: "20",
      },
    },
  );
  const summary = JSON.parse(stdout);
  assert.equal(putAttempts, 3); // 429, 429, then success
  assert.equal(summary.uploaded_latest_count, 1);
  assert.equal(summary.changed_artifact_count, 1);
  void firstArtifact;
});

test("R2 upload still fails once the 429 retry budget is exhausted", async () => {
  const manifest = JSON.parse(
    readFileSync(`${r2StagingRoot}/r2-manifest.json`, "utf8"),
  );
  const remoteManifest = {
    ...manifest,
    artifacts: manifest.artifacts.map(
      (artifact: Record<string, unknown>, index: number) =>
        index === 0 ? { ...artifact, sha256: "0".repeat(64) } : artifact,
    ),
  };
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(remoteManifest));
      return;
    }
    if (req.method === "PUT") {
      req.resume();
      req.on("end", () => {
        res.writeHead(429).end(JSON.stringify({ success: false }));
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/r2-upload.ts", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        METAGRAPH_ALLOW_R2_UPLOAD: "1",
        METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${port}`,
        METAGRAPH_R2_UPLOAD_LIMIT: "1",
        METAGRAPH_R2_UPLOAD_MAX_RPS: "200",
        METAGRAPH_R2_UPLOAD_429_BASE_DELAY_MS: "5",
        METAGRAPH_R2_UPLOAD_429_RETRIES: "1",
      },
    }),
    /429/,
  );
});
