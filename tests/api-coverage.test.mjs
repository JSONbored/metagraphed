import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  handleRequest,
  handleScheduled,
  proxyWithFailover,
  weightedPickEndpoint,
} from "../workers/api.mjs";
import workerDefault from "../workers/api.mjs";

const req = (path, init) =>
  new Request(`https://api.metagraph.sh${path}`, init);

// In-memory KV mock matching the Workers KV surface the worker uses.
function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === "json" ? value : JSON.stringify(value);
    },
    async put(key, value) {
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

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

// RPC-proxy env that serves the pool artifact through ASSETS + R2.
function rpcEnv(overrides = {}) {
  return {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/metagraph/rpc/pools.json") {
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

function withGlobals({ cache, fetchImpl }, run) {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  if (cache !== undefined) globalThis.caches = { default: cache };
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  return Promise.resolve(run()).finally(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });
}

const rpcReq = (method, params = [], id = 1) =>
  req("/rpc/v1/finney", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

// --- top-level routing edges --------------------------------------------------
describe("handleRequest routing edges", () => {
  test("rejects POST to a GET-only route with 405 method_not_allowed", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets", { method: "POST" }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error.code, "method_not_allowed");
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  });

  test("OPTIONS preflight on an api route returns 204", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets", { method: "OPTIONS" }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
  });

  test("OPTIONS preflight on an rpc route advertises POST", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", { method: "OPTIONS" }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
  });

  test("falls through to ASSETS for a non-api path", async () => {
    let assetCalled = false;
    const env = {
      ASSETS: {
        async fetch() {
          assetCalled = true;
          return new Response("ok", { status: 200 });
        },
      },
    };
    const res = await handleRequest(req("/index.html"), env, {});
    assert.equal(res.status, 200);
    assert.equal(assetCalled, true);
  });

  test("returns 404 not_found when no ASSETS binding is configured", async () => {
    const res = await handleRequest(req("/index.html"), {}, {});
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });
});

// --- slug → netuid resolution -------------------------------------------------
describe("subnet slug resolution", () => {
  test("resolves a known slug to its netuid route", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/allways"),
      createLocalArtifactEnv(),
      {},
    );
    // allways → netuid 7; should resolve to the subnet detail payload.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("404 subnet_not_found for an unknown slug", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/this-slug-does-not-exist"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });

  test("404 subnet_not_found for a malformed (undecodable) slug", async () => {
    // "%E0%A4%A" is an invalid percent-encoding → decodeURIComponent throws
    // URIError → decodeSlugPathSegment returns null → not_found.
    const res = await handleRequest(
      req("/api/v1/subnets/%E0%A4%A"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });

  test("returns not_found when the slug index cannot be loaded (no prior copy)", async () => {
    // No ASSETS and no R2 → subnets.json cannot be read; lookupSubnetNetuid
    // returns null on the cold-start path. Use a slug guaranteed not numeric.
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleRequest(req("/api/v1/subnets/somename"), env, {});
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });
});

// --- health readiness ---------------------------------------------------------
describe("/health readiness", () => {
  test("405 on a non-GET/HEAD method", async () => {
    const res = await handleRequest(
      req("/health", { method: "POST" }),
      createLocalArtifactEnv(),
      {},
    );
    // POST is not in [GET, HEAD], so the top-level gate returns 405 before
    // reaching handleHealthRequest. PUT also routes the same way.
    assert.equal(res.status, 405);
  });

  test("reports degraded + 503 when the KV latest pointer is stale", async () => {
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "metagraph:latest": { published_at: stale },
        "health:meta": {
          last_run_at: new Date().toISOString(),
          probed_count: 5,
          status_counts: { ok: 5 },
        },
      }),
    });
    const res = await handleRequest(req("/health"), env, {});
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("x-metagraph-health"), "degraded");
    const body = await res.json();
    assert.equal(body.status, "degraded");
    assert.equal(body.freshness.stale, true);
    assert.equal(body.operational_health.probed_count, 5);
  });

  test("reports ok + 200 with a fresh pointer", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "metagraph:latest": { published_at: new Date().toISOString() },
      }),
    });
    const res = await handleRequest(req("/health"), env, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });

  test("HEAD /health returns no body", async () => {
    const res = await handleRequest(
      req("/health", { method: "HEAD" }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});

// --- raw artifact route -------------------------------------------------------
describe("raw artifact route", () => {
  test("serves a raw artifact with source + storage-tier headers", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/metagraph/subnets.json"), env, {});
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-metagraph-artifact-source"));
    assert.ok(res.headers.get("x-metagraph-storage-tier"));
    assert.ok(res.headers.get("etag"));
  });

  test("304 on a matching if-none-match", async () => {
    const env = createLocalArtifactEnv();
    const first = await handleRequest(req("/metagraph/subnets.json"), env, {});
    const etag = first.headers.get("etag");
    const res = await handleRequest(
      req("/metagraph/subnets.json", { headers: { "if-none-match": etag } }),
      env,
      {},
    );
    assert.equal(res.status, 304);
  });

  test("404 for a /metagraph/*.json path with no matching contract", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/metagraph/not-a-real-artifact.json"),
      env,
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });

  test("propagates the artifact read error when the contract matches but data is missing", async () => {
    // subnets.json matches a raw-artifact contract; remove both backends so the
    // read fails and the error is surfaced through the raw route.
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleRequest(req("/metagraph/subnets.json"), env, {});
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.meta.artifact_path, "/metagraph/subnets.json");
  });
});

