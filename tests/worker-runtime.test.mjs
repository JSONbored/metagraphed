import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import worker, { handleRequest } from "../workers/api.mjs";

const env = createLocalArtifactEnv();

function r2ArchiveFixture(artifactsByKey) {
  return {
    async get(key) {
      const artifact =
        artifactsByKey[key] || artifactsByKey[key.replace(/^latest\//, "")];
      if (!artifact) {
        return null;
      }
      return {
        async json() {
          return artifact;
        },
      };
    },
  };
}

describe("Worker runtime", () => {
  test("default export delegates to handleRequest", async () => {
    const response = await worker.fetch(
      new Request("https://metagraph.sh/api/v1/build"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  test("serves API envelopes with cache and CORS headers", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/7"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-metagraph-cache-profile"), "standard");
    assert.ok(response.headers.get("etag"));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.subnet.netuid, 7);
    // published_at is null when no control KV pointer is bound.
    assert.equal(body.meta.published_at, null);
  });

  test("surfaces meta.published_at from the KV latest pointer", async () => {
    const publishedAt = "2026-06-09T13:57:16.231Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key, options) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/7"),
      controlEnv,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.published_at, publishedAt);
    // generated_at stays the deterministic content marker, distinct from it.
    assert.notEqual(body.meta.generated_at, publishedAt);
  });

  test("/api/v1/build populates the body's published_at from the KV pointer (generated_at stays the marker)", async () => {
    const publishedAt = "2026-06-12T21:06:24.956Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key, options) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/build"),
      controlEnv,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    // The committed build-summary body carries published_at:null; serve overlays
    // the real publish pointer so a body-reading agent sees genuine freshness.
    assert.equal(body.data.published_at, publishedAt);
    assert.equal(body.meta.published_at, publishedAt);
    // generated_at stays the deterministic content marker (issue #349).
    assert.equal(body.data.generated_at, "1970-01-01T00:00:00.000Z");
  });

  test("/.well-known/mcp/server-card.json overlays published_at from the KV pointer", async () => {
    const publishedAt = "2026-06-12T21:06:24.956Z";
    const controlEnv = {
      ...env,
      METAGRAPH_CONTROL: {
        async get(key, options) {
          assert.equal(key, "metagraph:latest");
          assert.equal(options?.type, "json");
          return { latest_prefix: "latest/", published_at: publishedAt };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json"),
      controlEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.ok(response.headers.get("etag"));
    const card = await response.json();
    // The committed card carries published_at:null; serve overlays the real
    // publish pointer. generated_at stays the deterministic marker; the
    // content_hash + serverInfo are preserved.
    assert.equal(card.published_at, publishedAt);
    assert.equal(card.generated_at, "1970-01-01T00:00:00.000Z");
    assert.ok(card.content_hash, "card must keep its content_hash");
    assert.ok(card.serverInfo?.name, "card must keep serverInfo");

    // Cold (no KV pointer): published_at stays null, card still serves.
    const cold = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json"),
      env,
      {},
    );
    assert.equal(cold.status, 200);
    assert.equal((await cold.json()).published_at, null);
  });

  test("serves a health readiness probe", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/health"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "metagraphed");
    assert.equal(body.bindings.assets, true);
    assert.equal(typeof body.bindings.r2, "boolean");
    assert.equal(typeof body.bindings.kv, "boolean");

    const head = await handleRequest(
      new Request("https://metagraph.sh/health", { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(head.status, 200);

    const post = await handleRequest(
      new Request("https://metagraph.sh/health", { method: "POST" }),
      env,
      {},
    );
    assert.equal(post.status, 405);
  });

  test("returns 504 when an R2 read exceeds the timeout", async () => {
    const slowEnv = {
      ...env,
      METAGRAPH_R2_TIMEOUT_MS: "20",
      METAGRAPH_ARCHIVE: {
        async get() {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            async json() {
              return {};
            },
          };
        },
      },
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      slowEnv,
      {},
    );
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "r2_timeout");
  });

  test("renders a self-hosted SVG health badge for a subnet", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/7.svg"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "image/svg+xml; charset=utf-8",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    const svg = await response.text();
    assert.match(svg, /^<svg/);
    assert.match(svg, /SN7/);

    const cached = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/7.svg", {
        headers: { "if-none-match": etag },
      }),
      env,
      {},
    );
    assert.equal(cached.status, 304);
  });

  test("renders a graceful badge for a subnet without a badge artifact", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/health/badges/99999.svg"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "image/svg+xml; charset=utf-8",
    );
    const svg = await response.text();
    assert.match(svg, /SN99999/);
    assert.match(svg, /unavailable/);
  });

  test("serves raw R2-tier artifacts from archive storage", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal((await response.json()).subnet.netuid, 7);

    const candidates = await handleRequest(
      new Request("https://metagraph.sh/metagraph/candidates.json"),
      env,
      {},
    );
    assert.equal(candidates.status, 200);
    assert.equal(candidates.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(candidates.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal(Array.isArray((await candidates.json()).candidates), true);

    const reviewQueue = await handleRequest(
      new Request("https://metagraph.sh/metagraph/review-queue.json"),
      env,
      {},
    );
    assert.equal(reviewQueue.status, 200);
    assert.equal(reviewQueue.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(reviewQueue.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal(Array.isArray((await reviewQueue.json()).candidates), true);

    const missingArchive = await handleRequest(
      new Request("https://metagraph.sh/metagraph/subnets/7.json"),
      {
        ASSETS: env.ASSETS,
      },
      {},
    );
    assert.equal(missingArchive.status, 404);
    assert.equal(
      (await missingArchive.json()).error.code,
      "r2_binding_missing",
    );

    const assetMissing = await env.ASSETS.fetch(
      new Request("https://assets.local/metagraph/nope.json"),
    );
    assert.equal(assetMissing.status, 404);
  });

  test("allows explicit static fallback for R2-only artifacts in local mode", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/endpoints.json"),
      {
        ASSETS: {
          async fetch() {
            return Response.json({
              schema_version: 1,
              generated_at: "1970-01-01T00:00:00.000Z",
              endpoints: [{ id: "local-fallback", status: "unknown" }],
            });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
        },
        METAGRAPH_ALLOW_R2_STATIC_FALLBACK: "true",
      },
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-metagraph-artifact-source"),
      "static-assets",
    );
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.equal((await response.json()).endpoints[0].id, "local-fallback");
  });

  test("serves metagraph latest as an R2-backed raw artifact", async () => {
    const r2KeysRequested = [];
    const metagraphLatest = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      network: "finney",
      subnets: [],
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/metagraph/latest.json"),
      {
        ASSETS: env.ASSETS,
        METAGRAPH_ARCHIVE: {
          async get(key) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/metagraph/latest.json");
            return {
              async json() {
                return metagraphLatest;
              },
            };
          },
        },
      },
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.deepEqual(r2KeysRequested, ["latest/metagraph/latest.json"]);
    assert.equal((await response.json()).network, "finney");
  });

  test("serves raw R2-backed schema snapshot artifacts", async () => {
    const r2KeysRequested = [];
    const schemaSnapshot = {
      schema_version: 1,
      contract_version: "2026-06-06.1",
      generated_at: "1970-01-01T00:00:00.000Z",
      observed_at: "2999-01-01T00:00:00.000Z",
      surface_id: "example-openapi",
      schema_url: "https://example.com/openapi.json",
      hash: "abc123",
      openapi_version: "3.1.0",
      title: "Example API",
    };
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/metagraph/schemas/example-openapi.json",
      ),
      {
        ASSETS: env.ASSETS,
        METAGRAPH_ARCHIVE: {
          async get(key) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/schemas/example-openapi.json");
            return {
              async json() {
                return schemaSnapshot;
              },
            };
          },
        },
      },
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-artifact-source"), "r2");
    assert.equal(response.headers.get("x-metagraph-storage-tier"), "r2");
    assert.deepEqual(r2KeysRequested, ["latest/schemas/example-openapi.json"]);
    assert.equal((await response.json()).title, "Example API");
  });

  test("rejects raw artifact paths outside public contracts before storage lookup", async () => {
    const assetRequests = [];
    const r2KeysRequested = [];
    const response = await handleRequest(
      new Request("https://metagraph.sh/metagraph/internal/control.json"),
      {
        ASSETS: {
          async fetch(request) {
            assetRequests.push(new URL(request.url).pathname);
            return Response.json({ secret_token: "should-not-be-public" });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key) {
            r2KeysRequested.push(key);
            return {
              async json() {
                return { secret_token: "should-not-be-public" };
              },
            };
          },
        },
      },
      {},
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-metagraph-error-code"), "not_found");
    assert.deepEqual(assetRequests, []);
    assert.deepEqual(r2KeysRequested, []);
    assert.equal(
      (await response.json()).meta.artifact_path,
      "/metagraph/internal/control.json",
    );
  });

  test("supports HEAD, ETag revalidation, and CORS preflight", async () => {
    const head = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets", { method: "HEAD" }),
      env,
      {},
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.ok(head.headers.get("etag"));

    const source = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts"),
      env,
      {},
    );
    const cached = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts", {
        headers: { "if-none-match": source.headers.get("etag") },
      }),
      env,
      {},
    );
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");

    const options = await handleRequest(
      new Request("https://metagraph.sh/api/v1/contracts", {
        method: "OPTIONS",
      }),
      env,
      {},
    );
    assert.equal(options.status, 204);
    assert.equal(
      options.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );

    const rpcOptions = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "OPTIONS" }),
      env,
      {},
    );
    assert.equal(rpcOptions.status, 204);
    assert.equal(
      rpcOptions.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
  });

  test("validates list query parameters with route-specific contracts", async () => {
    const invalidCases = [
      ["/api/v1/subnets?limit=0", "limit"],
      ["/api/v1/subnets?limit=1001", "limit"],
      ["/api/v1/subnets?cursor=nope", "cursor"],
      ["/api/v1/subnets?order=sideways", "order"],
      ["/api/v1/subnets?sort=nope", "sort"],
      ["/api/v1/subnets?netuid=nope", "netuid"],
      ["/api/v1/subnets?subnet_type=nope", "subnet_type"],
    ];

    for (const [path, parameter] of invalidCases) {
      const response = await handleRequest(
        new Request(`https://metagraph.sh${path}`),
        env,
        {},
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, parameter);
    }

    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/subnets?q=allways&sort=netuid&order=desc&limit=1&cursor=0",
      ),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.pagination.collection, "subnets");
    assert.equal(body.meta.pagination.limit, 1);
    assert.equal(body.meta.pagination.sort, "netuid");
  });

  test("returns deterministic API errors", async () => {
    const post = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets", { method: "POST" }),
      env,
      {},
    );
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(
      post.headers.get("x-metagraph-error-code"),
      "method_not_allowed",
    );

    const missingRoute = await handleRequest(
      new Request("https://metagraph.sh/api/v1/nope"),
      env,
      {},
    );
    assert.equal(missingRoute.status, 404);
    assert.equal((await missingRoute.json()).error.code, "not_found");

    const missingArtifact = await handleRequest(
      new Request("https://metagraph.sh/api/v1/subnets/999999"),
      env,
      {},
    );
    assert.equal(missingArtifact.status, 404);
    assert.equal(
      (await missingArtifact.json()).meta.artifact_path,
      "/metagraph/subnets/999999.json",
    );

    const noAssets = await handleRequest(
      new Request("https://metagraph.sh/anything"),
      {},
      {},
    );
    assert.equal(noAssets.status, 404);
    assert.equal((await noAssets.json()).error.code, "not_found");

    const staticFallback = await handleRequest(
      new Request("https://metagraph.sh/static.json"),
      {
        ASSETS: {
          async fetch() {
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      {},
    );
    assert.equal(staticFallback.status, 200);
  });

  test("falls back to R2 using KV latest pointer", async () => {
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/changelog"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_CONTROL: {
          async get(key) {
            assert.equal(key, "metagraph:latest");
            return { latest_prefix: "latest/" };
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key) {
            assert.equal(key, "latest/changelog.json");
            return {
              async json() {
                return {
                  schema_version: 1,
                  contract_version: "2026-06-06.1",
                  generated_at: "1970-01-01T00:00:00.000Z",
                  source: "generated-artifact-diff",
                };
              },
            };
          },
        },
      },
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).meta.source, "r2");

    const r2Miss = await handleRequest(
      new Request("https://metagraph.sh/api/v1/changelog"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_CONTROL: {
          async get() {
            throw new Error("kv unavailable");
          },
        },
        METAGRAPH_R2_LATEST_PREFIX: "latest/",
        METAGRAPH_ARCHIVE: {
          async get(key) {
            assert.equal(key, "latest/changelog.json");
            return null;
          },
        },
      },
      {},
    );
    assert.equal(r2Miss.status, 404);
    assert.equal((await r2Miss.json()).error.code, "artifact_not_found");
  });

  test("serves operational endpoint indexes from R2", async () => {
    const r2KeysRequested = [];
    const endpointArtifact = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      endpoints: [
        {
          id: "endpoint-r2",
          status: "ok",
          provider: "r2",
        },
      ],
    };
    const response = await handleRequest(
      new Request("https://metagraph.sh/api/v1/endpoints"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/endpoints.json");
            return {
              async json() {
                return endpointArtifact;
              },
            };
          },
        },
      },
      {},
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, "r2");
    assert.deepEqual(r2KeysRequested, ["latest/endpoints.json"]);
    assert.equal(body.data.endpoints[0].id, "endpoint-r2");

    const missing = await handleRequest(
      new Request("https://metagraph.sh/api/v1/endpoints"),
      {
        ASSETS: {
          async fetch() {
            return new Response("not found", { status: 404 });
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key) {
            r2KeysRequested.push(key);
            assert.equal(key, "latest/endpoints.json");
            return null;
          },
        },
      },
      {},
    );

    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "artifact_not_found");
  });

  test("keeps RPC proxy disabled and blocks unsafe methods", async () => {
    const wrongMethod = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "GET" }),
      env,
      {},
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST, OPTIONS");

    const disabled = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", { method: "POST" }),
      env,
      {},
    );
    assert.equal(disabled.status, 501);
    assert.equal((await disabled.json()).error.code, "rpc_proxy_disabled");

    const invalid = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: "{not json",
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(invalid.status, 400);

    const invalidRequest = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify([{ method: "chain_getHeader" }]),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(invalidRequest.status, 400);
    assert.equal(
      (await invalidRequest.json()).error.code,
      "rpc_invalid_request",
    );

    const blocked = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "author_submitExtrinsic",
          params: [],
        }),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "rpc_method_blocked");

    const tooLargeByHeader = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        headers: { "content-length": "70000" },
        body: "{}",
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(tooLargeByHeader.status, 413);

    const tooLargeByBody = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          method: "chain_getHeader",
          payload: "x".repeat(70000),
        }),
      }),
      { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(tooLargeByBody.status, 413);
  });

  test("reports RPC pool artifact and endpoint availability failures", async () => {
    const noPoolArtifact = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      }),
      { METAGRAPH_ENABLE_RPC_PROXY: "true" },
      {},
    );
    assert.equal(noPoolArtifact.status, 404);
    assert.equal(
      (await noPoolArtifact.json()).meta.artifact_path,
      "/metagraph/rpc/pools.json",
    );

    const noEligibleEndpoint = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      }),
      {
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        METAGRAPH_ARCHIVE: r2ArchiveFixture({
          "rpc/pools.json": {
            schema_version: 1,
            generated_at: "1970-01-01T00:00:00.000Z",
            pools: [
              {
                id: "finney-rpc",
                endpoints: [{ id: "bad", pool_eligible: false }],
              },
            ],
          },
        }),
      },
      {},
    );
    assert.equal(noEligibleEndpoint.status, 503);

    const originalFetch = globalThis.fetch;
    let unsafeFetchCalled = false;
    globalThis.fetch = async () => {
      unsafeFetchCalled = true;
      throw new Error("unsafe endpoint should not be fetched");
    };

    try {
      for (const unsafeUrl of [
        "http://127.0.0.1:9650/internal",
        "http://10.0.0.2:9650/internal",
        "http://169.254.169.254/latest/meta-data",
      ]) {
        const unsafeEndpoint = await handleRequest(
          new Request("https://metagraph.sh/rpc/v1/finney", {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "chain_getHeader",
              params: [],
            }),
          }),
          {
            METAGRAPH_ENABLE_RPC_PROXY: "true",
            METAGRAPH_ARCHIVE: r2ArchiveFixture({
              "rpc/pools.json": {
                schema_version: 1,
                generated_at: "1970-01-01T00:00:00.000Z",
                pools: [
                  {
                    id: "finney-rpc",
                    endpoints: [
                      {
                        id: "unsafe",
                        pool_eligible: true,
                        provider: "fixture",
                        url: unsafeUrl,
                      },
                    ],
                  },
                ],
              },
            }),
          },
          {},
        );
        assert.equal(unsafeEndpoint.status, 502);
        assert.equal(
          (await unsafeEndpoint.json()).error.code,
          "rpc_endpoint_unsafe",
        );
      }
      assert.equal(unsafeFetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unsafe RPC upstreams and falls back to the next trusted endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls = [];
    globalThis.fetch = async (url, init) => {
      fetchedUrls.push(String(url));
      assert.equal(init.method, "POST");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const rpcRequest = () =>
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      });

    const poolEnv = (endpoints) => ({
      METAGRAPH_ENABLE_RPC_PROXY: "true",
      METAGRAPH_ARCHIVE: r2ArchiveFixture({
        "rpc/pools.json": {
          schema_version: 1,
          generated_at: "1970-01-01T00:00:00.000Z",
          pools: [{ id: "finney-rpc", endpoints }],
        },
      }),
    });

    try {
      const unsafeOnlyCases = [
        null,
        "http://bittensor-finney.api.onfinality.io/public",
        "https://localhost/internal",
        "https://metadata.localhost/internal",
        "https://bittensor-finney.api.onfinality.io.evil.example/public",
        "not a url",
      ];

      for (const unsafeUrl of unsafeOnlyCases) {
        const response = await handleRequest(
          rpcRequest(),
          poolEnv([
            {
              id: "unsafe",
              pool_eligible: true,
              provider: "fixture",
              url: unsafeUrl,
            },
          ]),
          {},
        );
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, "rpc_endpoint_unsafe");
      }

      const response = await handleRequest(
        rpcRequest(),
        poolEnv([
          {
            id: "unsafe",
            pool_eligible: true,
            provider: "fixture",
            url: "https://localhost/internal",
          },
          {
            id: "safe",
            pool_eligible: true,
            provider: "fixture",
            url: "https://bittensor-finney.api.onfinality.io/public",
          },
        ]),
        {},
      );

      assert.equal(response.status, 200);
      assert.deepEqual(fetchedUrls, [
        "https://bittensor-finney.api.onfinality.io/public",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("proxies explicitly enabled safe RPC methods through eligible pools", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async (_url, init) => {
      called = true;
      assert.equal(init.method, "POST");
      const method = JSON.parse(init.body).method;
      assert.equal(["chain_getHeader", "system_health"].includes(method), true);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    try {
      const rpcPoolArtifact = {
        schema_version: 1,
        contract_version: "2026-06-06.1",
        generated_at: "1970-01-01T00:00:00.000Z",
        pools: [
          {
            id: "finney-rpc",
            endpoints: [
              {
                id: "fixture-rpc",
                pool_eligible: true,
                provider: "fixture",
                status: "ok",
                url: "https://bittensor-finney.api.onfinality.io/public",
              },
            ],
          },
          {
            id: "finney-wss",
            endpoints: [
              {
                id: "fixture-wss",
                pool_eligible: true,
                provider: "fixture",
                status: "ok",
                url: "wss://lite.chain.opentensor.ai:443",
              },
            ],
          },
        ],
      };
      const proxyEnv = {
        ...env,
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        ASSETS: {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/metagraph/rpc/pools.json") {
              return Response.json(rpcPoolArtifact);
            }
            return env.ASSETS.fetch(request);
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key) {
            assert.equal(key, "latest/rpc/pools.json");
            return {
              async json() {
                return rpcPoolArtifact;
              },
            };
          },
        },
      };
      const response = await handleRequest(
        new Request("https://metagraph.sh/rpc/v1/finney", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "chain_getHeader",
            params: [],
          }),
        }),
        proxyEnv,
        {},
      );
      assert.equal(response.status, 200);
      assert.equal(called, true);
      assert.ok(response.headers.get("x-metagraph-rpc-provider"));

      // The /wss route targets WebSocket-only endpoints that cannot be
      // HTTP-POSTed, so it is rejected with a clean 400 rather than proxied.
      const wssResponse = await handleRequest(
        new Request("https://metagraph.sh/rpc/v1/wss", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "system_health",
            params: [],
          }),
        }),
        proxyEnv,
        {},
      );
      assert.equal(wssResponse.status, 400);
      assert.equal(
        (await wssResponse.json()).error.code,
        "rpc_websocket_unsupported",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("applies supported query filters across artifact families", async () => {
    // health/latest.json is no longer generated (live-only health); derive the
    // history date from a stable committed artifact's generated_at instead.
    const subnetsObject = await env.METAGRAPH_ARCHIVE.get(
      "latest/subnets.json",
    );
    const latestHealthHistoryDate = String(
      (await subnetsObject.json()).generated_at,
    ).slice(0, 10);
    const checks = [
      [
        "https://metagraph.sh/api/v1/subnets?netuid=7",
        (body) => body.data.subnets.every((row) => row.netuid === 7),
      ],
      [
        "https://metagraph.sh/api/v1/surfaces?kind=openapi",
        (body) => body.data.surfaces.every((row) => row.kind === "openapi"),
      ],
      [
        "https://metagraph.sh/api/v1/providers?authority=official",
        (body) =>
          body.data.providers.every((row) => row.authority === "official"),
      ],
      [
        "https://metagraph.sh/api/v1/candidates?state=schema-valid",
        (body) =>
          body.data.candidates.every((row) => row.state === "schema-valid"),
      ],
      [
        "https://metagraph.sh/api/v1/curation?coverage_level=probed",
        (body) =>
          body.data.curation.every((row) => row.coverage_level === "probed"),
      ],
      [
        "https://metagraph.sh/api/v1/gaps?curation_level=adapter-backed",
        (body) =>
          body.data.gaps.every(
            (row) => row.curation_level === "adapter-backed",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/profiles?curation_level=adapter-backed",
        (body) =>
          body.data.profiles.length > 0 &&
          body.data.profiles.every(
            (row) => row.curation_level === "adapter-backed",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/evidence?q=allways",
        (body) => body.data.claims.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/source-snapshots?q=native",
        (body) => body.data.sources.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/search?q=allways",
        (body) => body.data.documents.length > 0,
      ],
      [
        "https://metagraph.sh/api/v1/subnets?limit=2&sort=netuid&order=desc",
        (body) =>
          body.data.subnets.length === 2 &&
          body.meta.pagination.returned === 2 &&
          body.meta.pagination.next_cursor === 2 &&
          body.data.subnets[0].netuid > body.data.subnets[1].netuid,
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/surfaces?kind=subnet-api&limit=3",
        (body) =>
          body.data.surfaces.length <= 3 &&
          body.data.surfaces.every(
            (surface) => surface.netuid === 7 && surface.kind === "subnet-api",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/candidates?limit=2",
        (body) =>
          body.data.candidates.length <= 2 &&
          body.data.candidates.every((candidate) => candidate.netuid === 7),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?recommended_adapter_kind=generic-openapi-or-custom",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every(
            (candidate) =>
              candidate.recommended_adapter_kind ===
              "generic-openapi-or-custom",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?operational_kinds=openapi",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every((candidate) =>
            candidate.operational_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/adapter-candidates?reason_codes=existing-adapter",
        (body) =>
          body.data.candidates.length > 0 &&
          body.data.candidates.every((candidate) =>
            candidate.reason_codes.includes("existing-adapter"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/profile-completeness?identity_level=partial",
        (body) =>
          body.data.profiles.length > 0 &&
          body.data.profiles.every(
            (profile) => profile.identity_level === "partial",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/profile-completeness?identity_promotion_kinds=source-repo&sort=identity_promotion_kind_count&order=desc",
        (body) =>
          body.data.profiles.length > 0 &&
          body.data.profiles.every((profile) =>
            profile.identity_promotion_kinds.includes("source-repo"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?identity_level=partial",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every((entry) => entry.identity_level === "partial"),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?direct_submission_kinds=openapi",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every((entry) =>
            entry.direct_submission_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-queue?missing_kinds=source-repo",
        (body) =>
          body.data.queue.length > 0 &&
          body.data.queue.every((entry) =>
            entry.missing_kinds.includes("source-repo"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-evidence?missing_kinds=openapi",
        (body) =>
          body.data.entries.length > 0 &&
          body.data.entries.every((entry) =>
            entry.missing_kinds.includes("openapi"),
          ),
      ],
      [
        "https://metagraph.sh/api/v1/review/enrichment-targets?target_type=surface-candidate&kind=openapi",
        (body) =>
          body.data.targets.length > 0 &&
          body.data.targets.every(
            (target) =>
              target.target_type === "surface-candidate" &&
              target.kind === "openapi",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/subnets/7/health?status=ok",
        (body) =>
          body.data.surfaces.every(
            (surface) => surface.netuid === 7 && surface.status === "ok",
          ),
      ],
      [
        `https://metagraph.sh/api/v1/health/history/${latestHealthHistoryDate}?limit=2`,
        (body) =>
          body.data.date === latestHealthHistoryDate &&
          body.data.surfaces.length <= 2 &&
          body.meta.pagination.collection === "surfaces",
      ],
      [
        "https://metagraph.sh/api/v1/providers/allways",
        (body) => body.data.provider.id === "allways",
      ],
    ];

    for (const [url, predicate] of checks) {
      const response = await handleRequest(new Request(url), env, {});
      assert.equal(response.status, 200, url);
      assert.equal(predicate(await response.json()), true, url);
    }
  });

  test("rejects malformed documented query parameters", async () => {
    const routes = [
      "https://metagraph.sh/api/v1/subnets?limit=0",
      "https://metagraph.sh/api/v1/subnets?cursor=-1",
      "https://metagraph.sh/api/v1/subnets?order=sideways",
      "https://metagraph.sh/api/v1/subnets?sort=unknown_field",
      "https://metagraph.sh/api/v1/subnets?netuid=not-a-number",
      "https://metagraph.sh/api/v1/subnets?coverage_level=fake",
      "https://metagraph.sh/api/v1/candidates?state=approved",
      "https://metagraph.sh/api/v1/review/adapter-candidates?recommended_adapter_kind=generic",
      "https://metagraph.sh/api/v1/review/profile-completeness?identity_level=unknown",
      "https://metagraph.sh/api/v1/review/enrichment-queue?direct_submission_kinds=seed-node",
      "https://metagraph.sh/api/v1/review/enrichment-queue?identity_level=unknown",
      "https://metagraph.sh/api/v1/review/enrichment-evidence?missing_kinds=seed-node",
      "https://metagraph.sh/api/v1/review/enrichment-targets?target_type=unknown",
      "https://metagraph.sh/api/v1/subnets/7/health?status=alive",
    ];

    for (const url of routes) {
      const response = await handleRequest(new Request(url), env, {});
      assert.equal(response.status, 400, url);
      assert.equal(
        response.headers.get("x-metagraph-error-code"),
        "invalid_query",
      );
      assert.equal((await response.json()).error.code, "invalid_query");
    }
  });
});

describe("Agent discovery surfaces", () => {
  test("homepage serves HTML with RFC 8288 Link headers (no env needed)", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/"),
      {},
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const link = response.headers.get("link");
    assert.match(link, /rel="api-catalog"/);
    assert.match(link, /rel="service-desc"/);
    assert.match(link, /rel="service-doc"/);
    assert.match(await response.text(), /metagraphed API/);
  });

  test("homepage HEAD returns the Link header with an empty body", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/", { method: "HEAD" }),
      {},
      {},
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("link"), /rel="api-catalog"/);
    assert.equal(await response.text(), "");
  });

  test("/.well-known/api-catalog is a valid RFC 9727 linkset", async () => {
    const response = await handleRequest(
      new Request("https://api.metagraph.sh/.well-known/api-catalog"),
      {},
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/linkset+json",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json();
    assert.equal(Array.isArray(body.linkset), true);
    const context = body.linkset[0];
    // Anchor + the relations the API-catalog spec requires (service-desc,
    // service-doc); each target carries an absolute href on the request origin.
    assert.equal(context.anchor, "https://api.metagraph.sh/api/v1");
    assert.equal(
      context["service-desc"][0].href,
      "https://api.metagraph.sh/metagraph/openapi.json",
    );
    assert.equal(
      context["service-doc"][0].href,
      "https://api.metagraph.sh/llms.txt",
    );
    assert.equal(context.status[0].href, "https://api.metagraph.sh/health");
  });

  test("api-catalog hrefs are canonical (api.metagraph.sh), not the request host", async () => {
    // The apex (metagraph.sh) routes /.well-known/* to this worker too, so both
    // the linkset body AND the HTTP Link header must reference the real API host
    // regardless of which host served the request — origin-relative refs would
    // resolve to metagraph.sh (the wrong host).
    const response = await handleRequest(
      new Request("https://metagraph.sh/.well-known/api-catalog"),
      {},
      {},
    );
    const body = await response.json();
    assert.equal(body.linkset[0].anchor, "https://api.metagraph.sh/api/v1");
    assert.equal(
      body.linkset[0]["service-desc"][0].href,
      "https://api.metagraph.sh/metagraph/openapi.json",
    );
    const link = response.headers.get("link");
    assert.match(
      link,
      /<https:\/\/api\.metagraph\.sh\/metagraph\/openapi\.json>; rel="service-desc"/,
    );
    // No origin-relative refs that would resolve to the apex host.
    assert.doesNotMatch(link, /<\/[a-z.]/);
  });
});
