// Direct unit tests for workers/request-handlers/rpc-proxy.ts (#1977).
// Exercises RPC usage analytics, surface verify, GraphQL rate limiting, and
// proxy guard rails without routing through workers/api.ts.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";
import {
  configureRpcProxy,
  graphqlRateLimited,
  handleRpcProxyRequest,
  handleRpcUsage,
  handleSurfaceVerify,
} from "../workers/request-handlers/rpc-proxy.ts";
import { MAX_RPC_BODY_BYTES } from "../workers/config.ts";

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

function req(path: string, init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res: Response, status = 200) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = (await res.json()) as Row;
  if (status < 400) assert.equal(body.ok, true);
  return body;
}

async function errorJson(res: Response, status: number) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, false);
  return body;
}

function rpcEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request: Request) {
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
  } as unknown as Env;
}

beforeEach(() => {
  configureRpcProxy({
    readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
  });
});

// #9228: an env carrying the AE read token, so the hot tier is reachable at
// all. Without it loadRpcUsageHotTier declines before issuing a query --
// which is itself the shipping default and is covered below.
const AE_ENV = { ANALYTICS_ENGINE_SQL_TOKEN: "test-token" };

// A fetch double answering the AE SQL API with one canned result set per
// query, in the order loadRpcUsageHotTier issues them (totals, endpoints,
// networks, buckets). The SQL those queries contain is asserted in
// tests/rpc-usage-hot-tier.test.ts -- this file only wires the tier ordering,
// so it goes through the real client rather than the injectable query seam.
function aeFetch(resultSets: Row[][]) {
  let index = 0;
  return (async () => {
    const data = resultSets[index] ?? [];
    index += 1;
    return Response.json({ meta: [], data, rows: data.length });
  }) as unknown as typeof fetch;
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("handleRpcUsage", () => {
  // D1 fully eliminated (2026-07-17): loadRpcUsage never queries
  // rpc_proxy_events any more, so a Postgres-tier miss always returns the
  // schema-stable empty payload -- this is now the only cold-path shape.
  test("returns a schema-stable zeroed payload on a Postgres-tier miss", async () => {
    const body = await json(
      await handleRpcUsage(
        req("/api/v1/rpc/usage"),
        mockEnv(),
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
      mockEnv(),
      url("/api/v1/rpc/usage?cacheBust=x"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.meta.parameter, "cacheBust");
  });

  test("rejects unknown window values", async () => {
    const res = await handleRpcUsage(
      req("/api/v1/rpc/usage?window=90d"),
      mockEnv(),
      url("/api/v1/rpc/usage?window=90d"),
    );
    const body = await errorJson(res, 400);
    assert.equal(body.meta.parameter, "window");
  });

  // #9228: the Analytics Engine hot tier is queried FIRST -- once capture is
  // running it is the only tier that can answer with today's traffic, and the
  // tiers below it are a dead Postgres mirror and a frozen lakehouse.
  test("the AE hot tier answers ahead of the Postgres tier", async () => {
    let dataApiCalled = false;
    const env = {
      ...AE_ENV,
      METAGRAPH_RPC_USAGE_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          dataApiCalled = true;
          return Response.json({ summary: { total_requests: 42 } });
        },
      },
    };
    const body = await withFetch(
      aeFetch([
        [{ total: 7, ok_count: 6, p50: 40, p95: 90, observed_at_s: 1_700_000 }],
        [
          {
            endpoint_id: "",
            provider: "",
            network: "finney",
            requests: 7,
            ok_count: 6,
          },
        ],
        [{ network: "finney", requests: 7, ok_count: 6 }],
        [{ ts: 1_700_000, requests: 7, ok_count: 6 }],
      ]),
      async () =>
        json(
          await handleRpcUsage(
            req("/api/v1/rpc/usage"),
            env as unknown as Env,
            url("/api/v1/rpc/usage"),
          ),
        ),
    );
    assert.equal(body.data.summary.total_requests, 7);
    // The one deliberate tier difference, visible end to end: AE has weighted
    // quantiles so these are measured, where the lakehouse tier reports null.
    assert.equal(body.data.summary.latency_ms.p50, 40);
    assert.equal(body.data.summary.latency_ms.p95, 90);
    // The "" sentinel is mapped back to the lakehouse tier's NULL group, so
    // the two tiers serve the same endpoint shape.
    assert.equal(body.data.endpoints[0].endpoint_id, null);
    assert.equal(dataApiCalled, false);
  });

  test("an empty AE window falls through to the tier below", async () => {
    const env = {
      ...AE_ENV,
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
    };
    const body = await withFetch(
      aeFetch([[{ total: null }], [], [], []]),
      async () =>
        json(
          await handleRpcUsage(
            req("/api/v1/rpc/usage"),
            env as unknown as Env,
            url("/api/v1/rpc/usage"),
          ),
        ),
    );
    assert.equal(body.data.summary.total_requests, 42);
  });

  test("no AE read token means the route behaves exactly as it does today", async () => {
    // The shipping default: capture starts on deploy, the read token is
    // provisioned separately, and until it exists this route must not change
    // its answer OR reach for a credential it does not have.
    let aeCalled = false;
    const body = await withFetch(
      (async () => {
        aeCalled = true;
        return Response.json({ data: [] });
      }) as unknown as typeof fetch,
      async () =>
        json(
          await handleRpcUsage(
            req("/api/v1/rpc/usage"),
            mockEnv(),
            url("/api/v1/rpc/usage"),
          ),
        ),
    );
    assert.equal(aeCalled, false);
    assert.equal(body.data.summary.total_requests, 0);
    assert.equal(body.data.observed_at, OBSERVED_AT);
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
        env as unknown as Env,
        url("/api/v1/rpc/usage"),
      ),
    );
    assert.equal(body.data.source, "rpc-proxy");
    assert.equal(body.data.summary.total_requests, 0);
  });
});