// --- badge SVG ----------------------------------------------------------------
describe("badge SVG handler", () => {
  test("405 when posting to a badge", async () => {
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg", { method: "POST" }),
      createLocalArtifactEnv(),
      {},
    );
    // POST is not GET/HEAD → top-level gate 405.
    assert.equal(res.status, 405);
  });

  test("renders the static badge artifact when no live overlay", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    const svg = await res.text();
    assert.match(svg, /<svg/);
  });

  test("304 on a matching if-none-match for a badge", async () => {
    const env = createLocalArtifactEnv();
    const first = await handleRequest(
      req("/metagraph/health/badges/7.svg"),
      env,
      {},
    );
    const etag = first.headers.get("etag");
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg", {
        headers: { "if-none-match": etag },
      }),
      env,
      {},
    );
    assert.equal(res.status, 304);
  });

  test("prefers the live KV overlay status when present", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "health:current": { subnets: [{ netuid: 7, status: "degraded" }] },
      }),
    });
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /degraded/);
    // SN7 label rendered from the live overlay branch.
    assert.match(svg, /SN7/);
  });

  test("renders a graceful 'unavailable' badge when nothing is available", async () => {
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleRequest(
      req("/metagraph/health/badges/999.svg"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /unavailable/);
    // Graceful fallback uses the short cache profile.
    assert.match(res.headers.get("cache-control"), /max-age=/);
  });

  test("HEAD on a badge returns no body", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg", { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});

// --- live health overlay branches --------------------------------------------
describe("live health overlay (rpc-endpoints + freshness)", () => {
  test("/api/v1/rpc/endpoints overlays the live KV rpc pool", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "health:rpc-pool": {
          last_run_at: "2026-06-11T00:00:00.000Z",
          generated_at: "2026-06-11T00:00:00.000Z",
          endpoints: [{ id: "any", status: "ok" }],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/rpc/endpoints"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
  });

  test("/api/v1/freshness overlays the live KV meta", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "health:meta": { last_run_at: "2026-06-11T00:00:00.000Z" },
      }),
    });
    const res = await handleRequest(req("/api/v1/freshness"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
  });

  test("/api/v1/health with KV bound but cold serves unknown, not static", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({}),
    });
    const res = await handleRequest(req("/api/v1/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "unavailable");
    assert.equal(body.data.global.status_counts.unknown, 0);
  });

  test("retired raw current-health artifacts return 410 before stale R2 reads", async () => {
    let reads = 0;
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get() {
          reads += 1;
          return {
            async json() {
              return { stale: true };
            },
          };
        },
      },
    });
    for (const path of [
      "/metagraph/health/latest.json",
      "/metagraph/health/summary.json",
      "/metagraph/health/subnets/7.json",
    ]) {
      const res = await handleRequest(req(path), env, {});
      assert.equal(res.status, 410);
      assert.equal((await res.json()).error.code, "retired_artifact");
    }
    assert.equal(reads, 0);
  });

  test("/api/v1/subnets/:netuid/health ignores stale static R2 objects", async () => {
    let reads = 0;
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get() {
          reads += 1;
          return {
            async json() {
              return {
                netuid: 7,
                summary: { status: "ok" },
                surfaces: [{ surface_id: "stale", status: "ok" }],
              };
            },
          };
        },
      },
      METAGRAPH_CONTROL: makeKv({}),
    });
    const res = await handleRequest(req("/api/v1/subnets/7/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.summary.status, "unknown");
    assert.deepEqual(body.data.surfaces, []);
    assert.equal(reads, 0);
  });

  test("readHealthKv swallows a throwing KV get (serves static)", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("kv blew up");
        },
      },
    });
    const res = await handleRequest(req("/api/v1/freshness"), env, {});
    // Live overlay returns null on the KV throw → static artifact served.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.meta.source, "live-cron-prober");
  });
});

