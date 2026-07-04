import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  handleRequest,
  handleScheduled,
  proxyWithFailover,
  weightedPickEndpoint,
} from "../workers/api.mjs";
import workerDefault from "../workers/api.mjs";
import { EXPOSED_RESPONSE_HEADERS_VALUE } from "../workers/http.mjs";
import { API_ROUTES, compileRoutePattern } from "../src/contracts.mjs";
import * as workerConfig from "../workers/config.mjs";

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

const COVERAGE_DEPTH_ARTIFACT = {
  schema_version: 1,
  generated_at: "1970-01-01T00:00:00.000Z",
  coverage_depth_version: 1,
  rows: [
    {
      netuid: 7,
      slug: "allways",
      name: 'Allways, "callable"',
      tier: "agent-ready",
      score: 77,
      priority_score: 86,
      agent_status: "callable",
      blocker_level: "none",
      top_gap_codes: ["missing-fixture"],
      recommended_next_action: "capture a sanitized fixture",
    },
    {
      netuid: 31,
      slug: "recall",
      name: "Recall",
      tier: "missing-interface",
      score: 18,
      priority_score: 67,
      agent_status: "blocked",
      blocker_level: "missing-data",
      top_gap_codes: ["missing-callable-service"],
      recommended_next_action: "find an official callable surface",
    },
  ],
  ranked_queue: [
    {
      rank: 1,
      netuid: 31,
      tier: "missing-interface",
      score: 18,
      priority_score: 67,
      severity: "missing-data",
      top_gap_codes: ["missing-callable-service"],
      recommended_next_action: "find an official callable surface",
    },
    {
      rank: 2,
      netuid: 7,
      tier: "agent-ready",
      score: 77,
      priority_score: 86,
      severity: "missing-data",
      top_gap_codes: ["missing-fixture"],
      recommended_next_action: "capture a sanitized fixture",
    },
  ],
};

function withCoverageDepthArchive(overrides = {}) {
  const env = createLocalArtifactEnv(overrides);
  const originalGet = env.METAGRAPH_ARCHIVE.get;
  env.METAGRAPH_ARCHIVE.get = async (key) => {
    const normalized = String(key).replace(/^latest\//, "");
    if (normalized === "coverage-depth.json") {
      const text = JSON.stringify(COVERAGE_DEPTH_ARTIFACT);
      return {
        async json() {
          return JSON.parse(text);
        },
        async text() {
          return text;
        },
      };
    }
    return originalGet(key);
  };
  return env;
}

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

const SYNTHETIC_ENDPOINT_ROWS = Array.from({ length: 260 }, (_, index) => ({
  id: `ep-${index}`,
  netuid: index % 2 === 0 ? 7 : 11,
  provider: `provider-${index % 5}`,
  kind: index % 3 === 0 ? "openapi" : "subnet-api",
  layer: index % 4 === 0 ? "data-provider" : "subnet-app",
  status: index % 6 === 0 ? "degraded" : "ok",
  latency_ms: 25 + index,
}));

function endpointArtifact(value) {
  return {
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function createEndpointCsvEnv() {
  const base = createLocalArtifactEnv();
  const artifacts = new Map([
    ["/metagraph/endpoints.json", { endpoints: SYNTHETIC_ENDPOINT_ROWS }],
    [
      "/metagraph/endpoints/7.json",
      { endpoints: SYNTHETIC_ENDPOINT_ROWS.filter((row) => row.netuid === 7) },
    ],
  ]);

  return {
    ...base,
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (artifacts.has(pathname)) {
          return Response.json(artifacts.get(pathname));
        }
        return base.ASSETS.fetch(request);
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
        if (artifacts.has(pathname)) {
          return endpointArtifact(artifacts.get(pathname));
        }
        return base.METAGRAPH_ARCHIVE.get(key);
      },
    },
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
    // Clearly past the 48h default max-age — not exactly on the boundary, which
    // raced (a few ms of test runtime decided 48.001h > 48h vs == 48h).
    const stale = new Date(Date.now() - 72 * 3_600_000).toISOString();
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
    // A transient degraded 503 must not be edge-cached (it would pin the outage
    // for up to max-age + stale-while-revalidate after recovery).
    assert.equal(res.headers.get("cache-control"), "no-store");
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
    // The healthy path stays edge-cacheable (short profile) for load relief.
    assert.match(res.headers.get("cache-control"), /max-age=/);
  });

  test("reports chain-event index freshness (#1361)", async () => {
    const atMs = Date.now() - 18_000; // latest indexed event ~18s ago
    const preparedSql = [];
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "metagraph:latest": { published_at: new Date().toISOString() },
      }),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          preparedSql.push(sql);
          return {
            bind() {
              return {
                async all() {
                  return { results: [{ block: 8461200, at: atMs }] };
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(req("/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chain_events.latest_indexed_block, 8461200);
    assert.equal(typeof body.chain_events.age_seconds, "number");
    assert.ok(
      body.chain_events.age_seconds >= 17 &&
        body.chain_events.age_seconds <= 120,
      `age_seconds out of range: ${body.chain_events.age_seconds}`,
    );
    assert.ok(body.chain_events.latest_event_at.startsWith("20"));
    assert.deepEqual(preparedSql, [
      "SELECT block_number AS block, observed_at AS at FROM account_events " +
        "ORDER BY observed_at DESC LIMIT 1",
    ]);
  });

  test("chain_events is schema-stable nulls when the event tier is cold (#1361)", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: makeKv({
        "metagraph:latest": { published_at: new Date().toISOString() },
      }),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return { results: [] }; // empty account_events tier
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(req("/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chain_events.latest_indexed_block, null);
    assert.equal(body.chain_events.latest_event_at, null);
    assert.equal(body.chain_events.age_seconds, null);
  });

  test("chain_events is null when no health DB is bound (#1361)", async () => {
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("{}", { status: 404 });
        },
      },
    };
    const res = await handleRequest(req("/health"), env, {});
    assert.equal((await res.json()).chain_events, null);
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
  const fixture = {
    schema_version: 1,
    generated_at: "1970-01-01T00:00:00.000Z",
    surface_id: "7:subnet-api:new_v2",
    netuid: 7,
    subnet_slug: "allways",
    subnet_name: "AllWays",
    kind: "subnet-api",
    captured_at: "2026-06-16T12:00:00.000Z",
    request: { method: "GET", url: "https://api.all-ways.io/health" },
    response: {
      status: 200,
      content_type: "application/json",
      body: { ok: true },
    },
  };

  function fixtureEnv() {
    return createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (key === "latest/fixtures/7:subnet-api:new_v2.json") {
            const body = JSON.stringify(fixture);
            return {
              async json() {
                return fixture;
              },
              async text() {
                return body;
              },
            };
          }
          return null;
        },
      },
    });
  }

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

  test("serves R2-only fixture details with rich surface ids", async () => {
    const res = await handleRequest(
      req("/metagraph/fixtures/7:subnet-api:new_v2.json"),
      fixtureEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-storage-tier"), "r2");
    const body = await res.json();
    assert.equal(body.surface_id, "7:subnet-api:new_v2");
    assert.deepEqual(body.response.body, { ok: true });
  });
});

