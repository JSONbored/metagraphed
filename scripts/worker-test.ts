import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "./lib.ts";

// Live handler responses are read for assertion purposes only, never trusted
// for control flow. Mirrors the readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const env = createLocalArtifactEnv();

const head = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets", { method: "HEAD" }),
  env,
  {},
);
assert.equal(head.status, 200, "HEAD should return 200 for API artifacts");
assert.equal(await head.text(), "", "HEAD must not return a response body");
assert.ok(head.headers.get("etag"), "HEAD should include ETag");
assert.equal(
  head.headers.get("x-content-type-options"),
  "nosniff",
  "API responses should set nosniff",
);

const apiOptions = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets", { method: "OPTIONS" }),
  env,
  {},
);
assert.equal(apiOptions.status, 204, "API OPTIONS should return 204");
assert.equal(
  apiOptions.headers.get("access-control-allow-methods"),
  "GET, HEAD, OPTIONS",
);

const rpcOptions = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", { method: "OPTIONS" }),
  env,
  {},
);
assert.equal(rpcOptions.status, 204, "RPC OPTIONS should return 204");
assert.equal(
  rpcOptions.headers.get("access-control-allow-methods"),
  "POST, OPTIONS",
);

const apiPost = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets", { method: "POST" }),
  env,
  {},
);
assert.equal(
  apiPost.status,
  405,
  "POST should not be allowed for artifact API routes",
);
assert.equal(apiPost.headers.get("allow"), "GET, HEAD, OPTIONS");
assert.equal(((await apiPost.json()) as Row).error.code, "method_not_allowed");

const unknown = await handleRequest(
  new Request("https://metagraph.sh/api/v1/does-not-exist"),
  env,
  {},
);
assert.equal(unknown.status, 404, "unknown API routes should return 404");
assert.equal(unknown.headers.get("x-metagraph-error-code"), "not_found");

const source = await handleRequest(
  new Request("https://metagraph.sh/api/v1/contracts"),
  env,
  {},
);
const cached = await handleRequest(
  new Request("https://metagraph.sh/api/v1/contracts", {
    headers: {
      "if-none-match": source.headers.get("etag"),
    },
  }),
  env,
  {},
);
assert.equal(cached.status, 304, "matching ETag should return 304");
assert.equal(await cached.text(), "", "304 should not return a body");

const r2Fallback = await handleRequest(
  new Request("https://metagraph.sh/api/v1/changelog"),
  {
    ASSETS: {
      async fetch() {
        return new Response("not found", { status: 404 });
      },
    },
    METAGRAPH_CONTROL: {
      async get(key: string) {
        assert.equal(key, "metagraph:latest");
        return { latest_prefix: "latest/" };
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        assert.equal(key, "latest/changelog.json");
        return {
          async json() {
            return {
              schema_version: 1,
              contract_version: CONTRACT_VERSION,
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
assert.equal(
  r2Fallback.status,
  200,
  "Worker should fall back to R2 with KV latest pointer",
);
assert.equal(((await r2Fallback.json()) as Row).meta.source, "r2");

const disabledRpc = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", { method: "POST" }),
  env,
  {},
);
assert.equal(disabledRpc.status, 501, "RPC proxy must be disabled by default");
assert.equal(
  ((await disabledRpc.json()) as Row).error.code,
  "rpc_proxy_disabled",
);

const invalidRpc = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", {
    method: "POST",
    body: "{not json",
  }),
  { ...env, METAGRAPH_ENABLE_RPC_PROXY: "true" },
  {},
);
assert.equal(invalidRpc.status, 400, "invalid JSON-RPC bodies should fail");

const blockedRpc = await handleRequest(
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
assert.equal(blockedRpc.status, 403, "unsafe RPC methods must be blocked");
assert.equal(
  ((await blockedRpc.json()) as Row).error.code,
  "rpc_method_blocked",
);

for (const unsafeUrl of [
  "http://127.0.0.1:9650/internal",
  "http://10.0.0.2:9650/internal",
  "http://169.254.169.254/latest/meta-data",
]) {
  let unsafeFetchCalled = false;
  const unsafeOriginalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    unsafeFetchCalled = true;
    throw new Error("unsafe endpoint should not be fetched");
  };

  try {
    const unsafePoolArtifact = {
      schema_version: 1,
      contract_version: CONTRACT_VERSION,
      generated_at: "1970-01-01T00:00:00.000Z",
      pools: [
        {
          id: "finney-rpc",
          kind: "subtensor-rpc",
          endpoint_count: 1,
          eligible_count: 1,
          endpoints: [
            {
              id: "unsafe-rpc",
              provider: "fixture",
              pool_eligible: true,
              score: 100,
              status: "ok",
              url: unsafeUrl,
            },
          ],
        },
      ],
    };
    const unsafeRpc = await handleRequest(
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
        ...env,
        METAGRAPH_ENABLE_RPC_PROXY: "true",
        ASSETS: {
          async fetch(request: Request) {
            const url = new URL(request.url);
            if (url.pathname === "/metagraph/rpc/pools.json") {
              return Response.json(unsafePoolArtifact);
            }
            return (env.ASSETS as Row).fetch(request);
          },
        },
        METAGRAPH_ARCHIVE: {
          async get(key: string) {
            assert.equal(key, "latest/rpc/pools.json");
            return {
              async json() {
                return unsafePoolArtifact;
              },
            };
          },
        },
      },
      {},
    );
    assert.equal(
      unsafeRpc.status,
      502,
      `unsafe endpoint ${unsafeUrl} should be rejected before fetch`,
    );
    assert.equal(
      ((await unsafeRpc.json()) as Row).error.code,
      "rpc_endpoint_unsafe",
    );
    assert.equal(
      unsafeFetchCalled,
      false,
      `unsafe endpoint ${unsafeUrl} should not reach fetch`,
    );
  } finally {
    globalThis.fetch = unsafeOriginalFetch;
  }
}

const originalFetch = globalThis.fetch;
let upstreamCalled = false;
globalThis.fetch = async (_url, init) => {
  upstreamCalled = true;
  assert.equal(init?.method, "POST");
  assert.equal(JSON.parse(init?.body as string).method, "chain_getHeader");
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1" } }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
};

try {
  const safePoolArtifact = {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    generated_at: "1970-01-01T00:00:00.000Z",
    pools: [
      {
        id: "finney-rpc",
        kind: "subtensor-rpc",
        endpoint_count: 1,
        eligible_count: 1,
        endpoints: [
          {
            id: "fixture-rpc",
            provider: "fixture",
            pool_eligible: true,
            score: 100,
            status: "ok",
            url: "https://bittensor-finney.api.onfinality.io/public",
          },
        ],
      },
    ],
  };
  const proxyEnv = {
    ...env,
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/metagraph/rpc/pools.json") {
          return Response.json(safePoolArtifact);
        }
        return (env.ASSETS as Row).fetch(request);
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        assert.equal(key, "latest/rpc/pools.json");
        return {
          async json() {
            return safePoolArtifact;
          },
        };
      },
    },
  };
  const proxied = await handleRequest(
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
  assert.equal(
    proxied.status,
    200,
    "safe RPC methods can be proxied when explicitly enabled",
  );
  assert.equal(
    upstreamCalled,
    true,
    "safe RPC proxy should call an eligible upstream",
  );
  assert.ok(
    proxied.headers.get("x-metagraph-rpc-provider"),
    "proxied responses should expose provider metadata",
  );

  const wssRejected = await handleRequest(
    new Request("https://metagraph.sh/rpc/v1/finney/wss", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "system_health",
        params: [],
      }),
    }),
    proxyEnv,
    {},
  );
  assert.equal(
    wssRejected.status,
    400,
    "the /wss route is not HTTP-proxyable and must be rejected, not 500",
  );
  assert.equal(
    ((await wssRejected.json()) as Row).error.code,
    "rpc_websocket_unsupported",
  );
} finally {
  globalThis.fetch = originalFetch;
}

