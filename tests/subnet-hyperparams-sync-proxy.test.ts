// Unit tests for the /api/v1/internal/subnet-hyperparams-sync proxy
// (workers/api.mjs's handleSubnetHyperparamsSyncProxy, #4832 gap-closure),
// which forwards to workers/data-api.mjs's handleSubnetHyperparamsSync via
// the EXISTING DATA_API service binding (shares proxyToDataApi with
// handleNeuronsSyncProxy/handleRollupAccountEventsDailyProxy -- see
// tests/neurons-sync-proxy.test.mjs for that sibling route's equivalent
// coverage). The downstream sync logic itself is covered by
// tests/data-api.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function post({ method = "POST" } = {}) {
  return new Request(
    "https://api.metagraph.sh/api/v1/internal/subnet-hyperparams-sync",
    { method },
  );
}

test("rejects non-POST before reaching the binding (405)", async () => {
  let calls = 0;
  const res = await handleRequest(
    post({ method: "GET" }),
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
  const res = await handleRequest(post(), {}, {});
  assert.equal(res.status, 503);
});

test("forwards the request to DATA_API and relays its response body + status", async () => {
  let receivedToken;
  let receivedPath;
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/internal/subnet-hyperparams-sync",
      {
        method: "POST",
        headers: { "x-subnet-hyperparams-sync-token": "shared-secret" },
      },
    ),
    {
      DATA_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-subnet-hyperparams-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({
              ok: true,
              subnet_hyperparams_written: 129,
              deregistered_pruned: 0,
              history_appended: 3,
            }),
            { status: 200 },
          );
        },
      },
    },
    {},
  );
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/subnet-hyperparams-sync");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    subnet_hyperparams_written: 129,
    deregistered_pruned: 0,
    history_appended: 3,
  });
});

test("relays a non-2xx upstream status (e.g. 401) unchanged", async () => {
  const res = await handleRequest(
    post(),
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
    post(),
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
  assert.equal(
    (await res.json()).error.code,
    "subnet_hyperparams_sync_unavailable",
  );
});