// --- fixture detail API --------------------------------------------------------
describe("fixture detail API", () => {
  const fixture = {
    schema_version: 1,
    generated_at: "1970-01-01T00:00:00.000Z",
    surface_id: "7:subnet-api:new_v2",
    netuid: 7,
    subnet_slug: "allways",
    subnet_name: "AllWays",
    kind: "subnet-api",
    captured_at: "2026-06-16T12:00:00.000Z",
    request: { method: "GET", url: "https://api.all-ways.io/health" },
    response: {
      status: 200,
      content_type: "application/json",
      body: { ok: true },
    },
  };

  function env() {
    return createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (key === "latest/fixtures/7:subnet-api:new_v2.json") {
            return {
              async json() {
                return fixture;
              },
            };
          }
          return null;
        },
      },
    });
  }

  test("GET /api/v1/fixtures/{surface_id} returns an enveloped fixture", async () => {
    const res = await handleRequest(
      req("/api/v1/fixtures/7:subnet-api:new_v2"),
      env(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.surface_id, "7:subnet-api:new_v2");
    assert.equal(body.data.request.method, "GET");
    assert.deepEqual(body.data.response.body, { ok: true });
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/fixtures/7:subnet-api:new_v2.json",
    );
  });

  test("fixture detail route rejects traversal-like surface ids", async () => {
    const res = await handleRequest(
      req("/api/v1/fixtures/..%2Fsecrets"),
      env(),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
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

  test("304 for a badge when if-none-match sends the strong (W/-less) validator", async () => {
    // weakEtag emits W/"…", but If-None-Match uses weak comparison (RFC 7232),
    // so the strong form "…" must also match. The previous strict === check
    // only matched the exact W/"…" echo and returned 200 here.
    const env = createLocalArtifactEnv();
    const first = await handleRequest(
      req("/metagraph/health/badges/7.svg"),
      env,
      {},
    );
    const strong = first.headers.get("etag").replace(/^W\//, "");
    const res = await handleRequest(
      req("/metagraph/health/badges/7.svg", {
        headers: { "if-none-match": strong },
      }),
      env,
      {},
    );
    assert.equal(res.status, 304);
  });

  test("304 for the MCP server card / agent-tools with the strong validator", async () => {
    // The same weak-comparison fix applies to the other two discovery handlers.
    const env = createLocalArtifactEnv();
    for (const path of [
      "/.well-known/mcp/server-card.json",
      "/.well-known/agent-tools/openai.json",
    ]) {
      const first = await handleRequest(req(path), env, {});
      assert.equal(first.status, 200, `${path} first GET`);
      const strong = first.headers.get("etag").replace(/^W\//, "");
      const res = await handleRequest(
        req(path, { headers: { "if-none-match": strong } }),
        env,
        {},
      );
      assert.equal(res.status, 304, `${path} strong-form revalidation`);
    }
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

  test("400 invalid_query for an unknown list query parameter", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?statuss=active"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.error.message, "unknown query parameter.");
    assert.equal(body.meta.parameter, "statuss");
  });

  test("400 invalid_query for an unsupported format value on CSV list routes", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?format=xml"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.error.message, "format must be json or csv.");
    assert.equal(body.meta.parameter, "format");
  });

  test("400 invalid_query for an unsupported projected field", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?fields=netuid,not_a_field"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "fields");
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

// --- CSV list export ----------------------------------------------------------
describe("subnets CSV export", () => {
  test("?format=csv returns text/csv with projected rows", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?format=csv&fields=netuid,name&sort=netuid&limit=2"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="subnets.csv"',
    );

    const nextMatch = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    assert.ok(nextMatch, "CSV pagination should advertise the next page");
    const next = new URL(nextMatch[1]);
    assert.equal(next.searchParams.get("format"), "csv");
    assert.equal(next.searchParams.get("cursor"), "2");
    assert.equal(next.searchParams.get("limit"), "2");
    assert.equal(next.searchParams.get("sort"), "netuid");

    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], "netuid,name");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^\d+,/);
    assert.match(lines[2], /^\d+,/);
  });

  test("Accept: text/csv negotiates CSV and honors filters", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?fields=netuid,status&status=active&limit=5", {
        headers: { accept: "application/json, text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);

    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], "netuid,status");
    assert.ok(lines.length > 1);
    assert.equal(
      lines.slice(1).every((line) => line.endsWith(",active")),
      true,
    );
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?format=json&fields=netuid,name&limit=1", {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.equal(res.headers.get("content-disposition"), null);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.data.subnets), true);
    assert.deepEqual(Object.keys(body.data.subnets[0]).sort(), [
      "name",
      "netuid",
    ]);

    const nextMatch = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    assert.ok(nextMatch, "JSON pagination should advertise the next page");
    const next = new URL(nextMatch[1]);
    assert.equal(next.searchParams.get("format"), "json");

    const nextRes = await handleRequest(
      req(`${next.pathname}${next.search}`, {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(nextRes.status, 200);
    assert.match(nextRes.headers.get("content-type"), /^application\/json/);
    assert.equal(nextRes.headers.get("content-disposition"), null);
  });

  test("Accept: text/csv is ignored for non-collection routes", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/7", {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("Accept: text/csv is ignored for collection routes without CSV contracts", async () => {
    // /api/v1/providers is a list route that intentionally has no CSV contract,
    // so content negotiation must fall through to the JSON envelope.
    const res = await handleRequest(
      req("/api/v1/providers?limit=1", {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.data.providers), true);
  });

  test("empty projected CSV exports retain the requested header row", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets?format=csv&fields=netuid,name&netuids=99999"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(await res.text(), "netuid,name");
  });

  test("malformed list artifacts surface an artifact-shape error", async () => {
    const malformedList = { profiles: [] };
    const env = createLocalArtifactEnv({
      ASSETS: {
        async fetch() {
          return Response.json(malformedList);
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return malformedList;
            },
            async text() {
              return JSON.stringify(malformedList);
            },
          };
        },
      },
    });

    const res = await handleRequest(req("/api/v1/subnets?format=csv"), env, {});
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_artifact");
    assert.equal(body.meta.artifact_path, "/metagraph/subnets.json");
    assert.equal(body.meta.collection, "subnets");
  });
});

