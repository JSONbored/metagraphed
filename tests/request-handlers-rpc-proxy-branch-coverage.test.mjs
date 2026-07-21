// Branch-coverage tests for workers/request-handlers/rpc-proxy.mjs: drives the
// malformed-input fallbacks, error envelopes, cache-policy arms, the failover
// edge branches (truncated/no-tee bodies, empty endpoint list), and the
// usage-telemetry `?? null` arms that the primary suite leaves uncovered.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import {
  configureRpcProxy,
  handleRpcProxyRequest,
  handleSurfaceVerify,
  proxyWithFailover,
  rpcCachePolicy,
} from "../workers/request-handlers/rpc-proxy.ts";
import { MAX_STATE_QUERY_KEYS_PAGE_SIZE } from "../workers/config.ts";

const OBSERVED_AT = "2026-06-24T12:00:00.000Z";

// Origins in TRUSTED_RPC_UPSTREAM_ORIGINS (mirrors the failover suite).
const SAFE_A = "https://bittensor-finney.api.onfinality.io/public";
const SAFE_B = "https://bittensor-public.nodies.app/rpc";
const UNSAFE = "https://evil.example.com/rpc";

const ep = (id, endpointUrl, extra = {}) => ({
  id,
  url: endpointUrl,
  provider: "fixture",
  pool_eligible: true,
  score: 100,
  status: "ok",
  ...extra,
});

// A finney pool whose single endpoint is upstream-safe; used by proxy tests.
const poolWith = (...endpoints) => ({
  pools: [{ id: "finney-rpc", endpoints }],
});

function req(path, init) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function errorJson(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

// Fresh env per call so readRpcPoolArtifact's per-env memo never cross-reads
// (it keys the cache on the env object identity).
function rpcEnv(pool, overrides = {}) {
  return {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request) {
        const target = new URL(request.url);
        if (target.pathname === "/metagraph/rpc/pools.json") {
          return Response.json(pool);
        }
        return new Response("{}", { status: 404 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        return {
          async json() {
            return pool;
          },
        };
      },
    },
    ...overrides,
  };
}

// A scripted fetch stub returning the i-th reply (thunk-or-response).
function scriptedFetch(...replies) {
  const calls = [];
  const fn = async (target) => {
    const reply = replies[calls.length];
    calls.push(target);
    if (typeof reply === "function") return reply();
    return reply;
  };
  fn.calls = calls;
  return fn;
}

const jsonResponse = (status, body) => ({
  status,
  async text() {
    return typeof body === "string" ? body : JSON.stringify(body);
  },
});

// A minimal Cache-API double so the proxy's cacheable path is exercised.
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(key) {
      // Real Cache.match hands back a fresh response each time; clone so a
      // prior consumer never drains the stored body.
      const stored = store.get(key.url);
      return stored ? stored.clone() : undefined;
    },
    async put(key, response) {
      store.set(key.url, response);
    },
  };
}

// D1 write retired 2026-07-16 (item 7 of the D1->Postgres cleanup): this
// double is unused now that recordRpcUsage never touches
// METAGRAPH_HEALTH_DB, kept only so any stray reference in this file fails
// loudly with "not a function" rather than silently no-op-ing.
function captureDb() {
  return {
    prepare() {
      throw new Error(
        "recordRpcUsage must never touch METAGRAPH_HEALTH_DB (D1 write retired)",
      );
    },
  };
}

// DATA_API double capturing every request recordRpcUsage's Postgres mirror
// (syncRpcUsageEventToPostgres) posts, so a test can assert on the JSON body
// it shipped -- the sole write target for rpc_proxy_events now.
function dataApiCapture() {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ ok: true });
    },
  };
}

beforeEach(() => {
  configureRpcProxy({
    readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
  });
});

