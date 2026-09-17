import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, vi } from "vitest";
import {
  createReleaseStore,
  ReleaseBudget,
} from "../scripts/artifact-release-store.ts";
import {
  bootstrapReleaseJournal,
  commitArtifactRelease,
  jsonObject,
} from "../scripts/artifact-release-commit.ts";
import { hashJson } from "../scripts/lib.ts";

test("the actual bounded REST transport publishes and reads back a journaled pointer using only intended keys", async () => {
  const objects = new Map<string, { bytes: Buffer; type: string }>();
  let pointer = { run_prefix: "runs/base/", published_at: "old" };
  const seen: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = req.url!;
    seen.push(`${req.method} ${url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (url.includes("/values/metagraph%3Alatest")) {
      if (req.method === "PUT") {
        pointer = JSON.parse(body.toString());
        res.setHeader("content-type", "application/json");
        res.end('{"success":true}');
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(pointer));
      }
      return;
    }
    const key = url.split("/objects/")[1];
    if (!key) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "PUT") {
      objects.set(key, {
        bytes: body,
        type: String(req.headers["content-type"]),
      });
      res.end('{"success":true}');
      return;
    }
    const object = objects.get(key);
    if (!object) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", object.type);
    res.end(object.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [key, value] of Object.entries({
      METAGRAPH_R2_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      CLOUDFLARE_ACCOUNT_ID: "fixture",
      CLOUDFLARE_API_TOKEN: "fixture-token",
      METAGRAPH_KV_NAMESPACE_ID: "fixture",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "owner/repo/.github/workflows/publish-cloudflare.yml@refs/heads/main",
      METAGRAPH_RELEASE_OWNER: "publish-cloudflare",
      METAGRAPH_ALLOW_R2_UPLOAD: "1",
      METAGRAPH_ALLOW_KV_WRITE: "1",
    }))
      vi.stubEnv(key, value);
    const budget = new ReleaseBudget();
    const store = createReleaseStore(true, budget);
    const base = { ...pointer };
    await bootstrapReleaseJournal(store, hashJson(base));
    const target = { ...base, run_prefix: "runs/image-test/" };
    const result = await commitArtifactRelease(store, {
      id: "a".repeat(64),
      kind: "image",
      base,
      target,
      objects: [jsonObject("runs/image-test/control.json", { stable: true })],
    });
    assert.equal(result.status, "release-bound");
    assert.deepEqual(await store.getPointer(), target);
    assert.equal(pointer.published_at, "old");
    assert.ok(seen.every((request) => !request.includes("latest/")));
    assert.ok(budget.requests <= 64);
    const readOnly = createReleaseStore(false);
    await assert.rejects(
      readOnly.put(jsonObject("forbidden", {})),
      /Read-only/,
    );
    await assert.rejects(readOnly.putPointer({}), /Read-only/);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stream limits apply without trusting Content-Length and cancel oversized bodies", async () => {
  const budget = new ReleaseBudget();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(budget.read(response, 16), /size\/time limit/);
  assert.equal(cancelled, true);
  budget.requests = 64;
  await assert.rejects(
    budget.request("http://127.0.0.1/never-requested"),
    /budget exhausted/,
  );
  assert.throws(() => budget.account(129 * 1024 * 1024), /budget exhausted/);
});
