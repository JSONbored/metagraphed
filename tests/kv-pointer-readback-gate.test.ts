import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { afterEach, test } from "vitest";

const execFileAsync = promisify(execFile);

let server: http.Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/**
 * #8282: the pointer flip is the one write that can 404 the entire R2-backed
 * API at once, because workers/storage.ts builds every live key as
 * `${latest_prefix}${relativePath}`. On 2026-07-26 it named a prefix nothing
 * was written under and did it anyway. This gate reads back through the exact
 * key the Worker will build, BEFORE the KV write.
 */

/** Mock R2 REST API: HEAD returns 200 for `served`, 404 otherwise. */
function mockR2(served: (key: string) => boolean, seen: string[]) {
  return http.createServer((req, res) => {
    const marker = "/objects/";
    const at = req.url?.indexOf(marker) ?? -1;
    if (at === -1) {
      res.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(req.url!.slice(at + marker.length));
    seen.push(key);
    res.writeHead(served(key) ? 200 : 404).end();
  });
}

async function runPointer(
  port: number | null,
  extraEnv: Record<string, string> = {},
) {
  return execFileAsync(
    process.execPath,
    ["scripts/kv-publish-pointer.ts", ...(extraEnv.DRY_RUN ? [] : ["--write"])],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        METAGRAPH_KV_NAMESPACE_ID: "test-namespace",
        METAGRAPH_ALLOW_KV_WRITE: "1",
        // Point wrangler at a bin that cannot exist, so a test that reaches the
        // KV write fails loudly instead of touching a real namespace.
        PATH: "/nonexistent",
        ...(port
          ? { METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${port}` }
          : {}),
        ...extraEnv,
      },
    },
  );
}

test("refuses to flip the pointer when the prefix serves nothing", async () => {
  const seen: string[] = [];
  server = mockR2(() => false, seen);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(runPointer(port), (err: Error & { stderr?: string }) => {
    const stderr = String(err.stderr ?? err.message);
    assert.match(stderr, /Refusing to publish the KV pointer/);
    // Names the offending key and the prefix it was built from, so the
    // mismatch is obvious without re-deriving it.
    assert.match(stderr, /latest_prefix "latest\/"/);
    assert.match(stderr, /- latest\//);
    return true;
  });
  assert.ok(seen.length > 0, "expected the gate to read back from R2");
});

test("passes and proceeds when the prefix serves every sampled artifact", async () => {
  const seen: string[] = [];
  server = mockR2(() => true, seen);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  // The gate passes, so execution continues to the KV write — which fails
  // because PATH has no wrangler. That is the assertion: we got PAST the gate.
  await assert.rejects(runPointer(port), (err: Error & { stdout?: string }) => {
    assert.match(
      String(err.stdout ?? ""),
      /Pointer prefix "latest\/" verified/,
    );
    return true;
  });
  assert.ok(seen.every((k) => k.startsWith("latest/")));
  // Every read went through the Worker's own key shape, not the run prefix.
  assert.ok(!seen.some((k) => k.startsWith("runs/")));
});

test("refuses on a partially-populated tree, not just an empty one", async () => {
  // Derived from the manifest the script actually reads (the committed one,
  // which the publish regenerates before kv:publish) rather than hardcoded, so
  // this stays meaningful as the artifact set changes.
  const manifest = JSON.parse(
    readFileSync("public/metagraph/r2-manifest.json", "utf8"),
  ) as { artifacts: Array<{ path: string }> };
  const victim = manifest.artifacts[0]!.path.replace(/^\/metagraph\//, "");
  const victimKey = `latest/${victim}`;

  const seen: string[] = [];
  // Everything serves EXCEPT one artifact — a tree that is present but
  // incomplete, which is strictly harder to catch than an empty prefix.
  server = mockR2((key) => key !== victimKey, seen);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(runPointer(port), (err: Error & { stderr?: string }) => {
    const stderr = String(err.stderr ?? err.message);
    assert.match(stderr, /Refusing to publish the KV pointer/);
    assert.ok(
      stderr.includes(victimKey),
      `expected the offending key ${victimKey} in: ${stderr}`,
    );
    return true;
  });
  assert.ok(seen.includes(victimKey), "the gate must have sampled the victim");
});

test("dry-run performs no R2 reads at all", async () => {
  const seen: string[] = [];
  server = mockR2(() => true, seen);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const { stdout } = await runPointer(port, { DRY_RUN: "1" });
  assert.match(stdout, /"mode": "dry-run"/);
  assert.deepEqual(seen, [], "dry-run must not touch the network");
});
