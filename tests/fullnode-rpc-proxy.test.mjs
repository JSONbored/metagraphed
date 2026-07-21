// Unit tests for the isolated, account-gated fullnode RPC proxy
// (workers/request-handlers/fullnode-rpc-proxy.mjs). Real
// orderSafeRpcEndpoints/proxyWithFailover (rpc-proxy.mjs) run unmocked --
// only the upstream `fetch` is monkey-patched, matching this codebase's
// established convention (e.g. tests/address-mapping.test.mjs) rather than
// injecting a fetchFn the handler doesn't expose.
//
// Key validation goes through src/api-key-validation.mjs's real KV-cache-
// fronted lookup, which on a miss calls the DATA_API service binding's
// internal verify route -- mocked here to return whatever
// {valid, code, tier, accountId} shape each test needs, exactly the
// contract workers/data-api.mjs's handleApiKeyVerify actually returns.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { handleFullnodeRpcProxyRequest } from "../workers/request-handlers/fullnode-rpc-proxy.ts";

function createFakeKv() {
  const store = new Map();
  return {
    async get(key, options) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const VALID_KEY = "mg_aValidOpaqueUnkeyGeneratedSuffix";

function makeValidatedKeyEnv(overrides = {}) {
  const env = {
    METAGRAPH_CONTROL: createFakeKv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
    DATA_API: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            valid: overrides.revoked_at ? false : true,
            code: overrides.revoked_at ? "DISABLED" : "VALID",
            tier: overrides.tier ?? "free",
            accountId: "1",
          }),
          { status: 200 },
        ),
    },
    FULLNODE_RPC_ORIGINS: "https://fullnode-gated.metagraph.sh",
    ...overrides,
  };
  return { env, key: VALID_KEY };
}

function req(path, { method = "POST", body } = {}) {
  return new Request(`https://d${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(path, opts, env) {
  const request = req(path, opts);
  const url = new URL(request.url);
  return handleFullnodeRpcProxyRequest(request, env, url);
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("rejects non-POST methods", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    {
      method: "GET",
    },
    env,
  );
  assert.equal(res.status, 405);
});

test("429s when the guess-rate limiter denies (before key validation)", async () => {
  const { env } = makeValidatedKeyEnv({
    FULLNODE_RPC_GUESS_RATE_LIMITER: {
      limit: async () => ({ success: false }),
    },
  });
  const res = await call(
    "/rpc/v1/fullnode",
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 429);
});

test("proceeds past the guess-rate limiter when it's bound and allows", async () => {
  const { env } = makeValidatedKeyEnv({
    FULLNODE_RPC_GUESS_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const res = await call(
    "/rpc/v1/fullnode",
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  // No key was provided, so this still 401s -- the point is it got PAST the
  // guess-limiter's success:true branch rather than short-circuiting there.
  assert.equal(res.status, 401);
});

test("401s when no API key is provided", async () => {
  const { env } = makeValidatedKeyEnv();
  const res = await call(
    "/rpc/v1/fullnode",
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 401);
});

test("401s on an invalid/malformed API key", async () => {
  const { env } = makeValidatedKeyEnv();
  const res = await call(
    "/rpc/v1/fullnode?authorization=not-a-real-key",
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 401);
});

test("401s on a revoked key with a distinct message", async () => {
  const { env, key } = makeValidatedKeyEnv({ revoked_at: 12345 });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error.message, /revoked/);
});

test("429s when the per-key rate limiter denies", async () => {
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 429);
});

test("gittensor-partner tier keys are rate-limited against the Gittensor binding, not the free one", async () => {
  const { env, key } = makeValidatedKeyEnv({
    tier: "gittensor-partner",
    FULLNODE_RPC_RATE_LIMITER: {
      limit: async () => {
        throw new Error(
          "free-tier limiter must not be consulted for this tier",
        );
      },
    },
    FULLNODE_RPC_RATE_LIMITER_GITTENSOR: {
      limit: async () => ({ success: false }),
    },
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 429);
  // The Gittensor tier's own, materially higher policy figure (6000/60s),
  // not the free tier's (300/60s).
  assert.equal(res.headers.get("x-ratelimit-limit"), "6000");
});

test("gittensor-partner tier keys succeed past a bound-and-allowing Gittensor limiter", async () => {
  const { env, key } = makeValidatedKeyEnv({
    tier: "gittensor-partner",
    FULLNODE_RPC_RATE_LIMITER_GITTENSOR: {
      limit: async () => ({ success: true }),
    },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
    });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 200);
});

test("unlimited tier keys are rate-limited against their own, much higher binding", async () => {
  const { env, key } = makeValidatedKeyEnv({
    tier: "unlimited",
    FULLNODE_RPC_RATE_LIMITER: {
      limit: async () => {
        throw new Error(
          "free-tier limiter must not be consulted for this tier",
        );
      },
    },
    FULLNODE_RPC_RATE_LIMITER_UNLIMITED: {
      limit: async () => ({ success: false }),
    },
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-ratelimit-limit"), "100000");
});

test("an unrecognized tier falls back to the free-tier rate-limit policy", async () => {
  const { env, key } = makeValidatedKeyEnv({
    tier: "some-future-tier",
    FULLNODE_RPC_RATE_LIMITER: {
      limit: async () => ({ success: false }),
    },
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-ratelimit-limit"), "300");
});

test("keys with the same tier from different accounts are rate-limited independently, by accountId", async () => {
  const calls = [];
  const env = {
    METAGRAPH_CONTROL: createFakeKv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
    DATA_API: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            valid: true,
            code: "VALID",
            tier: "free",
            accountId: "42",
          }),
          { status: 200 },
        ),
    },
    FULLNODE_RPC_ORIGINS: "https://fullnode-gated.metagraph.sh",
    FULLNODE_RPC_RATE_LIMITER: {
      limit: async ({ key }) => {
        calls.push(key);
        return { success: true };
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
    });
  await call(
    `/rpc/v1/fullnode?authorization=${VALID_KEY}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.deepEqual(calls, ["fullnode-rpc:42"]);
});

