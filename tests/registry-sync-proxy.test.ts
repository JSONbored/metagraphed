// Unit tests for the /api/v1/internal/registry-sync proxy (workers/api.mjs's
// handleRegistrySyncProxy), which forwards to the dedicated registry-sync
// Worker via the REGISTRY_SYNC_API service binding. The downstream Worker
// itself is covered by tests/registry-sync-api.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function post(body: unknown, { method = "POST" }: { method?: string } = {}) {
  return new Request("https://api.metagraph.sh/api/v1/internal/registry-sync", {
    method,
    headers: { "content-type": "application/json" },
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : JSON.stringify(body ?? {}),
  });
}

test("rejects non-POST before reaching the binding (405)", async () => {
  let calls = 0;
  const res = await handleRequest(
    post(null, { method: "GET" }),
    {
      REGISTRY_SYNC_API: {
        fetch() {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 405);
  assert.equal(calls, 0);
});

test("returns 503 when REGISTRY_SYNC_API is not bound", async () => {
  const res = await handleRequest(post({ providers: [] }), {}, {});
  assert.equal(res.status, 503);
});

test("forwards the request to REGISTRY_SYNC_API and relays its response body + status", async () => {
  let receivedToken;
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/internal/registry-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-registry-sync-token": "shared-secret",
      },
      body: JSON.stringify({ providers: [{ id: "acme" }] }),
    }),
    {
      REGISTRY_SYNC_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-registry-sync-token");
          return new Response(
            JSON.stringify({ ok: true, providers_written: 1 }),
            { status: 200 },
          );
        },
      },
    },
    {},
  );
  assert.equal(receivedToken, "shared-secret");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, providers_written: 1 });
});

test("relays a non-2xx upstream status (e.g. 401) unchanged", async () => {
  const res = await handleRequest(
    post({ providers: [] }),
    {
      REGISTRY_SYNC_API: {
        fetch() {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("returns 502 when the upstream response body is unreadable", async () => {
  const res = await handleRequest(
    post({ providers: [] }),
    {
      REGISTRY_SYNC_API: {
        fetch() {
          return new Response("not json", { status: 200 });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "registry_sync_unavailable");
});