// --- Review enrichment list CSV export (#2527) --------------------------------
describe("review enrichment list CSV export", () => {
  const parseCsv = async (res) => {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    const lines = (await res.text()).split("\r\n");
    const header = lines[0].split(",");
    const rows = lines
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const values = line.split(",");
        return Object.fromEntries(
          header.map((name, index) => [name, values[index]]),
        );
      });
    return { header, rows, lines };
  };

  test("review/gaps ?format=csv exports priority_score and honors curation_level", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/review/gaps?format=csv&fields=netuid,priority_score,curation_level&sort=priority_score&limit=5&curation_level=candidate-discovered",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const { header, rows } = await parseCsv(res);
    assert.equal(header.join(","), "netuid,priority_score,curation_level");
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((row) => row.curation_level === "candidate-discovered"),
    );
    assert.ok(rows.every((row) => /^\d+$/.test(row.netuid)));
    assert.ok(rows.every((row) => row.priority_score !== ""));
  });

  test("review/profile-completeness ?format=csv exports priority_score and honors identity_level", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/review/profile-completeness?format=csv&fields=netuid,priority_score,identity_level&sort=priority_score&limit=5&identity_level=partial",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const { header, rows } = await parseCsv(res);
    assert.equal(header.join(","), "netuid,priority_score,identity_level");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.identity_level === "partial"));
    assert.ok(rows.every((row) => row.priority_score !== ""));
  });

  test("review/adapter-candidates ?format=csv exports priority_score and honors operational_kinds", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/review/adapter-candidates?format=csv&fields=netuid,priority_score,operational_kinds&sort=priority_score&limit=5&operational_kinds=openapi",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const { header, rows } = await parseCsv(res);
    assert.equal(header.join(","), "netuid,priority_score,operational_kinds");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.operational_kinds.includes("openapi")));
    assert.ok(rows.every((row) => row.priority_score !== ""));
  });

  test("review/enrichment-queue ?format=csv exports priority_score and honors lane", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/review/enrichment-queue?format=csv&fields=netuid,priority_score,lane&sort=priority_score&limit=5&lane=direct-submission",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const { header, rows } = await parseCsv(res);
    assert.equal(header.join(","), "netuid,priority_score,lane");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.lane === "direct-submission"));
    assert.ok(rows.every((row) => row.priority_score !== ""));
  });
});