// Edge-cache (Cloudflare Cache API): pure static-artifact GETs are cached and
// served on repeat; live-overlay routes (e.g. /api/v1/health) are never cached
// so live operational status can never go stale; conditional GETs still 304.
{
  const store = new Map<string, Response>();
  let puts = 0;
  let matchHits = 0;
  const originalCaches = (globalThis as Row).caches;
  (globalThis as Row).caches = {
    default: {
      async match(req: Request) {
        const r = store.get(req.url);
        if (r) matchHits += 1;
        return r ? r.clone() : undefined;
      },
      async put(req: Request, res: Response) {
        puts += 1;
        store.set(req.url, res.clone());
      },
    },
  };
  const cacheCtx = { waitUntil: (p: Promise<unknown>) => p };
  try {
    // Pure static-artifact route: cached on first GET, served from cache after.
    const first = await handleRequest(
      new Request("https://metagraph.sh/api/v1/schemas"),
      env,
      cacheCtx,
    );
    await Promise.resolve();
    const firstBody = await first.text();
    const etag = first.headers.get("etag");
    assert.equal(first.status, 200, "schemas GET should be 200");
    assert.equal(puts, 1, "a pure-artifact 200 GET should be cached");
    assert.equal(matchHits, 0, "first GET is a cache miss");

    const second = await handleRequest(
      new Request("https://metagraph.sh/api/v1/schemas"),
      env,
      cacheCtx,
    );
    assert.equal(
      matchHits,
      1,
      "repeat GET should be served from the edge cache",
    );
    assert.equal(
      await second.text(),
      firstBody,
      "cached response body must match the original",
    );

    // Conditional GET against the cached body's weak ETag → 304 (no body).
    const conditional = await handleRequest(
      new Request("https://metagraph.sh/api/v1/schemas", {
        headers: { "if-none-match": etag },
      }),
      env,
      cacheCtx,
    );
    assert.equal(conditional.status, 304, "if-none-match hit should 304");
    assert.equal(await conditional.text(), "", "304 must have no body");

    // Live-overlay route MUST NOT be cached — live operational health stays fresh.
    const putsBeforeHealth = puts;
    const health = await handleRequest(
      new Request("https://metagraph.sh/api/v1/health"),
      env,
      cacheCtx,
    );
    await Promise.resolve();
    assert.equal(health.status, 200, "health GET should be 200");
    assert.equal(
      puts,
      putsBeforeHealth,
      "live-overlay routes (health) must never be edge-cached",
    );

    // Non-GET methods are never cached.
    const putsBeforeHead = puts;
    await handleRequest(
      new Request("https://metagraph.sh/api/v1/schemas", { method: "HEAD" }),
      env,
      cacheCtx,
    );
    await Promise.resolve();
    assert.equal(
      puts,
      putsBeforeHead,
      "non-GET requests must not be edge-cached",
    );
  } finally {
    (globalThis as Row).caches = originalCaches;
  }
}

console.log("Worker runtime tests passed.");