// --- invalid query ------------------------------------------------------------
describe("invalid query handling", () => {
  test("400 invalid_query for an unsupported sort field", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?sort=not_a_field"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "sort");
  });

  test("400 invalid_query for a bad order value", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?order=sideways"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).meta.parameter, "order");
  });

  test("paginates with cursor + limit and reports next_cursor", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?limit=2&cursor=0&sort=netuid"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets.length, 2);
    assert.equal(body.meta.pagination.limit, 2);
    assert.equal(body.meta.pagination.cursor, 0);
  });

  test("?domain= filters subnets by derived/curated domain tag (#345)", async () => {
    const env = createLocalArtifactEnv();
    const all = await (
      await handleRequest(req("/api/v1/subnets?limit=200"), env, {})
    ).json();
    const expected = all.data.subnets.filter(
      (s) =>
        (s.derived_categories || []).includes("inference") ||
        (s.categories || []).includes("inference"),
    );
    assert.ok(expected.length > 0, "fixture should have inference subnets");

    const res = await handleRequest(
      req("/api/v1/subnets?domain=inference&limit=200"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets.length, expected.length);
    assert.equal(body.meta.pagination.total, expected.length);
    assert.ok(
      body.data.subnets.every(
        (s) =>
          (s.derived_categories || []).includes("inference") ||
          (s.categories || []).includes("inference"),
      ),
    );
  });

  test("400 invalid_query for an unknown ?domain= value (#345)", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?domain=not_a_domain"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "domain");
  });

  test("sorts by a string field (name) descending", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?sort=name&order=desc&limit=3"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const names = (await res.json()).data.subnets.map((s) => String(s.name));
    const sorted = [...names].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(names, sorted);
  });
});

