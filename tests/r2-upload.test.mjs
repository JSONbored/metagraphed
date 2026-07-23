import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { r2StagingRoot } from "../scripts/lib.ts";

test("R2 latest upload uses real sha256 even when content hash matches", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "metagraphed-r2-upload-sha-"),
  );
  const wranglerPath = path.join(temporaryDirectory, "wrangler");
  const putLogPath = path.join(temporaryDirectory, "put-log.jsonl");
  const remoteManifestPath = path.join(
    temporaryDirectory,
    "remote-manifest.json",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(r2StagingRoot, "r2-manifest.json"), "utf8"),
  );
  const firstArtifact = manifest.artifacts[0];
  const remoteManifest = {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact, index) =>
      index === 0
        ? {
            ...artifact,
            sha256: "0".repeat(64),
          }
        : artifact,
    ),
  };
  writeFileSync(remoteManifestPath, JSON.stringify(remoteManifest));
  writeFileSync(
    wranglerPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "r2" || args[1] !== "object") {
  process.exit(2);
}
if (args[2] === "get") {
  writeFileSync(1, readFileSync(process.env.FAKE_REMOTE_MANIFEST));
  process.exit(0);
}
if (args[2] === "put") {
  appendFileSync(
    process.env.FAKE_PUT_LOG,
    JSON.stringify({ key: args[3].slice(args[3].indexOf("/") + 1) }) + "\n",
  );
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(wranglerPath, 0o755);

  try {
    const output = execFileSync(
      process.execPath,
      ["scripts/r2-upload.ts", "--write"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_PUT_LOG: putLogPath,
          FAKE_REMOTE_MANIFEST: remoteManifestPath,
          METAGRAPH_ALLOW_R2_UPLOAD: "1",
          METAGRAPH_R2_UPLOAD_LIMIT: "1",
          METAGRAPH_WRANGLER_BIN: wranglerPath,
        },
        stdio: "pipe",
      },
    );
    const summary = JSON.parse(output);
    const putKeys = readFileSync(putLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).key);

    assert.equal(summary.remote_manifest_status, "found");
    assert.equal(summary.changed_artifact_count, 1);
    assert.equal(summary.skipped_artifact_count, 0);
    assert.equal(summary.uploaded_latest_count, 1);
    assert.deepEqual(putKeys, [firstArtifact.latest_key]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
