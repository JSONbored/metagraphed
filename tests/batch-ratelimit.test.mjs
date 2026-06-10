import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

const env = createLocalArtifactEnv();
const get = (path) =>
  handleRequest(new Request(`https://metagraph.sh${path}`), env, {});

describe("batch subnet lookups (?netuids=)", () => {
  test("returns only the requested netuids", async () => {
    const res = await get("/api/v1/subnets?netuids=0,7&sort=netuid");
    assert.equal(res.status, 200);
    const body = await res.json();
    const netuids = body.data.subnets
      .map((s) => s.netuid)
      .sort((a, b) => a - b);
    assert.deepEqual(netuids, [0, 7]);
  });

  test("a single netuid works", async () => {
    const res = await get("/api/v1/subnets?netuids=7");
    assert.equal(res.status, 200);
    const netuids = (await res.json()).data.subnets.map((s) => s.netuid);
    assert.deepEqual(netuids, [7]);
  });

  test("rejects a malformed netuids value with 400 invalid_query", async () => {
    const res = await get("/api/v1/subnets?netuids=abc");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_query");
  });

  test("the single netuid filter still works alongside", async () => {
    const res = await get("/api/v1/subnets?netuid=7");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.subnets[0].netuid, 7);
  });
});

describe("RPC proxy rate-limit headers", () => {
  const pool = {
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
  const rpcEnv = {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/metagraph/rpc/pools.json") {
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
  };

  test("a successful proxied response carries the advisory rate-limit headers", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { peers: 1 } }),
        { status: 200 },
      );
    try {
      const res = await handleRequest(
        new Request("https://metagraph.sh/rpc/v1/finney", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "system_health",
            params: [],
          }),
        }),
        rpcEnv,
        {},
      );
      assert.notEqual(res.status, 501);
      assert.equal(res.headers.get("x-ratelimit-limit"), "100");
      assert.equal(res.headers.get("x-ratelimit-policy"), "100;w=60");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a rate-limited request returns 429 with Retry-After + policy", async () => {
    const limitedEnv = {
      ...rpcEnv,
      RPC_RATE_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    };
    const res = await handleRequest(
      new Request("https://metagraph.sh/rpc/v1/finney", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "system_health",
          params: [],
        }),
      }),
      limitedEnv,
      {},
    );
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "rpc_rate_limited");
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  });
});
