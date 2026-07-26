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