describe("rpcCachePolicy arms", () => {
  test("chain_getBlockHash with a non-array params is not cacheable", () => {
    // params is an object → the `Array.isArray(params) ? params : []` else arm.
    const policy = rpcCachePolicy("chain_getBlockHash", { not: "array" });
    assert.deepEqual(policy, { cacheable: false, ttl: 0 });
  });

  test("chain_getBlockHash caches a numeric-string block argument via regex", () => {
    // String "100" → the `/^\d+$/.test(String(args[0]))` regex arm.
    const policy = rpcCachePolicy("chain_getBlockHash", ["100"]);
    assert.deepEqual(policy, { cacheable: true, ttl: 3600 });
  });

  test("chain_getBlockHash with a non-numeric string is not cacheable", () => {
    const policy = rpcCachePolicy("chain_getBlockHash", ["latest"]);
    assert.deepEqual(policy, { cacheable: false, ttl: 0 });
  });

  test("quasi-static method is cacheable regardless of params shape", () => {
    const policy = rpcCachePolicy("system_chain", { ignored: true });
    assert.deepEqual(policy, { cacheable: true, ttl: 300 });
  });
});

describe("handleRpcProxyRequest routing fallbacks", () => {
  const rpcPost = (path, body) =>
    req(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.20",
      },
      body: JSON.stringify(body),
    });

  test("empty network segment falls back to the (none) unsupported error", async () => {
    // pathname "/rpc" → split("/")[3] is undefined → `|| ""` empty network.
    const res = await handleRpcProxyRequest(
      rpcPost("/rpc", { jsonrpc: "2.0", id: 1, method: "system_health" }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc"),
    );
    const body = await errorJson(res, 404);
    assert.equal(body.error.code, "rpc_network_unsupported");
    assert.ok(body.error.message.includes("(none)"));
  });

  test("a pools-less artifact yields no static pool and a 503", async () => {
    // pools key absent → `(poolArtifact.data.pools || [])` empty → no endpoints.
    const res = await handleRpcProxyRequest(
      rpcPost("/rpc/v1/finney", {
        jsonrpc: "2.0",
        id: 1,
        method: "system_health",
      }),
      rpcEnv({}),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 503);
    assert.equal(body.error.code, "rpc_endpoint_unavailable");
    assert.equal(body.meta.pool_id, "finney-rpc");
  });

  test("an unsafe endpoint with no id reports a null endpoint_id", async () => {
    // The sole eligible endpoint is unsafe and has no id → the detail
    // `unsafeEndpoint.id || null` takes the null arm.
    const idless = {
      url: UNSAFE,
      provider: "fixture",
      pool_eligible: true,
      score: 100,
      status: "ok",
    };
    const res = await handleRpcProxyRequest(
      rpcPost("/rpc/v1/finney", {
        jsonrpc: "2.0",
        id: 1,
        method: "system_health",
      }),
      rpcEnv(poolWith(idless)),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 502);
    assert.equal(body.error.code, "rpc_endpoint_unsafe");
    assert.equal(body.meta.endpoint_id, null);
  });
});