// --- 304 on api envelope ------------------------------------------------------
describe("api envelope 304", () => {
  test("304 when if-none-match matches the api etag", async () => {
    const env = createLocalArtifactEnv();
    const first = await handleRequest(req("/api/v1/subnets"), env, {});
    const etag = first.headers.get("etag");
    const res = await handleRequest(
      req("/api/v1/subnets", { headers: { "if-none-match": etag } }),
      env,
      {},
    );
    assert.equal(res.status, 304);
  });

  test("HEAD on an api route returns no body", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/api/v1/subnets", { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});

// --- RPC proxy edges ----------------------------------------------------------
describe("RPC proxy edges", () => {
  test("405 for a non-POST RPC request", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", { method: "GET" }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error.code, "method_not_allowed");
  });

  test("501 when the RPC proxy is disabled", async () => {
    const res = await handleRequest(
      rpcReq("system_health"),
      rpcEnv({ METAGRAPH_ENABLE_RPC_PROXY: "false" }),
      {},
    );
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, "rpc_proxy_disabled");
  });

  test("413 when content-length exceeds the body limit", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", {
        method: "POST",
        headers: { "content-length": String(70000) },
        body: JSON.stringify({ jsonrpc: "2.0", method: "system_health" }),
      }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "rpc_body_too_large");
  });

  test("413 when the decoded body byte length exceeds the limit", async () => {
    // content-length header omitted/0, but the actual body is oversized.
    const big = "x".repeat(70000);
    const res = await handleRequest(
      req("/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "system_health", big }),
      }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "rpc_body_too_large");
  });

  test("400 rpc_invalid_json for a non-JSON body", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", { method: "POST", body: "{not json" }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "rpc_invalid_json");
  });

  test("400 rpc_invalid_request for an array body", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify([{ method: "system_health" }]),
      }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "rpc_invalid_request");
  });

  test("403 rpc_method_blocked for a denied method", async () => {
    const res = await handleRequest(
      rpcReq("author_submitExtrinsic"),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "rpc_method_blocked");
  });

  test("400 rpc_websocket_unsupported for the /wss route", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney/wss", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "system_health",
        }),
      }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "rpc_websocket_unsupported");
  });

  test("503 rpc_endpoint_unavailable when the pool has no eligible endpoints", async () => {
    const emptyPool = { pools: [{ id: "finney-rpc", endpoints: [] }] };
    const env = {
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/metagraph/rpc/pools.json") {
            return Response.json(emptyPool);
          }
          return new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return emptyPool;
            },
          };
        },
      },
    };
    const res = await handleRequest(rpcReq("system_health"), env, {});
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "rpc_endpoint_unavailable");
  });

  test("502 rpc_endpoint_unsafe when the only eligible endpoint URL is unsafe", async () => {
    const unsafePool = {
      pools: [
        {
          id: "finney-rpc",
          endpoints: [
            {
              id: "evil",
              provider: "evil",
              pool_eligible: true,
              status: "ok",
              url: "https://evil.example.com/rpc",
            },
          ],
        },
      ],
    };
    const env = {
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/metagraph/rpc/pools.json") {
            return Response.json(unsafePool);
          }
          return new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return unsafePool;
            },
          };
        },
      },
    };
    const res = await handleRequest(rpcReq("system_health"), env, {});
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "rpc_endpoint_unsafe");
  });

  test("propagates a pool-artifact read failure", async () => {
    const env = {
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
    };
    const res = await handleRequest(rpcReq("system_health"), env, {});
    // pools.json is r2-tier; with no R2 binding the read fails.
    assert.notEqual(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.artifact_path, "/metagraph/rpc/pools.json");
  });

  test("rate-limited with a limiter that allows passes through", async () => {
    const env = rpcEnv({
      RPC_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
    });
    await withGlobals(
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { peers: 1 } }),
            { status: 200 },
          ),
      },
      async () => {
        const res = await handleRequest(rpcReq("system_health"), env, {});
        assert.equal(res.status, 200);
      },
    );
  });

  test("cache miss with a non-200 upstream returns the status + miss header", async () => {
    const cache = {
      async match() {
        return undefined;
      },
      async put() {},
    };
    await withGlobals(
      {
        cache,
        fetchImpl: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: 1 } }), {
            status: 400,
          }),
      },
      async () => {
        // chain_getBlockHash with a numeric arg is cacheable, so cacheKey is set;
        // an upstream 400 is fatal and short-circuits at the status!==200 branch.
        const res = await handleRequest(
          rpcReq("chain_getBlockHash", [5]),
          rpcEnv(),
          {},
        );
        assert.equal(res.status, 400);
        assert.equal(res.headers.get("x-metagraph-rpc-cache"), "miss");
      },
    );
  });

  test("malformed cached entry is treated as a miss and re-fetched", async () => {
    const store = new Map();
    const cache = {
      async match(r) {
        const hit = store.get(r.url);
        return hit ? hit.clone() : undefined;
      },
      async put(r, resp) {
        store.set(r.url, resp);
      },
    };
    let fetchCount = 0;
    await withGlobals(
      {
        cache,
        fetchImpl: async () => {
          fetchCount += 1;
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }),
            { status: 200 },
          );
        },
      },
      async () => {
        // Seed a garbage cache entry by intercepting the first match() call so
        // the malformed-hit branch (JSON.parse throw → treated as a miss) runs.
        let firstMatch = true;
        cache.match = async () => {
          if (firstMatch) {
            firstMatch = false;
            return new Response("not json at all");
          }
          return undefined;
        };
        const waits = [];
        const ctx = { waitUntil: (p) => waits.push(p) };
        const res = await handleRequest(
          rpcReq("chain_getBlockHash", [9]),
          rpcEnv(),
          ctx,
        );
        await Promise.all(waits);
        assert.equal(res.status, 200);
        // Malformed hit was discarded → upstream fetched.
        assert.equal(fetchCount, 1);
        assert.equal(res.headers.get("x-metagraph-rpc-cache"), "miss");
      },
    );
  });
});

