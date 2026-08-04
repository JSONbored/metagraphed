// #8700: the live chain-storage routes, served on every network with chain
// state.
//
// The load-bearing property here is ISOLATION. These routes read a live chain
// and cache the answer in KV, so the failure that matters is not a 404 — it is
// a testnet answer served to a mainnet caller, or the reverse. That is
// near-invisible in production (both responses are well-formed, only the
// numbers are wrong), so it is pinned here at the two points where a network
// can leak: the RPC endpoint the read goes to, and the KV key the result is
// stored under.
//
// The second property is that the derived route list cannot drift from the
// router. LIVE_CHAIN_ROUTE_PATHS feeds the capability matrix; if the dispatcher
// gains a route that the list does not know about, the matrix silently starts
// reporting a working route as unserved.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest, isMainnetOnlyApiPath } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { API_ROUTES } from "../src/contracts.ts";
import {
  LIVE_CHAIN_ROUTE_PATHS,
  isLiveChainRouteTemplate,
} from "../src/live-chain-routes.ts";
import {
  CHAIN_RPC_URLS,
  chainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "../src/chain-network.ts";
import { concretePath } from "./concrete-path.ts";
import type { Row } from "./row-type.ts";

const ORIGIN = "https://api.metagraph.sh";

/**
 * An env whose fetch is stubbed, so no test here touches a real chain.
 *
 * Every RPC call is recorded with the URL it went to. `kv` records every key
 * read and written. Between them these two logs are the whole isolation
 * assertion: which chain did we ask, and where did we put the answer.
 */
function recordingEnv() {
  const rpcUrls: string[] = [];
  const kvGets: string[] = [];
  const kvPuts: string[] = [];
  const env = createLocalArtifactEnv() as Row;
  env.METAGRAPH_CONTROL = {
    get(key: string) {
      kvGets.push(key);
      return Promise.resolve(null);
    },
    put(key: string) {
      kvPuts.push(key);
      return Promise.resolve();
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : String((input as URL).href ?? input);
    if (url.includes("opentensor.ai")) {
      rpcUrls.push(url);
      // A well-formed "storage is unset" answer: exercises the decode path
      // without inventing chain values the assertions would then depend on.
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    env,
    rpcUrls,
    kvGets,
    kvPuts,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function get(env: Row, pathname: string) {
  const res = await handleRequest(
    new Request(`${ORIGIN}${pathname}`),
    env as unknown as Env,
    {},
  );
  let body: Row | null;
  try {
    body = JSON.parse(await res.clone().text());
  } catch {
    body = null;
  }
  return { res, body: body as Row };
}

describe("chain-network resolution (#8700)", () => {
  test("mainnet keeps the exact URL and the un-prefixed KV key", () => {
    // The zero-regression guarantee. Mainnet must resolve to the same endpoint
    // and the same cache key it used before networks existed, so entries
    // written by the previous deploy stay readable and no mainnet request
    // changes behaviour.
    assert.equal(
      rpcUrlForNetwork(),
      "https://entrypoint-finney.opentensor.ai:443",
    );
    assert.equal(rpcUrlForNetwork("mainnet"), CHAIN_RPC_URLS.mainnet);
    assert.equal(networkKvKey("burn:1"), "burn:1");
    assert.equal(networkKvKey("burn:1", "mainnet"), "burn:1");
  });

  test("testnet resolves to its own endpoint and its own keyspace", () => {
    assert.equal(rpcUrlForNetwork("testnet"), CHAIN_RPC_URLS.testnet);
    assert.notEqual(CHAIN_RPC_URLS.testnet, CHAIN_RPC_URLS.mainnet);
    assert.equal(networkKvKey("burn:1", "testnet"), "testnet:burn:1");
  });

  test("an unknown or local network falls back to mainnet, never to undefined", () => {
    // `local` never reaches a loader (handleNetworkScopedRequest answers it
    // first), but a resolver that returned undefined here would produce
    // `fetch(undefined)` rather than a clean degrade if that ever changed.
    assert.equal(chainNetworkId("local"), "mainnet");
    assert.equal(chainNetworkId(undefined), "mainnet");
    assert.equal(chainNetworkId("nonsense"), "mainnet");
    assert.equal(chainNetworkId("testnet"), "testnet");
  });
});

describe("the live-chain route list is derived from the router", () => {
  test("every listed route is served on testnet, and none is mainnet-only", () => {
    for (const template of LIVE_CHAIN_ROUTE_PATHS) {
      assert.equal(
        isMainnetOnlyApiPath(concretePath(template)),
        false,
        `${template} is in LIVE_CHAIN_ROUTE_PATHS but the router still gates it as mainnet-only`,
      );
    }
  });

  test("no route outside the list is silently live-chain", async () => {
    // The other direction: a route added to dispatchLiveChainRoute without
    // being added to the list would answer on testnet while the capability
    // matrix reported it unserved. Catching that needs a real request, since
    // the dispatcher is not exported.
    const { env, restore } = recordingEnv();
    try {
      const wrong: string[] = [];
      for (const route of API_ROUTES as { path: string }[]) {
        if (isLiveChainRouteTemplate(route.path)) continue;
        if (!isMainnetOnlyApiPath(concretePath(route.path))) continue;
        const { res } = await get(
          env,
          `/api/v1/testnet${concretePath(route.path).replace("/api/v1", "")}`,
        );
        if (res.status !== 404) {
          wrong.push(`${route.path} answered ${res.status} on testnet`);
        }
      }
      assert.deepEqual(wrong, []);
    } finally {
      restore();
    }
  });

  test("the list is sorted and free of duplicates", () => {
    // Not cosmetic: this list is read by a human deciding whether a route is
    // covered, and a duplicate would quietly mask a missing entry.
    const sorted = [...LIVE_CHAIN_ROUTE_PATHS].sort();
    assert.deepEqual([...LIVE_CHAIN_ROUTE_PATHS], sorted);
    assert.equal(
      new Set(LIVE_CHAIN_ROUTE_PATHS).size,
      LIVE_CHAIN_ROUTE_PATHS.length,
    );
  });
});

describe("network isolation on the live routes", () => {
  test("a testnet request reads the testnet RPC and writes only testnet keys", async () => {
    const { env, rpcUrls, kvGets, kvPuts, restore } = recordingEnv();
    try {
      const { res } = await get(env, "/api/v1/testnet/subnets/1/burn");
      assert.equal(res.status, 200);
      assert.ok(rpcUrls.length > 0, "no RPC call was made");
      for (const url of rpcUrls) {
        assert.ok(
          url.startsWith(CHAIN_RPC_URLS.testnet),
          `testnet request hit ${url}`,
        );
      }
      for (const key of [...kvGets, ...kvPuts]) {
        assert.ok(
          key.startsWith("testnet:"),
          `testnet request touched un-namespaced KV key ${key}`,
        );
      }
    } finally {
      restore();
    }
  });

  test("a mainnet request reads finney and writes un-prefixed keys", async () => {
    const { env, rpcUrls, kvGets, kvPuts, restore } = recordingEnv();
    try {
      const { res } = await get(env, "/api/v1/subnets/1/burn");
      assert.equal(res.status, 200);
      assert.ok(rpcUrls.length > 0, "no RPC call was made");
      for (const url of rpcUrls) {
        assert.ok(
          url.startsWith(CHAIN_RPC_URLS.mainnet),
          `mainnet request hit ${url}`,
        );
      }
      for (const key of [...kvGets, ...kvPuts]) {
        assert.ok(
          !key.startsWith("testnet:"),
          `mainnet request touched testnet KV key ${key}`,
        );
      }
    } finally {
      restore();
    }
  });

  test("the two networks never share a cache key for the same resource", async () => {
    const mainnet = recordingEnv();
    let mainnetKeys: string[];
    try {
      await get(mainnet.env, "/api/v1/subnets/1/burn");
      mainnetKeys = [...mainnet.kvGets, ...mainnet.kvPuts];
    } finally {
      mainnet.restore();
    }
    const testnet = recordingEnv();
    let testnetKeys: string[];
    try {
      await get(testnet.env, "/api/v1/testnet/subnets/1/burn");
      testnetKeys = [...testnet.kvGets, ...testnet.kvPuts];
    } finally {
      testnet.restore();
    }
    assert.ok(mainnetKeys.length > 0 && testnetKeys.length > 0);
    const shared = mainnetKeys.filter((key) => testnetKeys.includes(key));
    assert.deepEqual(
      shared,
      [],
      `the same KV key is used by both networks: ${shared.join(", ")}`,
    );
  });

  test("every live route answers on testnet with the same shape as mainnet", async () => {
    const { env, restore } = recordingEnv();
    try {
      for (const template of LIVE_CHAIN_ROUTE_PATHS) {
        const suffix = concretePath(template).replace("/api/v1", "");
        const mainnet = await get(env, `/api/v1${suffix}`);
        const testnet = await get(env, `/api/v1/testnet${suffix}`);
        assert.equal(
          testnet.res.status,
          mainnet.res.status,
          `${template}: mainnet ${mainnet.res.status} vs testnet ${testnet.res.status}`,
        );
        assert.deepEqual(
          Object.keys(testnet.body?.data ?? {}).sort(),
          Object.keys(mainnet.body?.data ?? {}).sort(),
          `${template}: response shape differs between networks`,
        );
      }
    } finally {
      restore();
    }
  });
});
