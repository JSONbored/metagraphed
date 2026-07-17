// Direct unit tests for workers/request-handlers/rpc-proxy.mjs (#1977).
// Exercises RPC usage analytics, surface verify, GraphQL rate limiting, and
// proxy guard rails without routing through workers/api.mjs.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  configureRpcProxy,
  graphqlRateLimited,
  handleRpcProxyRequest,
  handleRpcUsage,
  handleSurfaceVerify,
} from "../workers/request-handlers/rpc-proxy.mjs";

const OBSERVED_AT = "2026-06-24T12:00:00.000Z";
const SURFACE_ID = "sn-6-numinous-api-health";

const RPC_POOL = {
  pools: [
    {
      id: "finney-rpc",
      endpoints: [
        {
          id: "fx",
          provider: "fx",
          pool_eligible: true,
          status: "ok",
          score: 100,
          url: "https://bittensor-finney.api.onfinality.io/public",
        },
      ],
    },
  ],
};

function req(path, init) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res, status = 200) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await res.json();
  if (status < 400) assert.equal(body.ok, true);
  return body;
}

async function errorJson(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

function rpcEnv(overrides = {}) {
  return {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request) {
        const target = new URL(request.url);
        if (target.pathname === "/metagraph/rpc/pools.json") {
          return Response.json(RPC_POOL);
        }
        return new Response("{}", { status: 404 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        return {
          async json() {
            return RPC_POOL;
          },
        };
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  configureRpcProxy({
    readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
  });
});

describe("handleRpcUsage", () => {
  // D1 fully eliminated (2026-07-17): loadRpcUsage never queries
  // rpc_proxy_events any more, so a Postgres-tier miss always returns the
  // schema-stable empty payload -- this is now the only cold-path shape.
  test("returns a schema-stable zeroed payload on a Postgres-tier miss", async () => {
    const body = await json(
      await handleRpcUsage(
        req("/api/v1/rpc/usage"),
        {},
        url("/api/v1/rpc/usage"),
      ),
    );
    assert.equal(body.data.source, "rpc-proxy");
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.summary.total_requests, 0);
    assert.deepEqual(body.data.endpoints, []);
    assert.deepEqual(body.data.networks, []);
    assert.equal(body.data.observed_at, OBSERVED_AT);
    assert.equal(body.meta.artifact_path, "/metagraph/rpc/usage.json");
  });

  test("rejects unsupported query parameters", async () => {
    const res = await handleRpcUsage(
      req("/api/v1/rpc/usage?cacheBust=x"),
      {},
      url("/api/v1/rpc/usage?cacheBust=x"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.meta.parameter, "cacheBust");
  });

  test("rejects unknown window values", async () => {
    const res = await handleRpcUsage(
      req("/api/v1/rpc/usage?window=90d"),
      {},
      url("/api/v1/rpc/usage?window=90d"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.meta.parameter, "window");
  });

  // #4832 gap-closure: METAGRAPH_RPC_USAGE_SOURCE is flipped to "postgres" in
  // wrangler.jsonc (after a one-time historical backfill -- see its inline
  // comment) -- these tests prove the wiring, independent of that live flag
  // value.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = {
      METAGRAPH_RPC_USAGE_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "7d",
            source: "rpc-proxy",
            summary: { total_requests: 42 },
            endpoints: [],
            networks: [],
            buckets: [],
          }),
      },
      get METAGRAPH_HEALTH_DB() {
        d1Called = true;
        throw new Error("D1 must not be queried when Postgres serves");
      },
    };
    const body = await json(
      await handleRpcUsage(
        req("/api/v1/rpc/usage"),
        env,
        url("/api/v1/rpc/usage"),
      ),
    );
    assert.equal(body.data.summary.total_requests, 42);
    assert.equal(d1Called, false);
  });

  test("flag=postgres falls back to the empty payload when DATA_API fails", async () => {
    const env = {
      METAGRAPH_RPC_USAGE_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const body = await json(
      await handleRpcUsage(
        req("/api/v1/rpc/usage"),
        env,
        url("/api/v1/rpc/usage"),
      ),
    );
    assert.equal(body.data.source, "rpc-proxy");
    assert.equal(body.data.summary.total_requests, 0);
  });
});