// --- proxyWithFailover tee() inspection branch -------------------------------
describe("proxyWithFailover tee inspection", () => {
  const SAFE_A = "https://bittensor-finney.api.onfinality.io/public";
  const SAFE_B = "https://bittensor-public.nodies.app/rpc";
  const ep = (id, url) => ({
    id,
    url,
    provider: "fixture",
    pool_eligible: true,
    score: 100,
    status: "ok",
  });

  test("a 2xx upstream whose body is a node-internal error fails over via tee()", async () => {
    // A streaming body that yields a transient JSON-RPC error; because it has a
    // real .body.tee(), the inspect-and-classify tee branch runs and classifies
    // it transient (-32603) → fail over to the next endpoint.
    const healthMap = new Map();
    let calls = 0;
    const fetchFn = async (url) => {
      calls += 1;
      if (url === SAFE_A) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "internal" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const res = await proxyWithFailover([ep("a", SAFE_A), ep("b", SAFE_B)], {
      bodyText: "{}",
      poolId: "finney-rpc",
      fetchFn,
      healthMap,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "b");
    assert.equal(calls, 2);
    assert.equal(healthMap.get("a").fails, 1);
  });

  test("a successful 2xx upstream with a real tee()-able body streams through", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { peers: 3 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const res = await proxyWithFailover([ep("a", SAFE_A)], {
      bodyText: "{}",
      poolId: "finney-rpc",
      fetchFn,
      healthMap: new Map(),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.peers, 3);
  });
});

// --- R2 timeout → static fallback --------------------------------------------
describe("R2 timeout and static fallback", () => {
  test("falls back to static assets when R2 times out and fallback is enabled", async () => {
    let assetHit = false;
    const env = {
      METAGRAPH_ALLOW_R2_STATIC_FALLBACK: "true",
      METAGRAPH_R2_TIMEOUT_MS: "10",
      METAGRAPH_DISABLE_REQUEST_LOGS: "true",
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/metagraph/rpc-endpoints.json") {
            assetHit = true;
            return Response.json({
              schema_version: 1,
              endpoints: [],
            });
          }
          return new Response("nope", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          // Never resolve → triggers the withTimeout race rejection.
          return new Promise(() => {});
        },
      },
    };
    const res = await handleRequest(req("/api/v1/rpc/endpoints"), env, {});
    assert.equal(res.status, 200);
    assert.equal(assetHit, true);
    assert.equal(res.headers.get("x-metagraph-cache-profile") !== null, true);
  });

  test("returns 504 r2_timeout when fallback is disabled", async () => {
    const env = {
      METAGRAPH_R2_TIMEOUT_MS: "10",
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return new Promise(() => {});
        },
      },
    };
    const res = await handleRequest(req("/api/v1/rpc/endpoints"), env, {});
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "r2_timeout");
  });
});

// --- handleHealthTrends D1 throw ---------------------------------------------
describe("health trends D1 error handling", () => {
  test("returns a schema-stable empty payload when D1 throws", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  throw new Error("d1 down");
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(
      req("/api/v1/subnets/0/health/trends"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 0);
    assert.equal(body.data.windows["7d"].uptime_ratio, null);
  });

  test("bulk route returns a schema-stable empty payload when D1 throws", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  throw new Error("d1 down");
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(req("/api/v1/health/trends"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.windows["7d"].subnet_count, 0);
    assert.deepEqual(body.data.windows["7d"].subnets, []);
  });

  test("bulk route treats a D1 response without results as empty", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return {};
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(req("/api/v1/health/trends"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.windows["7d"].subnet_count, 0);
    assert.deepEqual(body.data.windows["30d"].subnets, []);
  });
});