describe("handleRpcProxyRequest telemetry + cache path", () => {
  const rpcPost = (body) =>
    req("/rpc/v1/finney", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.20",
      },
      body: JSON.stringify(body),
    });

  // D1 write retired 2026-07-16 (item 7 of the D1->Postgres cleanup):
  // syncRpcUsageEventToPostgres (via env.DATA_API) is the sole writer now --
  // these two drive it the same "dataApiCapture" way the
  // "syncRpcUsageEventToPostgres wiring" describe block below does.
  test("records a null endpoint_id telemetry event when all upstreams fail", async () => {
    // Drives the served-event recordRpcUsage with a 502 bare response: the
    // attempts header is absent (proxyWithFailover's exhausted-pool path never
    // sets it) so `Number(null) || Math.min(candidates.length, RPC_MAX_ATTEMPTS)`
    // supplies the attempt count, and endpoint_id falls back through `?? null`.
    const dataApi = dataApiCapture();
    const ctx = { waitUntil: () => {} };
    const original = globalThis.fetch;
    globalThis.fetch = scriptedFetch(
      () => {
        throw new Error("net");
      },
      () => {
        throw new Error("net");
      },
    );
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
        rpcEnv(poolWith(ep("a", SAFE_A), ep("b", SAFE_B)), {
          DATA_API: dataApi,
          RPC_USAGE_SYNC_SECRET: "test-secret",
        }),
        url("/rpc/v1/finney"),
        ctx,
      );
      const body = await errorJson(res, 502);
      assert.equal(body.error.code, "rpc_upstream_unavailable");
      // The served telemetry event was posted: endpoint_id null, attempts = 2.
      assert.equal(dataApi.calls.length, 1);
      const served = await dataApi.calls[0].json();
      assert.equal(served.endpoint_id, null); // endpoint_id ?? null
      assert.equal(served.attempts, 2); // attempts || Math.min(candidates.length, RPC_MAX_ATTEMPTS)
    } finally {
      globalThis.fetch = original;
    }
  });

  test("caps the fallback attempts count at RPC_MAX_ATTEMPTS when the pool has more eligible endpoints than the failover cap", async () => {
    // A 4-endpoint pool exceeds RPC_MAX_ATTEMPTS (3): proxyWithFailover only
    // ever tries `Math.min(orderedEndpoints.length, RPC_MAX_ATTEMPTS)` of them,
    // so the fallback attempt count reported when its attempts header is absent
    // must match that cap, not the full (uncapped) candidate count — otherwise
    // rpc_usage_events.attempts is inflated whenever the eligible pool > 3.
    const dataApi = dataApiCapture();
    const ctx = { waitUntil: () => {} };
    const original = globalThis.fetch;
    const fetchFn = scriptedFetch(
      () => {
        throw new Error("net");
      },
      () => {
        throw new Error("net");
      },
      () => {
        throw new Error("net");
      },
    );
    globalThis.fetch = fetchFn;
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
        rpcEnv(
          poolWith(
            ep("a", SAFE_A),
            ep("b", SAFE_B),
            ep("c", "https://entrypoint-finney.opentensor.ai"),
            ep("d", "https://lite.chain.opentensor.ai"),
          ),
          { DATA_API: dataApi, RPC_USAGE_SYNC_SECRET: "test-secret" },
        ),
        url("/rpc/v1/finney"),
        ctx,
      );
      const body = await errorJson(res, 502);
      assert.equal(body.error.code, "rpc_upstream_unavailable");
      // Only 3 upstream calls were actually made (the failover cap), not 4.
      assert.equal(fetchFn.calls.length, 3);
      assert.equal(dataApi.calls.length, 1);
      const served = await dataApi.calls[0].json();
      assert.equal(served.attempts, 3); // capped, not the uncapped 4-candidate count
    } finally {
      globalThis.fetch = original;
    }
  });

  test("caches a successful quasi-static result and rebuilds the id on a hit", async () => {
    // system_chain is cacheable with non-array params → rpcCacheKey's `: []`
    // arm; the stored result is replayed with THIS request's id.
    const cache = fakeCache();
    const ctx = { waitUntil: (p) => p };
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    globalThis.caches = { default: cache };
    globalThis.fetch = scriptedFetch(
      jsonResponse(200, { jsonrpc: "2.0", id: 999, result: "bittensor" }),
    );
    try {
      const env = rpcEnv(poolWith(ep("a", SAFE_A)));
      // First call: cache miss → upstream served, result stored.
      const miss = await handleRpcProxyRequest(
        req("/rpc/v1/finney", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.20",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "system_chain",
            params: { trailing: true },
          }),
        }),
        env,
        url("/rpc/v1/finney"),
        ctx,
      );
      assert.equal(miss.status, 200);
      assert.equal(miss.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal(cache.store.size, 1);

      // Second call (fresh env so the upstream is never re-hit): cache hit
      // rebuilds the envelope with id 42, never replaying the primer's id 999.
      globalThis.fetch = scriptedFetch(() => {
        throw new Error("upstream must not be hit on a cache hit");
      });
      const hit = await handleRpcProxyRequest(
        req("/rpc/v1/finney", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.20",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 42,
            method: "system_chain",
            params: { trailing: true },
          }),
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
        ctx,
      );
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get("x-metagraph-rpc-cache"), "hit");
      const hitBody = await hit.json();
      assert.equal(hitBody.id, 42);
      assert.equal(hitBody.result, "bittensor");

      // Third call: a request WITHOUT an `id` → rpcResultEnvelope omits the id
      // field entirely (the `hasOwnProperty(requestBody, "id")` false arm, 713).
      const idless = await handleRpcProxyRequest(
        req("/rpc/v1/finney", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.20",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "system_chain",
            params: { trailing: true },
          }),
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
        ctx,
      );
      assert.equal(idless.headers.get("x-metagraph-rpc-cache"), "hit");
      const idlessBody = await idless.json();
      assert.equal(
        Object.prototype.hasOwnProperty.call(idlessBody, "id"),
        false,
      );
      assert.equal(idlessBody.result, "bittensor");
    } finally {
      globalThis.caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });

  test("a cacheable miss with an oversized body skips caching (truncated)", async () => {
    // proxyWithFailover tees the >64 KiB upstream: its own inspection truncates
    // and hands the client the un-consumed live half. The handler then re-inspects
    // (response.clone) and sees truncated → the `if (!inspect.truncated)` guard
    //  is false, so the oversized result is streamed back but never cached.
    const cache = fakeCache();
    const ctx = { waitUntil: () => {} };
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    globalThis.caches = { default: cache };
    // A clean tee-able stream emitting > 64 KiB of valid JSON in chunks.
    const chunk = new TextEncoder().encode("x".repeat(40 * 1024));
    let pulls = 0;
    const bigBody = new globalThis.ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
    });
    globalThis.fetch = scriptedFetch(
      new Response(bigBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const res = await handleRpcProxyRequest(
        req("/rpc/v1/finney", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.20",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "system_chain",
          }),
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
        ctx,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-metagraph-rpc-cache"), "miss");
      // The oversized body is too large to classify/cache → store stays empty.
      assert.equal(cache.store.size, 0);
    } finally {
      globalThis.caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });
});

