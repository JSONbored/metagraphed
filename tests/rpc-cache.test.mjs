import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest, rpcCachePolicy } from "../workers/api.mjs";

describe("rpcCachePolicy", () => {
  const c = (m, p) => rpcCachePolicy(m, p);

  test("block-pinned reads are cacheable long", () => {
    assert.deepEqual(c("chain_getBlockHash", [100]), {
      cacheable: true,
      ttl: 3600,
    });
    assert.deepEqual(c("chain_getBlock", ["0xabc"]), {
      cacheable: true,
      ttl: 3600,
    });
    assert.deepEqual(c("chain_getHeader", ["0xabc"]), {
      cacheable: true,
      ttl: 3600,
    });
  });

  test("head-moving / param-less reads are NOT cacheable", () => {
    assert.equal(c("chain_getBlockHash", []).cacheable, false);
    assert.equal(c("chain_getBlock", []).cacheable, false);
    assert.equal(c("chain_getHeader", []).cacheable, false);
    assert.equal(c("chain_getFinalizedHead", []).cacheable, false);
    assert.equal(c("system_health", []).cacheable, false);
  });

  test("quasi-static reads are cacheable medium", () => {
    assert.deepEqual(c("state_getRuntimeVersion", []), {
      cacheable: true,
      ttl: 300,
    });
    assert.deepEqual(c("system_version", []), { cacheable: true, ttl: 300 });
    assert.deepEqual(c("rpc_methods", []), { cacheable: true, ttl: 300 });
  });

  test("unknown methods default-deny", () => {
    assert.equal(c("foo_bar", []).cacheable, false);
  });
});

describe("RPC response cache flow", () => {
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
  const env = {
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
  const reqFor = (method, params) =>
    new Request("https://metagraph.sh/rpc/v1/finney", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  function makeCache() {
    const store = new Map();
    return {
      store,
      async match(req) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, resp) {
        store.set(req.url, resp);
      },
    };
  }

  function withGlobals({ cache, fetchImpl }, run) {
    const originalCaches = globalThis.caches;
    const originalFetch = globalThis.fetch;
    globalThis.caches = { default: cache };
    globalThis.fetch = fetchImpl;
    return Promise.resolve(run()).finally(() => {
      globalThis.caches = originalCaches;
      globalThis.fetch = originalFetch;
    });
  }

  test("caches a block-pinned read; second call is a hit (no upstream fetch)", async () => {
    const cache = makeCache();
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xhash" }),
        { status: 200 },
      );
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits = [];
      const ctx = { waitUntil: (p) => waits.push(p) };
      const r1 = await handleRequest(
        reqFor("chain_getBlockHash", [1]),
        env,
        ctx,
      );
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get("x-metagraph-rpc-cache"), "miss");
      await Promise.all(waits);
      assert.equal(fetchCount, 1);

      const r2 = await handleRequest(
        reqFor("chain_getBlockHash", [1]),
        env,
        ctx,
      );
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get("x-metagraph-rpc-cache"), "hit");
      assert.equal(fetchCount, 1, "cache hit must not call upstream");
      assert.equal((await r2.json()).result, "0xhash");
    });
  });

  test("does NOT cache a head-moving read", async () => {
    const cache = makeCache();
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { peers: 1 } }),
        { status: 200 },
      );
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      await handleRequest(reqFor("system_health", []), env, { waitUntil() {} });
      await handleRequest(reqFor("system_health", []), env, { waitUntil() {} });
      assert.equal(fetchCount, 2, "head-moving reads always hit upstream");
      assert.equal(cache.store.size, 0);
    });
  });

  test("does NOT cache a JSON-RPC error envelope", async () => {
    const cache = makeCache();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }),
        { status: 200 },
      );
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits = [];
      await handleRequest(reqFor("chain_getBlockHash", [1]), env, {
        waitUntil: (p) => waits.push(p),
      });
      await Promise.all(waits);
      assert.equal(cache.store.size, 0);
    });
  });
});
