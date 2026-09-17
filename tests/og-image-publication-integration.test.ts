import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { test } from "vitest";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.ts";
import { OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";
import { hashJson, repoRoot, sha256Hex } from "../scripts/lib.ts";
import { jsonBytes } from "../scripts/artifact-release-commit.ts";

test("a normal manifest and the actual uploader publish the exact immutable receipt named by each image", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "og-receipt-upload-"));
  const objects = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    const key = decodeURIComponent(req.url?.split("/objects/")[1] ?? "");
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.end('{"success":true}');
      return;
    }
    const bytes = objects.get(key);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "content-type",
      key.includes("manifest")
        ? "application/json"
        : "application/octet-stream",
    );
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await mkdir(path.join(root, "public/metagraph"), { recursive: true });
    const stage = path.join(root, R2_STAGING_RELATIVE_ROOT);
    await mkdir(stage, { recursive: true });
    const png = await readFile(
      new URL("../public/brand/og-fallback.png", import.meta.url),
    );
    const receipt = jsonBytes({
      status: "rendered",
      renderer_version: "fixture",
      source_sha256: hashJson({ subnet_count: 128 }),
      fonts: [{ name: "fixture", sha256: "f".repeat(64) }],
      artifacts: OG_IMAGE_FILE_NAMES,
    });
    const receiptKey = `by-hash/${sha256Hex(receipt)}`;
    await writeFile(path.join(stage, "og-image-render.json"), receipt);
    await writeFile(
      path.join(stage, "build-summary.json"),
      jsonBytes({ published_at: "2026-09-06T00:00:00Z" }),
    );
    const provenance: Record<string, object> = {};
    for (const name of OG_IMAGE_FILE_NAMES) {
      await writeFile(path.join(stage, name), png);
      provenance[`/metagraph/${name}`] = { artwork_receipt_key: receiptKey };
    }
    await writeFile(
      path.join(root, "dist/og-image-provenance.json"),
      jsonBytes(provenance),
    );
    const env = {
      ...process.env,
      METAGRAPH_REPO_ROOT: root,
      METAGRAPH_BUILD_TIMESTAMP: "2026-09-06T00:00:00Z",
    };
    execFileSync(process.execPath, ["scripts/r2-manifest.ts", "--write"], {
      cwd: repoRoot,
      env,
      stdio: "pipe",
    });
    const manifest = JSON.parse(
      await readFile(path.join(stage, "r2-manifest.json"), "utf8"),
    );
    const record = manifest.artifacts.find(
      (entry: { path: string }) =>
        entry.path === "/metagraph/og-image-render.json",
    );
    assert.equal(record.storage_tier, "r2");
    assert.equal(record.key, receiptKey);
    assert.equal(
      artifactStorageTierForRelativePath("og-image-render.json"),
      "r2",
    );
    await promisify(execFile)(
      process.execPath,
      ["scripts/r2-upload.ts", "--write"],
      {
        cwd: repoRoot,
        env: {
          ...env,
          CLOUDFLARE_ACCOUNT_ID: "fixture",
          CLOUDFLARE_API_TOKEN: "fixture-token",
          METAGRAPH_ALLOW_R2_UPLOAD: "1",
          METAGRAPH_R2_UPLOAD_HISTORY: "1",
          METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    for (const name of OG_IMAGE_FILE_NAMES) {
      const image = manifest.artifacts.find(
        (entry: { path: string }) => entry.path === `/metagraph/${name}`,
      );
      assert.deepEqual(objects.get(image.artwork_receipt_key), receipt);
      assert.deepEqual(objects.get(image.key), png);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("the real workflow forbids a missing-namespace R2-only publish and isolates image work from refresh", async () => {
  const workflow = parseYaml(
    await readFile(
      new URL("../.github/workflows/publish-cloudflare.yml", import.meta.url),
      "utf8",
    ),
  );
  const gate = workflow.jobs.publish.steps.find(
    (step: { id?: string }) => step.id === "cloudflare-secrets",
  );
  const root = await mkdtemp(path.join(tmpdir(), "release-secret-gate-"));
  try {
    const run = (mode: string) =>
      spawnSync("/bin/bash", ["-c", gate.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: path.join(root, "output"),
          PUBLISH_MODE: mode,
          CLOUDFLARE_ACCOUNT_ID: "fixture",
          CLOUDFLARE_API_TOKEN: "fixture-token",
          METAGRAPH_KV_NAMESPACE_ID: "",
        },
      });
    const actual = run("publish");
    assert.equal(actual.status, 1);
    assert.match(actual.stdout, /METAGRAPH_KV_NAMESPACE_ID are required/);
    assert.equal(run("dry-run").status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const upload = workflow.jobs.publish.steps.find(
    (step: { name?: string }) => step.name === "Upload artifact history to R2",
  );
  assert.match(upload.if, /prepare-release.outcome == 'success'/);
  assert.equal(workflow.concurrency.group, "publish-cloudflare-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.publish_mode.default,
    "dry-run",
  );
  const imageCommands = workflow.jobs["image-release"].steps
    .map((step: { run?: string }) => step.run ?? "")
    .join("\n");
  assert.doesNotMatch(
    imageCommands,
    /npm run (?:build|r2:upload|r2:manifest|changelog:publish)|refresh-native|assert:probe/,
  );
});