// --- registry list CSV export (#2521-#2526) -----------------------------------
describe("registry list CSV export", () => {
  const parseCsv = async (res) => {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    const text = await res.text();
    const lines = text.split("\r\n").filter(Boolean);
    const header = lines[0].split(",");
    const rows = lines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(
        header.map((name, index) => [name, values[index]]),
      );
    });
    return { header, rows, lines };
  };

  const CSV_ROUTES = [
    "economics",
    "surfaces",
    "subnet-surfaces",
    "endpoints",
    "subnet-endpoints",
    "provider-endpoints",
    "candidates",
    "subnet-candidates",
    "profiles",
    "coverage-depth",
  ];

  test("every wired registry route advertises the CSV contract", () => {
    for (const id of CSV_ROUTES) {
      const entry = API_ROUTES.find((route) => route.id === id);
      assert.ok(entry, `route ${id} should exist`);
      assert.equal(entry.csv_response, true, `${id} should set csv_response`);
      const formatParam = (entry.query_parameters || []).find(
        (param) => param.name === "format",
      );
      assert.ok(formatParam, `${id} should expose a format parameter`);
      assert.deepEqual(formatParam.schema.enum, ["json", "csv"]);
    }
  });

  test("list routes without a CSV contract stay JSON-only", () => {
    for (const id of ["providers", "rpc-endpoints", "source-snapshots"]) {
      const entry = API_ROUTES.find((route) => route.id === id);
      assert.ok(entry, `route ${id} should exist`);
      assert.notEqual(entry.csv_response, true, `${id} must stay JSON-only`);
    }
  });

  // Each top-level route resolves a real local artifact, so ?format=csv returns
  // a text/csv attachment named after the route id with a header row.
  for (const [path, filename] of [
    ["/api/v1/economics", "economics.csv"],
    ["/api/v1/surfaces", "surfaces.csv"],
    ["/api/v1/endpoints", "endpoints.csv"],
    ["/api/v1/candidates", "candidates.csv"],
    ["/api/v1/profiles", "profiles.csv"],
    ["/api/v1/coverage-depth", "coverage-depth.csv"],
  ]) {
    test(`${path}?format=csv returns a named text/csv download`, async () => {
      const res = await handleRequest(
        req(`${path}?format=csv&limit=3`),
        createLocalArtifactEnv(),
        {},
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/csv/);
      assert.equal(
        res.headers.get("content-disposition"),
        `attachment; filename="${filename}"`,
      );
      const [header] = (await res.text()).split("\r\n");
      assert.ok(header.length > 0, "CSV must include a header row");
      assert.ok(header.includes(","), "header should list multiple columns");
    });
  }

  test("profiles CSV export projects completeness columns and preserves descending score order (#2525)", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/profiles?format=csv&fields=netuid,completeness_score,curation_level,profile_level&sort=completeness_score&order=desc&limit=5",
      ),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="profiles.csv"',
    );

    const { header, rows } = await parseCsv(res);
    assert.equal(
      header.join(","),
      "netuid,completeness_score,curation_level,profile_level",
    );
    assert.ok(rows.length > 1);
    const scores = rows.map((row) => Number(row.completeness_score));
    assert.ok(scores.every(Number.isFinite));
    assert.deepEqual(
      scores,
      [...scores].sort((a, b) => b - a),
    );
    assert.ok(rows.every((row) => /^\d+$/.test(row.netuid)));
    assert.ok(rows.every((row) => row.curation_level !== ""));
    assert.ok(rows.every((row) => row.profile_level !== ""));
  });

  test("subnet-scoped surfaces export CSV for one netuid", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets/0/surfaces?format=csv"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="subnet-surfaces.csv"',
    );
  });

  test("surfaces CSV export projects kind/provider/name and honors kind filters (#2522)", async () => {
    const parseCsv = async (res) => {
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/csv/);
      const lines = (await res.text()).split("\r\n").filter(Boolean);
      const header = lines[0].split(",");
      const rows = lines.slice(1).map((line) => {
        const values = line.split(",");
        return Object.fromEntries(
          header.map((name, index) => [name, values[index]]),
        );
      });
      return { header, rows };
    };

    const all = await handleRequest(
      req(
        "/api/v1/surfaces?format=csv&fields=kind,provider,name&kind=openapi&limit=5",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const allCsv = await parseCsv(all);
    assert.equal(allCsv.header.join(","), "kind,provider,name");
    assert.ok(allCsv.rows.length > 0);
    assert.ok(allCsv.rows.every((row) => row.kind === "openapi"));
    assert.ok(allCsv.rows.every((row) => row.provider !== ""));
    assert.ok(allCsv.rows.every((row) => row.name !== ""));

    const subnet = await handleRequest(
      req(
        "/api/v1/subnets/6/surfaces?format=csv&fields=kind,provider,name&kind=openapi",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const subnetCsv = await parseCsv(subnet);
    assert.equal(subnetCsv.header.join(","), "kind,provider,name");
    assert.ok(subnetCsv.rows.length > 0);
    assert.ok(subnetCsv.rows.every((row) => row.kind === "openapi"));
    assert.ok(subnetCsv.rows.every((row) => row.provider !== ""));
    assert.ok(subnetCsv.rows.every((row) => row.name !== ""));
  });

  test("endpoints CSV export filters, projects, and streams the large route path (#2523)", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/endpoints?format=csv&fields=netuid,provider,status&status=ok&limit=3",
      ),
      createEndpointCsvEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="endpoints.csv"',
    );
    assert.equal(res.headers.get("etag"), null);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.equal(decoder.decode(first.value), "netuid,provider,status\r\n");

    let body = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();

    const lines = body.split("\r\n");
    assert.equal(lines.length, 3);
    assert.equal(
      lines.every((line) => /^\d+,provider-\d+,ok$/.test(line)),
      true,
    );
  });

  test("subnet-endpoints CSV export keeps endpoint columns and honors projection (#2523)", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/subnets/7/endpoints?format=csv&fields=layer,kind,status,latency_ms&status=ok&limit=3",
      ),
      createEndpointCsvEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="subnet-endpoints.csv"',
    );
    assert.equal(res.headers.get("etag"), null);

    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], "layer,kind,status,latency_ms");
    assert.equal(lines.length, 4);
    assert.equal(
      lines
        .slice(1)
        .every((line) =>
          /^(data-provider|subnet-app),(openapi|subnet-api),ok,\d+$/.test(line),
        ),
      true,
    );
  });

  test("Accept: text/csv negotiates CSV on a registry route", async () => {
    const res = await handleRequest(
      req("/api/v1/economics?limit=1", { headers: { accept: "text/csv" } }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
  });

  test("?format=json keeps the JSON envelope on a registry route", async () => {
    const res = await handleRequest(
      req("/api/v1/economics?format=json&limit=1", {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    // The economics collection projects onto the shared `subnets` data key.
    assert.equal(Array.isArray(body.data.subnets), true);
  });
});

describe("coverage-depth CSV export", () => {
  const parseCsvRows = (text) => {
    const rows = [];
    let currentRow = [];
    let currentField = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          currentField += '"';
          i += 1;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }

      if (!inQuotes && char === ",") {
        currentRow.push(currentField);
        currentField = "";
        continue;
      }

      if (!inQuotes && char === "\r") {
        if (next === "\n") {
          i += 1;
        }
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        continue;
      }

      if (!inQuotes && char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        continue;
      }

      currentField += char;
    }

    if (currentField.length > 0 || currentRow.length > 0) {
      currentRow.push(currentField);
    }

    if (currentRow.length > 0 && currentRow.some((value) => value !== "")) {
      rows.push(currentRow);
    }

    return rows;
  };

  const parseCoverageCsv = async (res) => {
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    const text = await res.text();
    const lines = parseCsvRows(text).filter(
      (line) => line.length !== 0 && !line.every((value) => value === ""),
    );
    const header = lines[0];
    const rows = lines.slice(1).map((values, index) => {
      assert.equal(
        values.length,
        header.length,
        `row ${index + 1} should have the same number of columns as header`,
      );
      return Object.fromEntries(
        header.map((name, index) => [name, values[index] ?? ""]),
      );
    });
    return { header, rows, text };
  };

  test("?format=csv returns projected coverage-depth rows", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/coverage-depth?format=csv&fields=netuid,tier,agent_status,priority_score,score,name&sort=netuid&limit=2",
      ),
      withCoverageDepthArchive(),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="coverage-depth.csv"',
    );

    const { header, rows } = await parseCoverageCsv(res);
    assert.equal(
      header.join(","),
      "netuid,tier,agent_status,priority_score,score,name",
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      netuid: "7",
      tier: "agent-ready",
      agent_status: "callable",
      priority_score: "86",
      score: "77",
      name: 'Allways, "callable"',
    });
    assert.deepEqual(rows[1], {
      netuid: "31",
      tier: "missing-interface",
      agent_status: "blocked",
      priority_score: "67",
      score: "18",
      name: "Recall",
    });
  });

  test("?tier=agent-ready&format=csv applies coverage-depth filter and keeps CSV escaping", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/coverage-depth?tier=agent-ready&format=csv&fields=netuid,tier,name",
      ),
      withCoverageDepthArchive(),
      {},
    );
    assert.equal(res.status, 200);
    const { header, rows, text } = await parseCoverageCsv(res);
    assert.equal(
      text.includes('"Allways, ""callable""'),
      true,
      "escaped name must be emitted as quoted CSV text",
    );
    assert.equal(header.join(","), "netuid,tier,name");
    assert.deepEqual(rows, [
      {
        netuid: "7",
        tier: "agent-ready",
        name: 'Allways, "callable"',
      },
    ]);
  });
});

