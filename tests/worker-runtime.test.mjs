import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import worker, { handleRequest } from "../workers/api.mjs";

const env = createLocalArtifactEnv();

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
        ASSETS: {
          async fetch() {
            return new Response(
              JSON.stringify({
                schema_version: 1,
                generated_at: "1970-01-01T00:00:00.000Z",
                pools: [
                  {
                    id: "finney-rpc",
                    endpoints: [{ id: "bad", pool_eligible: false }],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
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
            ASSETS: {
              async fetch() {
                return new Response(
                  JSON.stringify({
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
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                );
              },
            },
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
      ASSETS: {
        async fetch() {
          return new Response(
            JSON.stringify({
              schema_version: 1,
              generated_at: "1970-01-01T00:00:00.000Z",
              pools: [{ id: "finney-rpc", endpoints }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
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
      const proxyEnv = {
        ...env,
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        ASSETS: {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/metagraph/rpc/pools.json") {
              return new Response(
                JSON.stringify({
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
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }
            return env.ASSETS.fetch(request);
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
      assert.equal(wssResponse.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("applies supported query filters across artifact families", async () => {
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
        "https://metagraph.sh/api/v1/subnets/7/health?status=ok",
        (body) =>
          body.data.surfaces.every(
            (surface) => surface.netuid === 7 && surface.status === "ok",
          ),
      ],
      [
        "https://metagraph.sh/api/v1/health/history/2026-06-06?limit=2",
        (body) =>
          body.data.date === "2026-06-06" &&
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
