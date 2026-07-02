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
      {
        id: "test-rpc",
        endpoints: [
          {
            id: "tx",
            provider: "tx",
            pool_eligible: true,
            status: "ok",
            score: 100,
            url: "https://test.finney.opentensor.ai",
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
  const reqFor = (method, params, id = 1, network = "finney") =>
    new Request(`https://metagraph.sh/rpc/v1/${network}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
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

  test("a null result (block not produced yet) is never cached", async () => {
    // chain_getBlockHash(N) returns result:null until block N exists. Caching
    // that under the 3600s block-read TTL would replay the stale null after the
    // block is produced. The first (null) call must not be cached, so the second
    // call re-queries upstream and returns the now-available real hash.
    const cache = makeCache();
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      const result = fetchCount === 1 ? null : "0xrealhash";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
      });
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits = [];
      const ctx = { waitUntil: (p) => waits.push(p) };
      const r1 = await handleRequest(
        reqFor("chain_getBlockHash", [999999999]),
        env,
        ctx,
      );
      assert.equal(r1.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await r1.json()).result, null);
      await Promise.all(waits);
      assert.equal(cache.store.size, 0, "a null result must never be cached");

      const r2 = await handleRequest(
        reqFor("chain_getBlockHash", [999999999]),
        env,
        ctx,
      );
      assert.equal(r2.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal(
        fetchCount,
        2,
        "second call must re-query upstream, not replay null",
      );
      assert.equal((await r2.json()).result, "0xrealhash");
    });
  });

  test("cache hits preserve the current request id (no cross-caller replay)", async () => {
    const cache = makeCache();
    let fetchCount = 0;
    const fetchImpl = async (_url, init) => {
      fetchCount += 1;
      const upstreamRequest = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: upstreamRequest.id,
          result: "0xhash",
        }),
        { status: 200 },
      );
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits = [];
      const ctx = { waitUntil: (p) => waits.push(p) };
      const primed = await handleRequest(
        reqFor("chain_getBlockHash", [1], "attacker-prime-id"),
        env,
        ctx,
      );
      assert.equal(primed.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await primed.json()).id, "attacker-prime-id");
      await Promise.all(waits);

      const victim = await handleRequest(
        reqFor("chain_getBlockHash", [1], "victim-expected-id"),
        env,
        ctx,
      );
      assert.equal(victim.headers.get("x-metagraph-rpc-cache"), "hit");
      assert.equal(fetchCount, 1, "cache hit must not call upstream");
      assert.deepEqual(await victim.json(), {
        jsonrpc: "2.0",
        id: "victim-expected-id",
        result: "0xhash",
      });
    });
  });

  test("cache entries are isolated by RPC network", async () => {
    const cache = makeCache();
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      const result = url.includes("test.finney.opentensor.ai")
        ? "TESTNET_CHAIN"
        : "FINNEY_CHAIN";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
      });
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits = [];
      const ctx = { waitUntil: (p) => waits.push(p) };
      const testnet = await handleRequest(
        reqFor("system_chain", [], "test-prime", "test"),
        env,
        ctx,
      );
      assert.equal(testnet.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await testnet.json()).result, "TESTNET_CHAIN");
      await Promise.all(waits);

      const finney = await handleRequest(
        reqFor("system_chain", [], "finney-caller", "finney"),
        env,
        ctx,
      );
      assert.equal(finney.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await finney.json()).result, "FINNEY_CHAIN");
      assert.equal(seen.length, 2, "finney must not reuse testnet cache entry");
      assert.equal(cache.store.size, 2);
      assert.ok(
        [...cache.store.keys()].some((key) =>
          key.includes("/test/system_chain/"),
        ),
      );
      assert.ok(
        [...cache.store.keys()].some((key) =>
          key.includes("/finney/system_chain/"),
        ),
      );
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
