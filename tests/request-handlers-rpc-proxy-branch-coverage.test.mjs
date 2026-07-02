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
} from "../workers/request-handlers/rpc-proxy.mjs";

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

// In-isolate health-db double capturing the events recordRpcUsage binds, so a
// test can assert the `?? null` fallback arms fired for missing fields.
function captureDb() {
  const events = [];
  return {
    events,
    prepare() {
      return {
        bind(...args) {
          events.push(args);
          return {
            run() {
              return Promise.resolve({});
            },
          };
        },
      };
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

  test("records a null endpoint_id telemetry event when all upstreams fail", async () => {
    // Drives the served-event recordRpcUsage with a 502 bare response: the
    // attempts header is absent so `Number(null) || candidates.length`
    // supplies the attempt count, and endpoint_id falls back through `?? null`.
    const db = captureDb();
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
          METAGRAPH_HEALTH_DB: db,
        }),
        url("/rpc/v1/finney"),
        ctx,
      );
      const body = await errorJson(res, 502);
      assert.equal(body.error.code, "rpc_upstream_unavailable");
      // The served telemetry event was bound: endpoint_id null, attempts = 2.
      const served = db.events.at(-1);
      assert.equal(served[2], null); // endpoint_id ?? null
      assert.equal(served[6], 2); // attempts || candidates.length
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