describe("handleSurfaceVerify", () => {
  const verifyReq = (id, init = {}) =>
    req(`/api/v1/surfaces/${id}/verify`, {
      headers: { "cf-connecting-ip": "203.0.113.10" },
      ...init,
    });

  test("405 for non-GET/HEAD methods without probing", async () => {
    let fetched = false;
    let limited = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const env = createLocalArtifactEnv();
    env.RPC_RATE_LIMITER = {
      limit: async () => {
        limited = true;
        return { success: true };
      },
    };
    try {
      const res = await handleSurfaceVerify(
        verifyReq(SURFACE_ID, { method: "POST" }),
        env,
        SURFACE_ID,
      );
      const body = await errorJson(res, 405);
      assert.equal(body.error.code, "method_not_allowed");
      assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.equal(fetched, false);
      assert.equal(limited, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("404s for an unknown surface without probing", async () => {
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    try {
      const res = await handleSurfaceVerify(
        verifyReq("zzz-not-real"),
        createLocalArtifactEnv(),
        "zzz-not-real",
      );
      const body = await errorJson(res, 404);
      assert.equal(body.error.code, "surface_not_found");
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("503 when the operational-surface catalog is unavailable", async () => {
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleSurfaceVerify(
      verifyReq(SURFACE_ID),
      env,
      SURFACE_ID,
    );
    const body = await errorJson(res, 503);
    assert.equal(body.error.code, "surfaces_unavailable");
  });

  test("429 when the verify rate limiter rejects the client", async () => {
    const env = createLocalArtifactEnv();
    env.RPC_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const res = await handleSurfaceVerify(
      verifyReq(SURFACE_ID),
      env,
      SURFACE_ID,
    );
    const body = await errorJson(res, 429);
    assert.equal(body.error.code, "verify_rate_limited");
    assert.equal(res.headers.get("x-ratelimit-limit"), "100");
    assert.equal(res.headers.get("retry-after"), "60");
  });

  test("probes a catalogued surface and returns live-probe meta", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const res = await handleSurfaceVerify(
        verifyReq(SURFACE_ID),
        createLocalArtifactEnv(),
        SURFACE_ID,
        {},
      );
      const body = await json(res);
      assert.equal(body.data.surface_id, SURFACE_ID);
      assert.equal(typeof body.data.callable, "boolean");
      assert.equal(body.meta.source, "live-probe");
      assert.equal(body.meta.cache, "short");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("graphqlRateLimited", () => {
  test("returns null when the rate limiter binding is absent", async () => {
    const out = await graphqlRateLimited(
      req("/api/v1/graphql", { method: "POST" }),
      {},
    );
    assert.equal(out, null);
  });

  test("returns null when the client is under the limit", async () => {
    const out = await graphqlRateLimited(
      req("/api/v1/graphql", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
      }),
      { RPC_RATE_LIMITER: { limit: async () => ({ success: true }) } },
    );
    assert.equal(out, null);
  });

  test("returns a 429 response when the client is over the limit", async () => {
    const res = await graphqlRateLimited(
      req("/api/v1/graphql", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
      }),
      { RPC_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    );
    const body = await errorJson(res, 429);
    assert.equal(body.error.code, "graphql_rate_limited");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  });
});

describe("handleRpcProxyRequest", () => {
  const finneyUrl = url("/rpc/v1/finney");
  const rpcPost = (body, headers = {}) =>
    req("/rpc/v1/finney", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.20",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("405 for non-POST methods", async () => {
    const res = await handleRpcProxyRequest(
      req("/rpc/v1/finney", { method: "GET" }),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 405);
    assert.equal(body.error.code, "method_not_allowed");
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  });

  test("501 when the RPC proxy feature flag is off", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
      rpcEnv({ METAGRAPH_ENABLE_RPC_PROXY: "false" }),
      finneyUrl,
    );
    const body = await errorJson(res, 501);
    assert.equal(body.error.code, "rpc_proxy_disabled");
  });

  test("429 when the RPC rate limiter rejects the client", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
      rpcEnv({ RPC_RATE_LIMITER: { limit: async () => ({ success: false }) } }),
      finneyUrl,
    );
    const body = await errorJson(res, 429);
    assert.equal(body.error.code, "rpc_rate_limited");
  });

  test("400 rpc_invalid_json for a non-JSON body", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost("{not json"),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_json");
  });

  test("400 rpc_invalid_content_length for a negative Content-Length", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost(
        { jsonrpc: "2.0", id: 1, method: "system_health" },
        {
          "content-length": "-1",
        },
      ),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_content_length");
  });

  test("400 rpc_invalid_content_length for a non-numeric Content-Length", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost(
        { jsonrpc: "2.0", id: 1, method: "system_health" },
        {
          "content-length": "not-a-number",
        },
      ),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_invalid_content_length");
  });

  test("413 rpc_body_too_large when Content-Length exceeds the cap", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost(
        { jsonrpc: "2.0", id: 1, method: "system_health" },
        {
          "content-length": "70000",
        },
      ),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 413);
    assert.equal(body.error.code, "rpc_body_too_large");
  });

  test("passes a finite Content-Length within the cap before reading the body", async () => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "author_submitExtrinsic",
    };
    const res = await handleRpcProxyRequest(
      rpcPost(payload, {
        "content-length": String(
          new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        ),
      }),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 403);
    assert.equal(body.error.code, "rpc_method_blocked");
  });

  test("403 rpc_method_blocked for a denied method", async () => {
    const res = await handleRpcProxyRequest(
      rpcPost({ jsonrpc: "2.0", id: 1, method: "author_submitExtrinsic" }),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 403);
    assert.equal(body.error.code, "rpc_method_blocked");
    assert.ok(Array.isArray(body.meta.allowed_methods));
  });

  test("400 rpc_websocket_unsupported for the /wss route", async () => {
    const wssUrl = url("/rpc/v1/finney/wss");
    const res = await handleRpcProxyRequest(
      rpcPost({ jsonrpc: "2.0", id: 1, method: "system_health" }),
      rpcEnv(),
      wssUrl,
    );
    const body = await errorJson(res, 400);
    assert.equal(body.error.code, "rpc_websocket_unsupported");
  });
});

describe("configureRpcProxy wiring", () => {
  test("handleRpcUsage reads observed_at from the injected health-meta KV reader", async () => {
    const customObserved = "2026-01-15T08:30:00.000Z";
    configureRpcProxy({
      readHealthMetaKv: async () => ({ last_run_at: customObserved }),
    });
    const body = await json(
      await handleRpcUsage(
        req("/api/v1/rpc/usage"),
        {},
        url("/api/v1/rpc/usage"),
      ),
    );
    assert.equal(body.data.observed_at, customObserved);
  });
});

describe("exported handler smoke", () => {
  test("all direct-import handlers are callable functions", () => {
    assert.equal(typeof handleRpcUsage, "function");
    assert.equal(typeof handleSurfaceVerify, "function");
    assert.equal(typeof handleRpcProxyRequest, "function");
    assert.equal(typeof graphqlRateLimited, "function");
    assert.equal(typeof configureRpcProxy, "function");
  });
});