// #4832 gap-closure: syncRpcUsageEventToPostgres (the Pattern-C per-request
// Postgres mirror recordRpcUsage fires before its D1 write) is unexported, so
// these drive it the same way the telemetry test above drives recordRpcUsage
// itself -- through a guaranteed-502 handleRpcProxyRequest call (both
// upstreams throw) that deterministically reaches the served-event write.
describe("syncRpcUsageEventToPostgres wiring (#4832 gap-closure)", () => {
  const rpcPost = (body) =>
    req("/rpc/v1/finney", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.20",
      },
      body: JSON.stringify(body),
    });

  const failBothUpstreams = () =>
    scriptedFetch(
      () => {
        throw new Error("net");
      },
      () => {
        throw new Error("net");
      },
    );

  test("posts a mirrored event to DATA_API when the sync secret is configured", async () => {
    const db = captureDb();
    const dataApi = dataApiCapture();
    let waited = null;
    const ctx = {
      waitUntil: (p) => {
        waited = p;
      },
    };
    const original = globalThis.fetch;
    globalThis.fetch = failBothUpstreams();
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
        rpcEnv(poolWith(ep("a", SAFE_A), ep("b", SAFE_B)), {
          METAGRAPH_HEALTH_DB: db,
          DATA_API: dataApi,
          RPC_USAGE_SYNC_SECRET: "test-secret",
        }),
        url("/rpc/v1/finney"),
        ctx,
      );
      await errorJson(res, 502);
      assert.equal(dataApi.calls.length, 1);
      const sent = dataApi.calls[0];
      assert.equal(
        sent.url,
        "https://api.metagraph.sh/api/v1/internal/rpc-usage-sync",
      );
      assert.equal(sent.method, "POST");
      assert.equal(sent.headers.get("x-rpc-usage-sync-token"), "test-secret");
      const body = await sent.json();
      assert.equal(body.network, "finney");
      assert.equal(body.ok, false);
      assert.equal(body.attempts, 2);
      // ctx.waitUntil actually received the fire-and-forget promise.
      assert.ok(waited);
      await waited;
    } finally {
      globalThis.fetch = original;
    }
  });

  test("skips the Postgres mirror when RPC_USAGE_SYNC_SECRET is not configured", async () => {
    const db = captureDb();
    const dataApi = dataApiCapture();
    const ctx = { waitUntil: () => {} };
    const original = globalThis.fetch;
    globalThis.fetch = failBothUpstreams();
    try {
      await handleRpcProxyRequest(
        rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
        rpcEnv(poolWith(ep("a", SAFE_A), ep("b", SAFE_B)), {
          METAGRAPH_HEALTH_DB: db,
          DATA_API: dataApi,
        }),
        url("/rpc/v1/finney"),
        ctx,
      );
      assert.equal(dataApi.calls.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("skips the Postgres mirror when ctx.waitUntil is not a function", async () => {
    const db = captureDb();
    const dataApi = dataApiCapture();
    const original = globalThis.fetch;
    globalThis.fetch = failBothUpstreams();
    try {
      await handleRpcProxyRequest(
        rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
        rpcEnv(poolWith(ep("a", SAFE_A), ep("b", SAFE_B)), {
          METAGRAPH_HEALTH_DB: db,
          DATA_API: dataApi,
          RPC_USAGE_SYNC_SECRET: "test-secret",
        }),
        url("/rpc/v1/finney"),
        {},
      );
      assert.equal(dataApi.calls.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("state-query methods (#4344/9.2)", () => {
  const rpcPost = (body) =>
    req("/rpc/v1/finney", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.20",
      },
      body: JSON.stringify(body),
    });
  const HEX_KEY = `0x${"ab".repeat(16)}`;

  test("state_getPairs stays blocked -- excluded from the narrower allowlist", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getPairs",
        params: ["0x"],
      }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 403);
    assert.equal(body.error.code, "rpc_method_blocked");
    // The allowed_methods hint includes the state-query methods that ARE
    // permitted, so a caller can tell "wrong method" from "misconfigured".
    assert.ok(body.meta.allowed_methods.includes("state_getStorage"));
    assert.ok(!body.meta.allowed_methods.includes("state_getPairs"));
  });

  test("400 rpc_invalid_request for a malformed state_getStorage key", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: ["not-hex"],
      }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_request");
    assert.match(body.error.message, /state_getStorage/);
  });

  test("400 rpc_invalid_request for a malformed state_getKeysPaged prefix", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getKeysPaged",
        params: ["0xzz", 10],
      }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_request");
    assert.match(body.error.message, /state_getKeysPaged/);
  });

  test("400 rpc_invalid_request for a malformed state_getKeysPaged startKey", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getKeysPaged",
        params: [HEX_KEY, 10, "not-hex"],
      }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_request");
    assert.match(body.error.message, /startKey/);
  });

  test("400 rpc_invalid_request for a malformed state_getStorage at (never reaches upstream)", async () => {
    // #6014: optional block-hash `at` must be validated before forwarding.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (...args) => {
      fetchCalls += 1;
      return originalFetch(...args);
    };
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getStorage",
          params: [HEX_KEY, "not-a-block-hash"],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      const body = await errorJson(res, 400);
      assert.equal(body.error.code, "rpc_invalid_request");
      assert.match(body.error.message, /\bat\b/);
      assert.equal(fetchCalls, 0, "malformed at must not reach upstream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("400 rpc_invalid_request for a malformed state_getKeysPaged at (never reaches upstream)", async () => {
    // #6014: optional block-hash `at` must be validated before forwarding.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (...args) => {
      fetchCalls += 1;
      return originalFetch(...args);
    };
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getKeysPaged",
          params: [HEX_KEY, 10, HEX_KEY, "0xshort"],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      const body = await errorJson(res, 400);
      assert.equal(body.error.code, "rpc_invalid_request");
      assert.match(body.error.message, /\bat\b/);
      assert.equal(fetchCalls, 0, "malformed at must not reach upstream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards a well-formed state_getStorage at to upstream", async () => {
    const BLOCK_HASH = `0x${"cd".repeat(32)}`;
    const originalFetch = globalThis.fetch;
    let forwardedBodyText = null;
    globalThis.fetch = async (_endpointUrl, init) => {
      forwardedBodyText = init?.body ?? null;
      return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: "0x01" });
    };
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getStorage",
          params: [HEX_KEY, BLOCK_HASH],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      assert.equal(res.status, 200);
      assert.ok(forwardedBodyText, "expected the upstream fetch to be called");
      const forwardedBody = JSON.parse(forwardedBodyText);
      assert.equal(forwardedBody.params[1], BLOCK_HASH);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("400 rpc_invalid_request for a non-integer/negative state_getKeysPaged count", async () => {
    for (const count of [-1, "not-a-number", Number.NaN]) {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getKeysPaged",
          params: [HEX_KEY, count],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      const body = await errorJson(res, 400);
      assert.equal(body.error.code, "rpc_invalid_request");
    }
  });

  test("clamps an oversized state_getKeysPaged count before forwarding upstream", async () => {
    // proxyWithFailover calls fetchFn(endpoint.url, {..., body}) -- a bare URL
    // string plus an init object, not a Request -- so capture the init body
    // directly rather than via scriptedFetch (which only records the URL arg).
    const originalFetch = globalThis.fetch;
    let forwardedBodyText = null;
    globalThis.fetch = async (_endpointUrl, init) => {
      forwardedBodyText = init?.body ?? null;
      return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: [] });
    };
    try {
      await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getKeysPaged",
          params: [HEX_KEY, MAX_STATE_QUERY_KEYS_PAGE_SIZE + 1000],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      assert.ok(forwardedBodyText, "expected the upstream fetch to be called");
      const forwardedBody = JSON.parse(forwardedBodyText);
      assert.equal(forwardedBody.params[1], MAX_STATE_QUERY_KEYS_PAGE_SIZE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("429 rpc_state_query_rate_limited when the state-query limiter rejects the client", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: [HEX_KEY],
      }),
      rpcEnv(poolWith(ep("a", SAFE_A)), {
        STATE_QUERY_RATE_LIMITER: { limit: async () => ({ success: false }) },
      }),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 429);
    assert.equal(body.error.code, "rpc_state_query_rate_limited");
  });

  test("200 happy path for state_getStorage", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = scriptedFetch(
      jsonResponse(200, { jsonrpc: "2.0", id: 1, result: "0xdeadbeef" }),
    );
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getStorage",
          params: [HEX_KEY],
        }),
        // A present-and-passing limiter, distinct from the other tests here
        // (which omit the binding entirely): exercises the `success` arm of
        // the `!success` check below, not just its "binding absent" skip.
        rpcEnv(poolWith(ep("a", SAFE_A)), {
          STATE_QUERY_RATE_LIMITER: { limit: async () => ({ success: true }) },
        }),
        url("/rpc/v1/finney"),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result, "0xdeadbeef");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("400 rpc_invalid_request when state_getStorage params is not an array", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: { not: "an array" },
      }),
      rpcEnv(poolWith(ep("a", SAFE_A))),
      url("/rpc/v1/finney"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_request");
  });

  test("502 rpc_response_too_large when the upstream response exceeds the state-query size cap", async () => {
    const originalFetch = globalThis.fetch;
    // A clean tee-able stream emitting > 256 KiB of valid JSON in chunks
    // (mirrors the >64 KiB oversized-body pattern above, sized for this
    // method's own, tighter MAX_STATE_QUERY_RESPONSE_BYTES cap).
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let pulls = 0;
    const bigBody = new globalThis.ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 5) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
    });
    globalThis.fetch = scriptedFetch(
      new Response(bigBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const res = await handleRpcProxyRequest(
        rpcPost({
          jsonrpc: "2.0",
          id: 1,
          method: "state_getKeysPaged",
          params: [HEX_KEY, 10],
        }),
        rpcEnv(poolWith(ep("a", SAFE_A))),
        url("/rpc/v1/finney"),
      );
      const body = await errorJson(res, 502);
      assert.equal(body.error.code, "rpc_response_too_large");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyWithFailover edge branches", () => {
  const base = { bodyText: "{}", poolId: "finney-rpc", healthMap: new Map() };

  test("an empty endpoint list returns a 502 with a null last_reason", async () => {
    // limit = 0 → the loop never runs → attempts stays empty so
    // `attempts.at(-1)?.reason || null` yields null.
    const res = await proxyWithFailover([], {
      ...base,
      fetchFn: scriptedFetch(),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "rpc_upstream_unavailable");
    assert.deepEqual(body.meta.attempts, []);
    assert.equal(body.meta.last_reason, null);
  });

  test("a non-tee upstream body over the limit skips parse and streams the slice", async () => {
    // A plain response object (no body.tee) over 64 KiB → readResponseTextWithLimit
    // reports truncated → the `if (!inspect.truncated)` guard is skipped
    // (never parsed for a transient JSON-RPC error) and the bounded slice is
    // returned, clearing the breaker on a reachable success.
    const huge = "x".repeat(70 * 1024);
    const fetchFn = scriptedFetch({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      async text() {
        return huge;
      },
    });
    const res = await proxyWithFailover([ep("a", SAFE_A)], {
      ...base,
      fetchFn,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "a");
    const text = await res.text();
    // Body is bounded to the 64 KiB classification limit, not the full 70 KiB.
    assert.equal(text.length, 64 * 1024);
  });
});

describe("handleSurfaceVerify alias + cache branches", () => {
  // A catalog/env whose surfaces never match so the alias lookup is consulted.
  function verifyEnv(aliasOk) {
    return {
      ASSETS: {
        async fetch(request) {
          const target = new URL(request.url);
          if (target.pathname === "/metagraph/operational-surfaces.json") {
            return Response.json({ surfaces: [] });
          }
          // SURFACE_ALIASES_PATH artifact: ok or 404 depending on the test.
          if (aliasOk) {
            return Response.json({});
          }
          return new Response("nope", { status: 404 });
        },
      },
    };
  }

  const verifyReq = req("/api/v1/surfaces/ghost/verify", {
    headers: { "cf-connecting-ip": "203.0.113.10" },
  });

  test("consults the alias artifact when the direct lookup misses", async () => {
    // catalog.ok with no match → `!surface` true → alias read (ok) → re-lookup
    // still misses → 404 surface_not_found. Exercises the aliases.ok arm.
    let fetched = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    try {
      const res = await handleSurfaceVerify(
        verifyReq,
        verifyEnv(true),
        "ghost",
      );
      const body = await errorJson(res, 404);
      assert.equal(body.error.code, "surface_not_found");
      assert.equal(body.meta.surface_id, "ghost");
      // No outbound probe for an unresolved surface.
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a missing alias artifact still yields surface_not_found", async () => {
    const res = await handleSurfaceVerify(verifyReq, verifyEnv(false), "ghost");
    const body = await errorJson(res, 404);
    assert.equal(body.error.code, "surface_not_found");
  });

  test("an under-limit verify client passes the limiter and proceeds", async () => {
    // RPC_RATE_LIMITER present + success:true → the `if (!success)` false arm:
    // no 429 short-circuit, the handler continues to the catalog lookup.
    const env = verifyEnv(false);
    env.RPC_RATE_LIMITER = { limit: async () => ({ success: true }) };
    const res = await handleSurfaceVerify(verifyReq, env, "ghost");
    // Still 404 (the surface does not exist) — but the limiter did NOT reject.
    const body = await errorJson(res, 404);
    assert.equal(body.error.code, "surface_not_found");
  });

  test("a matched surface lacking a surface_key falls back to its surface_id", async () => {
    // findSurface matches on surface_id; with no surface_key the canonical id
    // is `surface.surface_key || surface.surface_id` → the surface_id arm.
    const matchEnv = {
      // No Cache API binding so the cache match/put path is skipped and the
      // probe runs directly through the stubbed fetch.
      ASSETS: {
        async fetch(request) {
          const target = new URL(request.url);
          if (target.pathname === "/metagraph/operational-surfaces.json") {
            return Response.json({
              surfaces: [
                {
                  surface_id: "keyless-surface",
                  kind: "subnet-api",
                  url: "https://keyless.example.com/health",
                  provider: "fixture",
                  auth_required: false,
                  public_safe: true,
                  probe: { expect: "json", method: "GET", timeout_ms: 10000 },
                },
              ],
            });
          }
          return new Response("nope", { status: 404 });
        },
      },
    };
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    globalThis.caches = undefined; // no Cache API → skip the 60s cache layer
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const res = await handleSurfaceVerify(
        req("/api/v1/surfaces/keyless-surface/verify", {
          headers: { "cf-connecting-ip": "203.0.113.10" },
        }),
        matchEnv,
        "keyless-surface",
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.surface_id, "keyless-surface");
      assert.equal(body.data.surface_key, null);
      assert.equal(body.data.from_cache, false);
    } finally {
      globalThis.caches = originalCaches;
      globalThis.fetch = originalFetch;
    }
  });
});
