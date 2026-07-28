// Unit tests for the /api/v1/watch/{challenges,tokens} proxy (#8374,
// workers/api.ts's handleWatchAuthProxy), which forwards POST to
// workers/data-api.ts's handleWatchChallenge/handleWatchTokenMint via the
// existing DATA_API service binding and envelope-wraps the response.
// Mirrors tests/alert-triggers-proxy.test.ts's shape exactly; the downstream
// challenge/mint logic itself is covered by tests/watch-auth-route.test.ts.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

function req(
  path: string,
  {
    method = "POST",
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

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

test("returns 503 when DATA_API is not bound", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/challenges", { body: { ss58: SS58 } }),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "watch_auth_unavailable");
});

test("forwards POST /challenges to DATA_API and envelope-wraps a successful response", async () => {
  let receivedPath;
  let receivedMethod;
  const res = await handleRequest(
    req("/api/v1/watch/challenges", { body: { ss58: SS58 } }),
    {
      DATA_API: {
        fetch(request: Request) {
          receivedPath = new URL(request.url).pathname;
          receivedMethod = request.method;
          return new Response(
            JSON.stringify({ message: "sign me", expires_in_seconds: 300 }),
            { status: 200 },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(receivedPath, "/api/v1/watch/challenges");
  assert.equal(receivedMethod, "POST");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, { message: "sign me", expires_in_seconds: 300 });
});

test("forwards POST /tokens to DATA_API, including the signed body", async () => {
  let receivedBody: unknown;
  const res = await handleRequest(
    req("/api/v1/watch/tokens", {
      body: { ss58: SS58, signature: "ab".repeat(64) },
    }),
    {
      DATA_API: {
        async fetch(request: Request) {
          receivedBody = await request.json();
          return new Response(
            JSON.stringify({ token: "tok-1", expires_in_seconds: 7776000 }),
            { status: 200 },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal((receivedBody as { ss58: string }).ss58, SS58);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, {
    token: "tok-1",
    expires_in_seconds: 7776000,
  });
});

test("relays a non-2xx upstream status with the upstream's error message", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/tokens", { body: { ss58: SS58, signature: "bad" } }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({ error: "signature verification failed" }),
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
    "signature verification failed",
  );
});

test("relays a non-2xx upstream status with a generic message when the body has no error string", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/challenges", { body: {} }),
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
    /watch-alert-issuance tier returned an error/,
  );
});

test("returns 502 when the upstream response body is unreadable", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/challenges", { body: { ss58: SS58 } }),
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
  assert.equal((await res.json()).error.code, "watch_auth_unavailable");
});

test("maps a 429 upstream to watch_auth_rate_limited and forwards the rate-limit header family end-to-end", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/challenges", { body: { ss58: SS58 } }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({
              error: "too many wallet-auth requests; slow down",
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
  assert.equal((await res.json()).error.code, "watch_auth_rate_limited");
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("x-ratelimit-limit"), "10");
  assert.equal(res.headers.get("x-ratelimit-policy"), "10;w=60");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
});

test("maps each upstream status to a distinct, condition-specific error code", async () => {
  const codeFor = async (status: number) => {
    const res = await handleRequest(
      req("/api/v1/watch/tokens", { body: { ss58: SS58 } }),
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
  assert.equal(await codeFor(400), "watch_auth_invalid");
  assert.equal(await codeFor(401), "watch_auth_unauthorized");
  // 403 is this surface's own addition -- the per-address active-trigger cap
  // (WATCH_TRIGGERS_MAX_PER_ADDRESS), which the alert-triggers proxy has no
  // equivalent of.
  assert.equal(await codeFor(403), "watch_auth_limit_reached");
  assert.equal(await codeFor(413), "watch_auth_payload_too_large");
  assert.equal(await codeFor(429), "watch_auth_rate_limited");
  assert.equal(await codeFor(502), "watch_auth_unavailable");
  assert.equal(await codeFor(503), "watch_auth_unavailable");
  assert.equal(await codeFor(418), "watch_auth_request_failed");
});

test("does not attach rate-limit headers when the upstream error carries none", async () => {
  const res = await handleRequest(
    req("/api/v1/watch/tokens", { body: { ss58: SS58 } }),
    {
      DATA_API: {
        fetch() {
          return new Response(
            JSON.stringify({ error: "invalid or expired token" }),
            { status: 401 },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "watch_auth_unauthorized");
  assert.equal(res.headers.get("retry-after"), null);
  assert.equal(res.headers.get("x-ratelimit-limit"), null);
});