test("400s on an unparsable/negative content-length header", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const request = new Request(
    `https://d/rpc/v1/fullnode?authorization=${key}`,
    {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "{}",
    },
  );
  const res = await handleFullnodeRpcProxyRequest(
    request,
    env,
    new URL(request.url),
  );
  assert.equal(res.status, 400);
});

test("413s on an oversized content-length header", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const request = new Request(
    `https://d/rpc/v1/fullnode?authorization=${key}`,
    {
      method: "POST",
      headers: { "content-length": "999999999" },
      body: "{}",
    },
  );
  const res = await handleFullnodeRpcProxyRequest(
    request,
    env,
    new URL(request.url),
  );
  assert.equal(res.status, 413);
});

test("413s on a body that actually exceeds the byte limit", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "system_health",
        params: ["x".repeat(200000)],
      },
    },
    env,
  );
  assert.equal(res.status, 413);
});

test("400s on unparsable JSON", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const request = new Request(
    `https://d/rpc/v1/fullnode?authorization=${key}`,
    { method: "POST", body: "{not json" },
  );
  const res = await handleFullnodeRpcProxyRequest(
    request,
    env,
    new URL(request.url),
  );
  assert.equal(res.status, 400);
});

test("400s on a non-object / missing method body", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const arrayBody = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: [1, 2, 3] },
    env,
  );
  assert.equal(arrayBody.status, 400);
  const noMethod = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1 } },
    env,
  );
  assert.equal(noMethod.status, 400);
});

test("403s on a blocked method (author_ prefix, not the allowed exception)", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "author_insertKey" } },
    env,
  );
  assert.equal(res.status, 403);
});

test("403s on a method outside both the safe set and the write exception", async () => {
  const { env, key } = makeValidatedKeyEnv();
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "state_getStorage" } },
    env,
  );
  assert.equal(res.status, 403);
});

test("403s on other denied prefixes (sudo_/payment_/contracts_/state_call)", async () => {
  const { env, key } = makeValidatedKeyEnv();
  for (const method of [
    "sudo_sudo",
    "payment_queryInfo",
    "contracts_call",
    "state_call",
  ]) {
    const res = await call(
      `/rpc/v1/fullnode?authorization=${key}`,
      { body: { jsonrpc: "2.0", id: 1, method } },
      env,
    );
    assert.equal(res.status, 403, `expected ${method} to be blocked`);
  }
});

test("503s when no FULLNODE_RPC_ORIGINS is configured", async () => {
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_ORIGINS: undefined,
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 503);
});

test("skips malformed origin config entries without crashing", async () => {
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_ORIGINS: "not a url, also not one,,",
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 503);
});

test("502s when the configured origin is not https/wss (unsafe)", async () => {
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_ORIGINS: "http://insecure.example.com",
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 502);
});

test("502s when the configured origin resolves to a private/local hostname (unsafe)", async () => {
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_ORIGINS: "https://127.0.0.1",
  });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 502);
});

test("happy path: proxies a read method through to the configured origin", async () => {
  const { env, key } = makeValidatedKeyEnv({
    // Bound-and-allows for both limiters, plus an accurate content-length
    // header -- exercises the "everything passes" branch of each gate, not
    // just the "gate absent" default path the other tests use.
    FULLNODE_RPC_GUESS_RATE_LIMITER: { limit: async () => ({ success: true }) },
    FULLNODE_RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
    });
  const bodyText = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
  });
  const request = new Request(
    `https://d/rpc/v1/fullnode?authorization=${key}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(bodyText).length),
      },
      body: bodyText,
    },
  );
  const res = await handleFullnodeRpcProxyRequest(
    request,
    env,
    new URL(request.url),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-metagraph-rpc-endpoint-id"));
  const body = await res.json();
  assert.equal(body.result, "ok");
});

test("happy path: allows the one write method exception (author_submitExtrinsic)", async () => {
  const { env, key } = makeValidatedKeyEnv();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xhash" }), {
      status: 200,
    });
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "author_submitExtrinsic",
        params: ["0xdeadbeef"],
      },
    },
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result, "0xhash");
});

test("fails over to a second configured origin when one is unreachable", async () => {
  // orderSafeRpcEndpoints weighted-shuffles equally-scored endpoints, so
  // which of the two is tried first is not deterministic from here -- assert
  // on the end-to-end outcome (a working pair of origins always yields a
  // 200), not attempt count/order. The failover walk itself is exhaustively
  // unit-tested in tests/request-handlers-rpc-proxy.test.mjs; this only
  // confirms this handler's own multi-origin wiring doesn't break it.
  const { env, key } = makeValidatedKeyEnv({
    FULLNODE_RPC_ORIGINS:
      "https://fullnode-gated.metagraph.sh,https://fullnode-gated-2.metagraph.sh",
  });
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    // "fullnode-gated-2..." deliberately does NOT match this substring, so
    // only the first origin is made to fail.
    if (String(url).includes("fullnode-gated.metagraph.sh")) {
      throw new Error("unreachable");
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
      {
        status: 200,
      },
    );
  };
  const res = await call(
    `/rpc/v1/fullnode?authorization=${key}`,
    { body: { jsonrpc: "2.0", id: 1, method: "system_health" } },
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result, "ok");
  assert.ok(calls >= 1);
});