// --- RFC 8288 pagination Link header (#1686) ----------------------------------
// /api/v1/subnets is the only end-to-end list fixture; the header is built once
// for every cursor-paginated collection in workers/list-query.mjs, so proving it
// here proves the wiring for all of them. The fixture sorts to a stable netuid
// run, so limit=50 yields exactly three pages at cursors 0 / 50 / 100.
describe("pagination Link header", () => {
  const parseLink = (value) => {
    const links = {};
    for (const part of String(value || "").split(",")) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) {
        links[match[2]] = new URL(match[1]);
      }
    }
    return links;
  };
  const page = async (querySuffix, init) => {
    const res = await handleRequest(
      req(`/api/v1/subnets?sort=netuid&${querySuffix}`, init),
      createLocalArtifactEnv(),
      {},
    );
    return { res, links: parseLink(res.headers.get("link")) };
  };

  test("first page advertises next + last, never prev/first", async () => {
    const { res, links } = await page("limit=50&cursor=0");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(links).sort(), ["last", "next"]);
    assert.equal(links.next.origin, "https://api.metagraph.sh");
    assert.equal(links.next.searchParams.get("cursor"), "50");
    assert.equal(links.next.searchParams.get("limit"), "50");
    assert.equal(links.next.searchParams.get("sort"), "netuid");
    assert.equal(links.last.searchParams.get("cursor"), "100");
    // The Link header must be readable cross-origin (exposed via CORS), or a
    // browser link-follower could not walk the pages.
    assert.match(res.headers.get("access-control-expose-headers"), /\blink\b/);
  });

  test("page links reject ignored/tracker query params end-to-end", async () => {
    const { res } = await page(
      "limit=50&cursor=0&utm_campaign=evil&token=SECRET123",
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.error.message, "unknown query parameter.");
    assert.equal(body.meta.parameter, "utm_campaign");
  });

  test("middle page advertises all four relations", async () => {
    const { links } = await page("limit=50&cursor=50");
    assert.deepEqual(Object.keys(links).sort(), [
      "first",
      "last",
      "next",
      "prev",
    ]);
    assert.equal(links.first.searchParams.get("cursor"), "0");
    assert.equal(links.prev.searchParams.get("cursor"), "0");
    assert.equal(links.next.searchParams.get("cursor"), "100");
    assert.equal(links.last.searchParams.get("cursor"), "100");
  });

  test("last page advertises first + prev, never next/last", async () => {
    const { links } = await page("limit=50&cursor=100");
    assert.deepEqual(Object.keys(links).sort(), ["first", "prev"]);
    assert.equal(links.first.searchParams.get("cursor"), "0");
    assert.equal(links.prev.searchParams.get("cursor"), "50");
  });

  test("last targets the final page, not past it, when total divides evenly", async () => {
    // 129 subnets / limit 43 = exactly 3 pages, so `last` must be 86 (page 3
    // start), not 129 — guarding the `(total - 1)` correction in the offset.
    const { links } = await page("limit=43&cursor=0");
    assert.equal(links.last.searchParams.get("cursor"), "86");
  });

  test("empty result set carries no Link header", async () => {
    const { res } = await page("netuid=999999&limit=50");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).meta.pagination.total, 0);
    assert.equal(res.headers.get("link"), null);
  });

  test("an unpaged request (no limit/cursor) carries no Link header", async () => {
    const { res } = await page("order=asc");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("link"), null);
  });

  test("a HEAD request still carries the walkable Link header", async () => {
    const { res, links } = await page("limit=50&cursor=0", { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    assert.equal(links.next.searchParams.get("cursor"), "50");
  });

  test("a 304 conditional response preserves the Link header", async () => {
    const env = createLocalArtifactEnv();
    const first = await handleRequest(
      req("/api/v1/subnets?sort=netuid&limit=50&cursor=0"),
      env,
      {},
    );
    const res = await handleRequest(
      req("/api/v1/subnets?sort=netuid&limit=50&cursor=0", {
        headers: { "if-none-match": first.headers.get("etag") },
      }),
      env,
      {},
    );
    assert.equal(res.status, 304);
    assert.match(res.headers.get("link"), /rel="next"/);
  });
});