// --- readAsset with no ASSETS binding ----------------------------------------
describe("readAsset missing binding", () => {
  test("dual-tier read falls back to R2 when ASSETS is unbound", async () => {
    // subnets.json is dual-tier: readAsset returns asset_binding_missing (404),
    // then readR2 serves it.
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: createLocalArtifactEnv().METAGRAPH_ARCHIVE,
    };
    const res = await handleRequest(req("/api/v1/subnets"), env, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-cache-profile") !== null, true);
  });
});

// --- weightedPickEndpoint fallthrough ----------------------------------------
describe("weightedPickEndpoint", () => {
  test("returns the last endpoint when the cursor never goes negative", () => {
    // randomFn returns ~1 so cursor = total; subtracting each weight never goes
    // below zero until the loop ends → fallthrough returns the last endpoint.
    const endpoints = [
      { id: "a", score: 1 },
      { id: "b", score: 1 },
    ];
    const picked = weightedPickEndpoint(endpoints, () => 0.999999999);
    assert.equal(picked.id, "b");
  });

  test("single-endpoint shortcut", () => {
    assert.equal(weightedPickEndpoint([{ id: "solo" }]).id, "solo");
  });
});

// --- scheduled handler --------------------------------------------------------
describe("handleScheduled", () => {
  test("the hourly prune cron prunes the time-series", async () => {
    // No D1 binding → pruneHealthHistory is a no-op but the branch is taken.
    const result = await handleScheduled({ cron: "0 * * * *" }, {}, {});
    assert.ok(result === undefined || typeof result === "object");
  });

  test("any other cron runs the health prober", async () => {
    // No bindings → runHealthProber should not throw with an empty env.
    const result = await handleScheduled(
      { cron: "*/2 * * * *" },
      {},
      { waitUntil() {} },
    );
    assert.ok(result === undefined || typeof result === "object");
  });

  test("the default export wires fetch + scheduled", async () => {
    const res = await workerDefault.fetch(
      req("/api/v1/subnets"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    await workerDefault.scheduled({ cron: "0 * * * *" }, {}, {});
  });
});

// --- logEvent disabled --------------------------------------------------------
describe("logEvent", () => {
  test("R2 timeout with logs disabled still produces a 504 (no log spam)", async () => {
    const env = {
      METAGRAPH_DISABLE_REQUEST_LOGS: "true",
      METAGRAPH_R2_TIMEOUT_MS: "10",
      ASSETS: {
        async fetch() {
          return new Response("nope", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return new Promise(() => {});
        },
      },
    };
    const res = await handleRequest(req("/api/v1/rpc/endpoints"), env, {});
    assert.equal(res.status, 504);
  });
});

// --- overlay edge-cache (cacheable overlay route) -----------------------------
describe("overlay edge-cache", () => {
  test("serves an overlay cache hit and honors if-none-match (304)", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: makeKv({
        "health:meta": { last_run_at: "2026-06-15T00:00:00.000Z" },
      }),
    };
    const etag = '"overlay-test-etag"';
    const cachedBody = JSON.stringify({ ok: true, data: { endpoints: [] } });
    const cache = {
      async match() {
        return new Response(cachedBody, {
          status: 200,
          headers: { etag, "content-type": "application/json" },
        });
      },
      async put() {},
    };
    await withGlobals({ cache }, async () => {
      // (a) no if-none-match → the cached overlay response is returned as-is.
      const hit = await handleRequest(req("/api/v1/endpoints"), env, {});
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get("etag"), etag);
      // (b) matching if-none-match → 304 Not Modified.
      const notModified = await handleRequest(
        req("/api/v1/endpoints", { headers: { "if-none-match": etag } }),
        env,
        {},
      );
      assert.equal(notModified.status, 304);
    });
  });
});

// --- HEAD probe on an AI route -------------------------------------------------
describe("semantic-search HEAD probe", () => {
  test("HEAD returns a headers-only 200 without running inference", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_ENABLE_AI: "true",
      AI: { run: async () => ({}) },
      VECTORIZE: { query: async () => ({ matches: [] }) },
    };
    const res = await handleRequest(
      req("/api/v1/search/semantic?q=x", { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "");
  });
});
