import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

// Network-aware proxy routing: /rpc/v1/{network} selects its pool from
// rpc/pools.json (finney → finney-rpc, test → test-rpc). The testnet endpoints
// are a static pool (test.finney.opentensor.ai is in TRUSTED_RPC_UPSTREAM_ORIGINS).
describe("RPC proxy — network-aware pool selection", () => {
  const pools = {
    pools: [
      {
        id: "finney-rpc",
        endpoints: [
          {
            id: "fx",
            provider: "onfinality",
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
            id: "opentensor-test-finney-rpc",
            provider: "opentensor",
            pool_eligible: true,
            status: "unknown",
            score: 100,
            url: "https://test.finney.opentensor.ai",
          },
        ],
      },
    ],
  };
  const env = {
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    METAGRAPH_ARCHIVE: {
      async get() {
        return {
          async json() {
            return pools;
          },
        };
      },
    },
  };
  const reqFor = (network) =>
    new Request(`https://metagraph.sh/rpc/v1/${network}`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "system_health",
        params: [],
      }),
    });

  function withFetch(capture, run) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      capture.push(url);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        { status: 200 },
      );
    };
    return Promise.resolve(run()).finally(() => {
      globalThis.fetch = original;
    });
  }

  test("/rpc/v1/test routes to the test-rpc pool's testnet upstream", async () => {
    const seen = [];
    await withFetch(seen, async () => {
      const res = await handleRequest(reqFor("test"), env, { waitUntil() {} });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("x-metagraph-rpc-endpoint-id"),
        "opentensor-test-finney-rpc",
      );
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], "https://test.finney.opentensor.ai");
  });

  test("/rpc/v1/finney still routes to the finney pool", async () => {
    const seen = [];
    await withFetch(seen, async () => {
      const res = await handleRequest(reqFor("finney"), env, {
        waitUntil() {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-metagraph-rpc-endpoint-id"), "fx");
    });
    assert.equal(seen[0], "https://bittensor-finney.api.onfinality.io/public");
  });

  test("an unknown network 404s instead of falling back to mainnet", async () => {
    const seen = [];
    await withFetch(seen, async () => {
      const res = await handleRequest(reqFor("mainnet"), env, {
        waitUntil() {},
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, "rpc_network_unsupported");
      assert.deepEqual(body.meta.supported_networks, ["finney", "test"]);
    });
    assert.equal(seen.length, 0); // never reached an upstream
  });
});