describe("handleSurfaceVerify", () => {
  const verifyReq = (id: string, init: RequestInit = {}) =>
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
        env as unknown as Env,
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
        createLocalArtifactEnv() as unknown as Env,
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
      env as unknown as Env,
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
      env as unknown as Env,
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
        createLocalArtifactEnv() as unknown as Env,
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
      mockEnv(),
    );
    assert.equal(out, null);
  });

  test("returns null when the client is under the limit", async () => {
    const out = await graphqlRateLimited(
      req("/api/v1/graphql", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
      }),
      {
        RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
      } as unknown as Env,
    );
    assert.equal(out, null);
  });

  test("returns a 429 response when the client is over the limit", async () => {
    const res = await graphqlRateLimited(
      req("/api/v1/graphql", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
      }),
      {
        RPC_RATE_LIMITER: { limit: async () => ({ success: false }) },
      } as unknown as Env,
    );
    const body = await errorJson(res!, 429);
    assert.equal(body.error.code, "graphql_rate_limited");
    assert.equal(res!.headers.get("x-ratelimit-remaining"), "0");
  });
});

describe("handleRpcProxyRequest", () => {
  const finneyUrl = url("/rpc/v1/finney");
  const rpcPost = (body: unknown, headers: Record<string, string> = {}) =>
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

  // Null-body POST (request.body === null) must take the same empty-body
  // path as request.text() historically did — JSON.parse("") → invalid_json.
  test("400 rpc_invalid_json when the request body stream is null", async () => {
    const request = new Request("https://api.metagraph.sh/rpc/v1/finney", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.21",
      },
    });
    assert.equal(request.body, null);
    const res = await handleRpcProxyRequest(request, rpcEnv(), finneyUrl);
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

  test("413 rpc_body_too_large on Content-Length over the cap without reading any body bytes", async () => {
    const stream = new ReadableStream({
      pull() {
        throw new Error("body must not be read on Content-Length fast path");
      },
    });
    const res = await handleRpcProxyRequest(
      new Request("https://api.metagraph.sh/rpc/v1/finney", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.20",
          "content-length": String(MAX_RPC_BODY_BYTES + 1),
        },
        body: stream,
        duplex: "half",
      } as unknown as RequestInit),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 413);
    assert.equal(body.error.code, "rpc_body_too_large");
  });

  // #8810: without Content-Length the old await request.text() buffered the
  // whole body (and a second TextEncoder copy) before 413ing — or OOMed.
  // This infinite stream has no Content-Length (undici never auto-sets one
  // for a stream body); it must fail on main (buffers forever / past the
  // cap into memory) and pass after: cancel shortly after crossing the cap.
  test("413 rpc_body_too_large aborts mid-stream when Content-Length is absent (regression #8810)", async () => {
    const CHUNK_BYTES = 8 * 1024;
    let bytesProduced = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (cancelled) return;
        bytesProduced += CHUNK_BYTES;
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await handleRpcProxyRequest(
      new Request("https://api.metagraph.sh/rpc/v1/finney", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.20",
        },
        body: stream,
        duplex: "half",
      } as unknown as RequestInit),
      rpcEnv(),
      finneyUrl,
    );
    const body = await errorJson(res, 413);
    assert.equal(body.error.code, "rpc_body_too_large");
    assert.equal(cancelled, true);
    assert.ok(
      bytesProduced < MAX_RPC_BODY_BYTES + CHUNK_BYTES * 4,
      `expected early cancel shortly after the cap, but ${bytesProduced} bytes were produced`,
    );
  });

  test("a body just under the cap is forwarded upstream byte-identical", async () => {
    // Pad params so the UTF-8 body sits just under MAX_RPC_BODY_BYTES.
    const pad = "x".repeat(MAX_RPC_BODY_BYTES - 120);
    const bodyText = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system_health",
      params: [pad],
    });
    assert.ok(new TextEncoder().encode(bodyText).length <= MAX_RPC_BODY_BYTES);
    assert.ok(
      new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES - 200,
    );

    let upstreamBody: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      upstreamBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const res = await handleRpcProxyRequest(
        new Request("https://api.metagraph.sh/rpc/v1/finney", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.20",
          },
          body: bodyText,
        }),
        rpcEnv(),
        finneyUrl,
      );
      assert.equal(res.status, 200);
      assert.equal(upstreamBody, bodyText);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
        mockEnv(),
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
