import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest, rpcCachePolicy } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

describe("rpcCachePolicy", () => {
  const c = (m: string, p: unknown) => rpcCachePolicy(m, p);

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

  test("named (non-array) params are never cacheable", () => {
    // The cache key is positional, so an object params cannot be represented
    // in it -- keying it as [] would let one caller's named-param answer be
    // served to a later positional caller (#8805).
    assert.equal(
      c("state_getRuntimeVersion", { at: "0xdead" }).cacheable,
      false,
    );
    assert.equal(c("system_chain", { at: "0xdead" }).cacheable, false);
    assert.equal(c("system_version", "0xdead").cacheable, false);
    assert.equal(c("chain_getBlock", { hash: "0xabc" }).cacheable, false);
    // Absent/null params IS the empty positional list, not named params.
    assert.deepEqual(c("state_getRuntimeVersion", undefined), {
      cacheable: true,
      ttl: 300,
    });
    assert.deepEqual(c("state_getRuntimeVersion", null), {
      cacheable: true,
      ttl: 300,
    });
    // Positional block-pinned reads keep their existing policy unchanged.
    assert.deepEqual(c("chain_getBlockHash", [100]), {
      cacheable: true,
      ttl: 3600,
    });
    assert.deepEqual(c("chain_getBlock", ["0xabc"]), {
      cacheable: true,
      ttl: 3600,
    });
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
      async fetch(request: Request) {
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
  const reqFor = (
    method: string,
    params: unknown,
    id: number | string = 1,
    network = "finney",
  ) =>
    new Request(`https://metagraph.sh/rpc/v1/${network}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

  function makeCache() {
    const store = new Map<string, Response>();
    return {
      store,
      async match(req: Request) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req: Request, resp: Response) {
        store.set(req.url, resp);
      },
    };
  }

  function withGlobals(
    { cache, fetchImpl }: { cache: Row; fetchImpl: typeof fetch },
    run: () => unknown,
  ) {
    const originalCaches = (globalThis as Row).caches;
    const originalFetch = globalThis.fetch;
    (globalThis as Row).caches = { default: cache };
    globalThis.fetch = fetchImpl;
    return Promise.resolve(run()).finally(() => {
      (globalThis as Row).caches = originalCaches;
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
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      const r1 = await handleRequest(
        reqFor("chain_getBlockHash", [1]),
        env as unknown as Env,
        ctx,
      );
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get("x-metagraph-rpc-cache"), "miss");
      await Promise.all(waits);
      assert.equal(fetchCount, 1);

      const r2 = await handleRequest(
        reqFor("chain_getBlockHash", [1]),
        env as unknown as Env,
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
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      const r1 = await handleRequest(
        reqFor("chain_getBlockHash", [999999999]),
        env as unknown as Env,
        ctx,
      );
      assert.equal(r1.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await r1.json()).result, null);
      await Promise.all(waits);
      assert.equal(cache.store.size, 0, "a null result must never be cached");

      const r2 = await handleRequest(
        reqFor("chain_getBlockHash", [999999999]),
        env as unknown as Env,
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
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      fetchCount += 1;
      const upstreamRequest = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: upstreamRequest.id,
          result: "0xhash",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      const primed = await handleRequest(
        reqFor("chain_getBlockHash", [1], "attacker-prime-id"),
        env as unknown as Env,
        ctx,
      );
      assert.equal(primed.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await primed.json()).id, "attacker-prime-id");
      await Promise.all(waits);

      const victim = await handleRequest(
        reqFor("chain_getBlockHash", [1], "victim-expected-id"),
        env as unknown as Env,
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
    const seen: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      seen.push(String(url));
      const result = String(url).includes("test.finney.opentensor.ai")
        ? "TESTNET_CHAIN"
        : "FINNEY_CHAIN";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
      });
    };
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      const testnet = await handleRequest(
        reqFor("system_chain", [], "test-prime", "test"),
        env as unknown as Env,
        ctx,
      );
      assert.equal(testnet.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.equal((await testnet.json()).result, "TESTNET_CHAIN");
      await Promise.all(waits);

      const finney = await handleRequest(
        reqFor("system_chain", [], "finney-caller", "finney"),
        env as unknown as Env,
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
      await handleRequest(reqFor("system_health", []), env as unknown as Env, {
        waitUntil() {},
      });
      await handleRequest(reqFor("system_health", []), env as unknown as Env, {
        waitUntil() {},
      });
      assert.equal(fetchCount, 2, "head-moving reads always hit upstream");
      assert.equal(cache.store.size, 0);
    });
  });

  test("named params cannot poison the positional cache entry", async () => {
    // #8805: `params` was erased to [] in the cache key but forwarded verbatim
    // upstream, so an unauthenticated caller could store the runtime version
    // AT AN OLD BLOCK under the key every `params: []` caller reads, handing
    // them a stale specVersion/transactionVersion -- signing-payload inputs.
    const cache = makeCache();
    const specVersions: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const upstream = JSON.parse(init!.body as string);
      // Stand in for a node that honours named params: `at` an old block hash
      // yields that block's runtime version, positional yields the live one.
      const specVersion =
        !Array.isArray(upstream.params) && upstream.params?.at ? 100 : 300;
      specVersions.push(specVersion);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: upstream.id,
          result: { specVersion, transactionVersion: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await withGlobals({ cache, fetchImpl }, async () => {
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      };
      const primed = await handleRequest(
        reqFor("state_getRuntimeVersion", { at: "0xdeadbeef" }, "attacker"),
        env as unknown as Env,
        ctx,
      );
      assert.equal(primed.status, 200);
      // The named-param caller still gets their own correct answer -- the fix
      // withholds caching, it does not change what is proxied.
      assert.equal((await primed.json()).result.specVersion, 100);
      // Non-cacheable requests take the same bypass path as system_health:
      // no cache header at all, and nothing written to the store.
      assert.equal(primed.headers.get("x-metagraph-rpc-cache"), null);
      await Promise.all(waits);
      assert.equal(
        cache.store.size,
        0,
        "a named-param response must never be stored",
      );

      const victim = await handleRequest(
        reqFor("state_getRuntimeVersion", [], "victim"),
        env as unknown as Env,
        ctx,
      );
      assert.equal(victim.headers.get("x-metagraph-rpc-cache"), "miss");
      assert.deepEqual(
        specVersions,
        [100, 300],
        "the victim must reach upstream",
      );
      assert.deepEqual(await victim.json(), {
        jsonrpc: "2.0",
        id: "victim",
        result: { specVersion: 300, transactionVersion: 1 },
      });
      await Promise.all(waits);
      assert.equal(cache.store.size, 1, "the positional read is still cached");
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
      const waits: Promise<unknown>[] = [];
      await handleRequest(
        reqFor("chain_getBlockHash", [1]),
        env as unknown as Env,
        {
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        },
      );
      await Promise.all(waits);
      assert.equal(cache.store.size, 0);
    });
  });
});
