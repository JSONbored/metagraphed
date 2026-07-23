// Unit tests for the /api/v1/internal/rollup-account-events-daily proxy
// (workers/api.mjs's handleRollupAccountEventsDailyProxy, #4832), which
// forwards to workers/data-api.mjs's handleRollupAccountEventsDaily via the
// EXISTING DATA_API service binding (shares proxyToDataApi with
// handleNeuronsSyncProxy -- see tests/neurons-sync-proxy.test.mjs for that
// sibling route's equivalent coverage). The downstream rollup logic itself
// is covered by tests/data-api.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function post({ method = "POST" } = {}) {
  return new Request(
    "https://api.metagraph.sh/api/v1/internal/rollup-account-events-daily",
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
      "https://api.metagraph.sh/api/v1/internal/rollup-account-events-daily",
      { method: "POST", headers: { "x-rollup-sync-token": "shared-secret" } },
    ),
    {
      DATA_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-rollup-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({ ok: true, rolled: ["2026-07-01", "2026-06-30"] }),
            { status: 200 },
          );
        },
      },
    },
    {},
  );
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/rollup-account-events-daily");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    rolled: ["2026-07-01", "2026-06-30"],
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
    "rollup_account_events_daily_unavailable",
  );
});
