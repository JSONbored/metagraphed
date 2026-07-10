// Unit tests for the /api/v1/internal/neurons-sync proxy (workers/api.mjs's
// handleNeuronsSyncProxy, #4771), which forwards to workers/data-api.mjs's
// handleNeuronsSync via the EXISTING DATA_API service binding (not a
// dedicated Worker/binding -- see the handler's own comment for why). The
// downstream write logic itself is covered by tests/data-api.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function post(body, { method = "POST" } = {}) {
  return new Request("https://api.metagraph.sh/api/v1/internal/neurons-sync", {
    method,
    headers: { "content-type": "application/json" },
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : JSON.stringify(body ?? []),
  });
}

test("rejects non-POST before reaching the binding (405)", async () => {
  let calls = 0;
  const res = await handleRequest(
    post(null, { method: "GET" }),
    {
      DATA_API: {
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

test("returns 503 when DATA_API is not bound", async () => {
  const res = await handleRequest(post([{ netuid: 8 }]), {}, {});
  assert.equal(res.status, 503);
});

test("forwards the request to DATA_API and relays its response body + status", async () => {
  let receivedToken;
  let receivedPath;
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": "shared-secret",
      },
      body: JSON.stringify([{ netuid: 8 }]),
    }),
    {
      DATA_API: {
        fetch(req) {
          receivedToken = req.headers.get("x-neurons-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({ ok: true, neurons_written: 1 }),
            { status: 200 },
          );
        },
      },
    },
    {},
  );
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/neurons-sync");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, neurons_written: 1 });
});

test("relays a non-2xx upstream status (e.g. 401) unchanged", async () => {
  const res = await handleRequest(
    post([{ netuid: 8 }]),
    {
      DATA_API: {
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
    post([{ netuid: 8 }]),
    {
      DATA_API: {
        fetch() {
          return new Response("not json", { status: 200 });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "neurons_sync_unavailable");
});