// --- slim search index route --------------------------------------------------
describe("/api/v1/search-index slim route", () => {
  test("serves the slim index without per-document token blobs", async () => {
    const res = await handleRequest(
      req("/api/v1/search-index?limit=5"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.data.documents.length > 0);
    assert.equal(
      body.data.documents.every((document) => !("tokens" in document)),
      true,
      "slim route documents must omit the heavy tokens field",
    );
  });

  test("supports field projection and keyword search", async () => {
    const res = await handleRequest(
      req("/api/v1/search-index?fields=id,title,type&limit=3"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.meta.projection.fields, ["id", "title", "type"]);
    assert.equal(
      body.data.documents.every((document) =>
        Object.keys(document).every((key) =>
          ["id", "title", "type"].includes(key),
        ),
      ),
      true,
    );
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

  test("400 when Content-Length is invalid before reading the body", async () => {
    const res = await handleRequest(
      req("/rpc/v1/finney", {
        method: "POST",
        headers: { "content-length": "-1" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "system_health" }),
      }),
      rpcEnv(),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "rpc_invalid_content_length");
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

  test("logs the swallowed D1 error via the [d1All] dark-serve contract (#2076)", async () => {
    // Regression: handleHealthTrends previously inlined db.prepare().bind().all()
    // with a BARE catch that returned [] silently — re-introducing the dark-serve
    // failure the [d1All] logging exists to catch. Reading through d1All now logs
    // every swallowed failure, so a prod schema drift is diagnosable.
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  throw new Error("no such column: surface_key");
                },
              };
            },
          };
        },
      },
    });
    const calls = [];
    const original = console.error;
    console.error = (...args) => calls.push(args);
    try {
      const res = await handleRequest(
        req("/api/v1/subnets/0/health/trends"),
        env,
        {},
      );
      assert.equal(res.status, 200);
    } finally {
      console.error = original;
    }
    const logged = calls.find((args) => args[0] === "[d1All]");
    assert.ok(
      logged,
      "the swallowed trends D1 error must be logged with the [d1All] prefix",
    );
    assert.match(String(logged[1]), /no such column/);
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

  test("returns the final endpoint when randomFn lands exactly on the total (cursor never < 0)", () => {
    // randomFn() === 1 → cursor = total; subtracting each weight leaves cursor at
    // exactly 0 after the last endpoint, never < 0, so the loop never returns and
    // the post-loop fallthrough (return endpoints[len-1]) is taken.
    const endpoints = [
      { id: "a", score: 1 },
      { id: "b", score: 1 },
      { id: "c", score: 1 },
    ];
    const picked = weightedPickEndpoint(endpoints, () => 1);
    assert.equal(picked.id, "c");
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

// --- Access-Control-Expose-Headers --------------------------------------------
// Cross-origin scripts can only read the Fetch safelist unless the server names
// the rest in Access-Control-Expose-Headers. Assert the canonical list rides on
// each CORS-open surface: the standard builder (list), the error path (ask), and
// the hand-rolled SSE headers. RPC and MCP are covered in their own suites.
describe("Access-Control-Expose-Headers", () => {
  const expose = (res) => res.headers.get("access-control-expose-headers");

  test("list endpoint exposes the canonical custom-header list", async () => {
    const res = await handleRequest(
      req("/api/v1/subnets"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(expose(res), EXPOSED_RESPONSE_HEADERS_VALUE);
  });

  test("the ask error path exposes the list", async () => {
    // AI is disabled locally, so this is the 503 path through the shared builder.
    const res = await handleRequest(
      req("/api/v1/ask", { method: "POST", body: "{}" }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(expose(res), EXPOSED_RESPONSE_HEADERS_VALUE);
  });

  test("the SSE event surface exposes the list", async () => {
    const res = await handleRequest(
      req("/api/v1/events"),
      createLocalArtifactEnv(),
      {},
    );
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(expose(res), EXPOSED_RESPONSE_HEADERS_VALUE);
  });
});

// --- inverse contract coverage ------------------------------------------------
// The FORWARD direction (every contract route is reachable + serves a 200) is
// covered by validate-api.mjs + smoke-route-substitution. This is the INVERSE: a
// /api/v1 path dispatched by workers/api.mjs that has NO matching API_ROUTES entry
// in contracts.mjs is invisible to OpenAPI/types/SDK. That gap let the chain-events
// routes ship dispatched-but-uncontracted; this guard fails CI on any new one.
//
// Two complementary checks: (A) every literal `=== "/api/v1/…"` dispatch in the
// source either resolves to a contract route or is on the explicit non-contract
// allowlist; (B) every config `*_PATH_PATTERN` anchoring /api/v1 backs at least one
// contract route. A representative path for each contract route is built by
// substituting the path placeholders with the same sample ids the live smoke uses.
describe("inverse contract coverage (dispatched ⊆ contracted)", () => {
  const apiSource = readFileSync(
    fileURLToPath(new URL("../workers/api.mjs", import.meta.url)),
    "utf8",
  );

  // Paths workers/api.mjs dispatches that are intentionally NOT contract routes:
  // POST/internal/special-protocol surfaces (no GET artifact envelope), the
  // network-prefix rewrite, and the SSE/icon/feeds operational endpoints. Each is
  // listed with the reason it is excluded from the OpenAPI contract.
  const NON_CONTRACT_PATHS = new Set([
    "/api/v1/ask", // grounded-RAG POST, degrades to 503; not a GET artifact
    "/api/v1/events", // SSE change feed (text/event-stream)
    "/api/v1/feeds/", // SSE/webhook feed prefix
    "/api/v1/graphql", // GraphQL POST layer over the same artifacts
    "/api/v1/icon", // image proxy (binary), not a JSON artifact
    "/api/v1/search/semantic", // AI-gated semantic search, mainnet-only special
    "/api/v1/testnet/subnets", // network-prefix rewrite, not its own route
  ]);
  const NON_CONTRACT_PREFIXES = [
    "/api/v1/internal/", // secret-gated ingest write paths
    "/api/v1/webhooks/", // subscription management (POST/DELETE/GET)
  ];

  function buildSamplePath(routePath) {
    return routePath
      .replace("{netuid}", "7")
      .replace("{slug}", "allways")
      .replace("{date}", "2026-06-24")
      .replace("{uid}", "0")
      .replace("{hash}", `0x${"0".repeat(64)}`)
      .replace("{ref}", "0")
      .replace("{ss58}", "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM");
  }

  // One concrete sample pathname per contract route (placeholders substituted).
  const contractSamplePaths = API_ROUTES.map((route) =>
    buildSamplePath(route.path),
  );

  function pathIsContracted(pathname) {
    return API_ROUTES.some((route) =>
      compileRoutePattern(route.path).test(pathname),
    );
  }

  // (A) Extract every literal `=== "/api/v1/…"` equality dispatch from the source.
  const literalDispatchPaths = [
    ...apiSource.matchAll(/===\s*"(\/api\/v1\/[^"]*)"/g),
  ].map((match) => match[1]);

  test("source has literal /api/v1 dispatches to assert over", () => {
    // Guard the regex itself: if the dispatch style changes and this finds nothing,
    // the per-path assertions below would vacuously pass.
    assert.ok(
      literalDispatchPaths.length >= 5,
      `expected several literal /api/v1 dispatches, found ${literalDispatchPaths.length}`,
    );
  });

  for (const dispatched of [...new Set(literalDispatchPaths)]) {
    test(`dispatched literal ${dispatched} is contracted or allowlisted`, () => {
      if (
        NON_CONTRACT_PATHS.has(dispatched) ||
        NON_CONTRACT_PREFIXES.some((prefix) => dispatched.startsWith(prefix))
      ) {
        return;
      }
      assert.ok(
        pathIsContracted(dispatched),
        `workers/api.mjs dispatches ${dispatched} but no API_ROUTES entry in src/contracts.mjs matches it — add a route() so it is visible to OpenAPI/types/SDK (or add it to NON_CONTRACT_PATHS with a reason if it is intentionally uncontracted).`,
      );
    });
  }

  // (B) Every config path-pattern that anchors /api/v1 must back a contract route.
  const apiPathPatterns = Object.entries(workerConfig).filter(
    ([name, value]) =>
      name.endsWith("_PATH_PATTERN") &&
      value instanceof RegExp &&
      value.source.includes("\\/api\\/v1\\/"),
  );

  test("config exposes /api/v1 path patterns to assert over", () => {
    assert.ok(
      apiPathPatterns.length >= 10,
      `expected the block-explorer/analytics path patterns, found ${apiPathPatterns.length}`,
    );
  });

  for (const [name, pattern] of apiPathPatterns) {
    test(`config ${name} backs a contract route`, () => {
      assert.ok(
        contractSamplePaths.some((sample) => pattern.test(sample)),
        `workers/config.mjs ${name} dispatches a /api/v1 path that no API_ROUTES entry covers — add the matching route() in src/contracts.mjs.`,
      );
    });
  }
});
