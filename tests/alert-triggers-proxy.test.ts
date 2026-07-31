// Unit tests for the /api/v1/alerts/triggers* proxy (workers/api.ts's
// handleAlertTriggersProxy, #4984 Part 1), which forwards POST/GET/PATCH/
// DELETE to workers/data-api.ts's handleAlertTriggersRoute via the EXISTING
// DATA_API service binding. Unlike neurons-sync's proxyToDataApi (a raw
// pass-through), this one envelope-wraps the response via dataResponse/
// errorResponse -- see handleAlertTriggersProxy's own comment. The
// downstream CRUD logic itself is covered by tests/alert-triggers-route.test.ts.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

function req(
  path: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return new Request(`https://api.metagraph.sh${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("returns 503 when DATA_API is not bound", async () => {
  const res = await handleRequest(
    req("/api/v1/alerts/triggers", { method: "POST", body: {} }),
    {} as unknown as Env,
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
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          return new Response(
            JSON.stringify({ id: "1", owner_token: "abc", netuid: 7 }),
            { status: 201 },
          );
        },
      },
    } as unknown as Env,
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
        fetch(request: Request) {
          receivedToken = request.headers.get("x-alert-trigger-owner-token");
          return new Response(JSON.stringify({ id: "1", netuid: 7 }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
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
        fetch(request: Request) {
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "1", netuid: 8 }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
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
        fetch(request: Request) {
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "1", deleted: true }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
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
    } as unknown as Env,
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
    } as unknown as Env,
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
    } as unknown as Env,
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
    } as unknown as Env,
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
  const codeFor = async (status: number) => {
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
      } as unknown as Env,
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

// --- /api/v1/watch/triggers* (#8375 Alert Center) -- shares the SAME proxy
// function as /api/v1/alerts/triggers* above (handleAlertTriggersProxy is a
// generic pass-through; all real auth/routing lives in
// workers/data-api.ts's handleWatchTriggersRoute), so these tests only
// need to cover the dispatch wiring (does /api/v1/watch/triggers* actually
// reach the proxy, for every method it needs), not re-derive the full
// error-code/rate-limit-header matrix already covered above.

test("forwards GET /api/v1/watch/triggers to DATA_API", async () => {
  let receivedPath;
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/watch/triggers", {
      method: "GET",
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          return new Response(JSON.stringify({ triggers: [] }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedPath, "/api/v1/watch/triggers");
  assert.equal(receivedMethod, "GET");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { triggers: [] });
});

test("forwards PATCH /api/v1/watch/triggers/{id} to DATA_API", async () => {
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/watch/triggers/1", {
      method: "PATCH",
      headers: { "x-watch-trigger-token": "tok" },
      body: { active: false },
    }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "1", active: false }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedMethod, "PATCH");
  assert.equal(res.status, 200);
});

test("forwards DELETE /api/v1/watch/triggers/{id} to DATA_API", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/triggers/1", {
      method: "DELETE",
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(JSON.stringify({ id: "1", deleted: true }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { id: "1", deleted: true });
});

test("forwards GET /api/v1/watch/triggers/{id}/deliveries to DATA_API", async () => {
  let receivedPath;
  const res = await handleRequest(
    req("/api/v1/watch/triggers/1/deliveries", {
      method: "GET",
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          return new Response(JSON.stringify({ deliveries: [] }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedPath, "/api/v1/watch/triggers/1/deliveries");
  assert.deepEqual((await res.json()).data, { deliveries: [] });
});

test("returns 503 for /api/v1/watch/triggers when DATA_API is not bound", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/triggers"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "alert_triggers_unavailable");
});

test("relays a non-2xx upstream status for /api/v1/watch/triggers with the upstream's error message", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/triggers", {
      headers: { "x-watch-trigger-token": "bad" },
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({
              error: "invalid or expired x-watch-trigger-token",
            }),
            { status: 401 },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 401);
  assert.equal(
    (await res.json()).error.message,
    "invalid or expired x-watch-trigger-token",
  );
});

test("OPTIONS /api/v1/watch/triggers advertises GET, PATCH, DELETE, OPTIONS (no POST -- creation stays at /api/v1/alerts/triggers)", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/triggers", { method: "OPTIONS" }),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-methods"),
    "GET, PATCH, DELETE, OPTIONS",
  );
});

test("GET /api/v1/testnet/watch/triggers 404s -- mainnet-only, not partitioned per network", async () => {
  const res = await handleRequest(
    req("/api/v1/testnet/watch/triggers", {
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 404);
});

// --- /api/v1/watch/push-subscriptions* (#8808) -- shares the SAME proxy
// function as /api/v1/watch/triggers* above (handleAlertTriggersProxy is a
// generic pass-through; all real auth/routing lives in
// workers/data-api.ts's handleWatchPushSubscriptions* handlers), so these
// tests only need to cover the dispatch wiring (does
// /api/v1/watch/push-subscriptions* actually reach the proxy, for every
// method it needs), not re-derive the full error-code/rate-limit-header
// matrix already covered above. These fail on main -- before this change
// the routing branch never matched this prefix, so handleRequest fell
// through to the generic 404 and never reached the stubbed DATA_API.
test("forwards GET /api/v1/watch/push-subscriptions to DATA_API", async () => {
  let receivedPath;
  let receivedMethod;
  let receivedToken;
  const res = await handleRequest(
    req("/api/v1/watch/push-subscriptions", {
      method: "GET",
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          receivedToken = request.headers.get("x-watch-trigger-token");
          return new Response(JSON.stringify({ devices: [] }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedPath, "/api/v1/watch/push-subscriptions");
  assert.equal(receivedMethod, "GET");
  assert.equal(receivedToken, "tok");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { devices: [] });
});

test("forwards POST /api/v1/watch/push-subscriptions to DATA_API with the request body intact", async () => {
  let receivedMethod;
  let receivedBody;
  const res = await handleRequest(
    req("/api/v1/watch/push-subscriptions", {
      method: "POST",
      headers: { "x-watch-trigger-token": "tok" },
      body: { endpoint: "https://push.example/abc" },
    }),
    {
      DATA_API: {
        async fetch(request: Request) {
          receivedMethod = request.method;
          receivedBody = await request.json();
          return new Response(JSON.stringify({ id: "1" }), { status: 201 });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedMethod, "POST");
  assert.deepEqual(receivedBody, { endpoint: "https://push.example/abc" });
  assert.equal(res.status, 201);
});

test("forwards DELETE /api/v1/watch/push-subscriptions/9 to DATA_API", async () => {
  let receivedPath;
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/watch/push-subscriptions/9", {
      method: "DELETE",
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          return new Response(JSON.stringify({ id: "9", deleted: true }), {
            status: 200,
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedPath, "/api/v1/watch/push-subscriptions/9");
  assert.equal(receivedMethod, "DELETE");
  assert.deepEqual((await res.json()).data, { id: "9", deleted: true });
});

test("returns 503 for /api/v1/watch/push-subscriptions when DATA_API is not bound", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/push-subscriptions"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "alert_triggers_unavailable");
});

test("OPTIONS /api/v1/watch/push-subscriptions advertises GET, POST, DELETE, OPTIONS", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/push-subscriptions", { method: "OPTIONS" }),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-methods"),
    "GET, POST, DELETE, OPTIONS",
  );
});

test("GET /api/v1/testnet/watch/push-subscriptions 404s -- mainnet-only, not partitioned per network", async () => {
  const res = await handleRequest(
    req("/api/v1/testnet/watch/push-subscriptions", {
      headers: { "x-watch-trigger-token": "tok" },
    }),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 404);
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
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "alert_trigger_not_found");
  assert.equal(res.headers.get("retry-after"), null);
  assert.equal(res.headers.get("x-ratelimit-limit"), null);
});
