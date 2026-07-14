// Unit tests for the /api/v1/alerts/triggers* proxy (workers/api.mjs's
// handleAlertTriggersProxy, #4984 Part 1), which forwards POST/GET/PATCH/
// DELETE to workers/data-api.mjs's handleAlertTriggersRoute via the EXISTING
// DATA_API service binding. Unlike neurons-sync's proxyToDataApi (a raw
// pass-through), this one envelope-wraps the response via dataResponse/
// errorResponse -- see handleAlertTriggersProxy's own comment. The
// downstream CRUD logic itself is covered by tests/alert-triggers-route.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://api.metagraph.sh${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("returns 503 when DATA_API is not bound", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
    {},
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "alert_triggers_unavailable");
});

test("forwards POST to DATA_API and envelope-wraps a successful response", async () => {
  let receivedPath;
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": "shared-secret" },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
    {
      DATA_API: {
        fetch(request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          return new Response(
            JSON.stringify({ id: "1", owner_token: "abc", netuid: 7 }),
            { status: 201 },
          );
        },
      },
    },
    {},
  );
  assert.equal(receivedPath, "/api/v1/alerts/triggers");
  assert.equal(receivedMethod, "POST");
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, { id: "1", owner_token: "abc", netuid: 7 });
});

test("forwards GET /{id} to DATA_API, including the owner-token header", async () => {
  let receivedToken;
  const res = await handleRequest(
    req("/api/v1/alerts/triggers/1", {
      method: "GET",
      headers: { "x-alert-trigger-owner-token": "abc" },
    }),
    {
      DATA_API: {
        fetch(request) {
          receivedToken = request.headers.get("x-alert-trigger-owner-token");
          return new Response(JSON.stringify({ id: "1", netuid: 7 }), {
            status: 200,
          });
        },
      },
    },
    {},
  );
  assert.equal(receivedToken, "abc");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { id: "1", netuid: 7 });
});

test("forwards PATCH to DATA_API", async () => {
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/alerts/triggers/1", {
      method: "PATCH",
      headers: { "x-alert-trigger-owner-token": "abc" },
      body: { channel: "email", destination: "a@b.com", netuid: 8 },
    }),
    {
      DATA_API: {
        fetch(request) {
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "1", netuid: 8 }), {
            status: 200,
          });
        },
      },
    },
    {},
  );
  assert.equal(receivedMethod, "PATCH");
  assert.equal(res.status, 200);
});

test("forwards DELETE to DATA_API", async () => {
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": "abc" },
    }),
    {
      DATA_API: {
        fetch(request) {
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "1", deleted: true }), {
            status: 200,
          });
        },
      },
    },
    {},
  );
  assert.equal(receivedMethod, "DELETE");
  assert.deepEqual((await res.json()).data, { id: "1", deleted: true });
});

test("relays a non-2xx upstream status with the upstream's error message", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": "wrong" },
      body: {},
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({ error: "provide a valid token" }),
            { status: 401 },
          );
        },
      },
    },
    {},
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.message, "provide a valid token");
});

test("relays a non-2xx upstream status with a generic message when the body has no error string", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
    {
      DATA_API: {
        fetch() {
          return new Response(JSON.stringify({}), { status: 503 });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 503);
  assert.match(
    (await res.json()).error.message,
    /alert triggers tier returned an error/,
  );
});

test("returns 502 when the upstream response body is unreadable", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
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
  assert.equal((await res.json()).error.code, "alert_triggers_unavailable");
});

// #5475: distinct error code per upstream failure condition + rate-limit header
// forwarding, instead of collapsing everything into alert_trigger_request_failed
// and dropping the headers.
test("maps a 429 upstream to alert_trigger_rate_limited and forwards the rate-limit header family end-to-end", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": "t" },
      body: {},
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({
              error: "too many alert trigger creation requests; slow down",
            }),
            {
              status: 429,
              headers: {
                "retry-after": "60",
                "x-ratelimit-limit": "10",
                "x-ratelimit-policy": "10;w=60",
                "x-ratelimit-remaining": "0",
              },
            },
          );
        },
      },
    },
    {},
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "alert_trigger_rate_limited");
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("x-ratelimit-limit"), "10");
  assert.equal(res.headers.get("x-ratelimit-policy"), "10;w=60");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
});

test("maps each upstream status to a distinct, condition-specific error code", async () => {
  const codeFor = async (status) => {
    const res = await handleRequest(
      req("/api/v1/alerts/triggers/1", {
        method: "DELETE",
        headers: { "x-alert-trigger-owner-token": "t" },
      }),
      {
        DATA_API: {
          fetch() {
            return new Response(JSON.stringify({ error: "upstream said no" }), {
              status,
            });
          },
        },
      },
      {},
    );
    assert.equal(res.status, status);
    return (await res.json()).error.code;
  };
  assert.equal(await codeFor(400), "alert_trigger_invalid");
  assert.equal(await codeFor(401), "alert_trigger_unauthorized");
  assert.equal(await codeFor(404), "alert_trigger_not_found");
  assert.equal(await codeFor(413), "alert_trigger_payload_too_large");
  assert.equal(await codeFor(429), "alert_trigger_rate_limited");
  assert.equal(await codeFor(502), "alert_triggers_unavailable");
  assert.equal(await codeFor(503), "alert_triggers_unavailable");
  // An unmapped status still falls back to the generic code.
  assert.equal(await codeFor(418), "alert_trigger_request_failed");
});

test("does not attach rate-limit headers when the upstream error carries none", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers/1", {
      method: "DELETE",
      headers: { "x-alert-trigger-owner-token": "t" },
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(JSON.stringify({ error: "no such trigger" }), {
            status: 404,
          });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "alert_trigger_not_found");
  assert.equal(res.headers.get("retry-after"), null);
  assert.equal(res.headers.get("x-ratelimit-limit"), null);
});
