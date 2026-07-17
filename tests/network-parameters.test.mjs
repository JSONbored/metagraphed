import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  NETWORK_PARAMETERS_KV_TTL,
  NETWORK_PARAMETERS_NEGATIVE_KV_TTL,
  NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
  loadNetworkParameters,
} from "../src/network-parameters.mjs";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/sudo-key.test.mjs / tests/subnet-burn.test.mjs.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// Live-confirmed 2026-07-17 against finney (bittensor 10.5.0,
// substrate.create_storage_key("SubtensorModule", <item>)) + raw
// state_getStorage RPC calls, cross-checked against the high-level
// substrate.query(...) values. TaoWeight's exact live value is governance-
// adjustable and will drift over time — the fixed-point DECODING these
// golden bytes exercise is what's pinned, not that TaoWeight will always be
// 0.18.
const GOLDEN_TAO_WEIGHT_RAW = "0x7a14ae47e17a142e";
const GOLDEN_TAO_WEIGHT = 0.18;
const GOLDEN_STAKE_THRESHOLD_RAW = "0x0010a5d4e8000000"; // 1e12 rao = 1000 TAO
const GOLDEN_STAKE_THRESHOLD_TAO = 1000;
const GOLDEN_COOLDOWN_RAW = "0x201c000000000000"; // 7200 blocks
const GOLDEN_COOLDOWN_BLOCKS = 7200;

const TAO_WEIGHT_KEY =
  "0x658faa385070e074c85bf6b568cf05556b2684762c3b1e22ffb4a92939298741";
const STAKE_THRESHOLD_KEY =
  "0x658faa385070e074c85bf6b568cf0555782d99ebaa64a1ba18b3e8cda1047327";
const COOLDOWN_KEY =
  "0x658faa385070e074c85bf6b568cf0555503e4fe5f139cae8b9d045e82e1c83a2";

// Routes each of the 3 parallel state_getStorage calls to its own golden
// raw value by storage key, mirroring a real finney response.
function goldenFetchStub() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const key = body.params[0];
    const byKey = {
      [TAO_WEIGHT_KEY]: GOLDEN_TAO_WEIGHT_RAW,
      [STAKE_THRESHOLD_KEY]: GOLDEN_STAKE_THRESHOLD_RAW,
      [COOLDOWN_KEY]: GOLDEN_COOLDOWN_RAW,
    };
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: byKey[key] }),
    };
  };
}

describe("loadNetworkParameters", () => {
  test("decodes all three fields correctly (golden values)", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters({});
      assert.equal(data.schema_version, 1);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(data.stake_threshold_tao, GOLDEN_STAKE_THRESHOLD_TAO);
      assert.equal(
        data.pending_childkey_cooldown_blocks,
        GOLDEN_COOLDOWN_BLOCKS,
      );
      assert.ok(data.queried_at);
    });
  });

  test("queries all three storage keys", async () => {
    const seenKeys = new Set();
    await withFetchStub(
      async (_url, init) => {
        seenKeys.add(JSON.parse(init.body).params[0]);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters({});
        assert.ok(seenKeys.has(TAO_WEIGHT_KEY));
        assert.ok(seenKeys.has(STAKE_THRESHOLD_KEY));
        assert.ok(seenKeys.has(COOLDOWN_KEY));
        assert.equal(seenKeys.size, 3);
      },
    );
  });

  test("a genuinely unset storage result (raw null) reads as a real 0, not a failure", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      }),
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, 0);
        assert.equal(data.stake_threshold_tao, 0);
        assert.equal(data.pending_childkey_cooldown_blocks, 0);
      },
    );
  });

  test("all fields are null on a malformed (non-16-hex, non-null) storage result", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
      }),
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
      },
    );
  });

  test("all fields are null when the RPC response is not ok", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
      },
    );
  });

  test("all fields are null when finney RPC times out", async () => {
    await withFetchStub(
      async (_url, init) => {
        assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
        const err = new Error("The operation timed out.");
        err.name = "TimeoutError";
        throw err;
      },
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
        assert.ok(data.queried_at);
      },
    );
  });

  test("a single field's failure does not blank the other two", async () => {
    await withFetchStub(
      async (_url, init) => {
        const key = JSON.parse(init.body).params[0];
        if (key === STAKE_THRESHOLD_KEY) {
          return { ok: false };
        }
        const byKey = {
          [TAO_WEIGHT_KEY]: GOLDEN_TAO_WEIGHT_RAW,
          [COOLDOWN_KEY]: GOLDEN_COOLDOWN_RAW,
        };
        return { ok: true, json: async () => ({ result: byKey[key] }) };
      },
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(
          data.pending_childkey_cooldown_blocks,
          GOLDEN_COOLDOWN_BLOCKS,
        );
      },
    );
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      tao_weight: GOLDEN_TAO_WEIGHT,
      stake_threshold_tao: GOLDEN_STAKE_THRESHOLD_TAO,
      pending_childkey_cooldown_blocks: GOLDEN_COOLDOWN_BLOCKS,
      queried_at: "2026-01-01T00:00:00.000Z",
    };
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    };
    let fetchCalled = false;
    await withFetchStub(
      async () => {
        fetchCalled = true;
        return { ok: false };
      },
      async () => {
        const data = await loadNetworkParameters(env);
        assert.deepEqual(data, cached);
        assert.equal(fetchCalled, false);
      },
    );
  });

  test("positive-caches a fully successful RPC result with the 300s TTL", async () => {
    let putKey, putValue, putOptions;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(key, value, options) {
          putKey = key;
          putValue = JSON.parse(value);
          putOptions = options;
        },
      },
    };
    await withFetchStub(goldenFetchStub(), async () => {
      await loadNetworkParameters(env);
      assert.equal(putKey, "network:parameters");
      assert.equal(putValue.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(putOptions.expirationTtl, NETWORK_PARAMETERS_KV_TTL);
      assert.equal(NETWORK_PARAMETERS_KV_TTL, 300);
    });
  });

  test("negative-caches a partial RPC failure with the short TTL (does not cache stale-looking partial data)", async () => {
    let putOptions;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key, _value, options) {
          putOptions = options;
        },
      },
    };
    await withFetchStub(
      async (_url, init) => {
        const key = JSON.parse(init.body).params[0];
        if (key === STAKE_THRESHOLD_KEY) return { ok: false };
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters(env);
        assert.equal(
          putOptions.expirationTtl,
          NETWORK_PARAMETERS_NEGATIVE_KV_TTL,
        );
      },
    );
  });

  test("passes AbortSignal.timeout to each finney fetch", async () => {
    const seenSignals = [];
    await withFetchStub(
      async (_url, init) => {
        seenSignals.push(init?.signal);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters({});
        assert.equal(seenSignals.length, 3);
        for (const signal of seenSignals) {
          assert.ok(signal);
          assert.equal(typeof signal.aborted, "boolean");
        }
        assert.equal(NETWORK_PARAMETERS_RPC_TIMEOUT_MS, 5000);
      },
    );
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network down");
      },
      async () => {
        const data = await loadNetworkParameters({});
        assert.equal(data.tao_weight, null);
        assert.equal(data.schema_version, 1);
      },
    );
  });

  test("a KV write failure is non-fatal", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("KV down");
        },
      },
    };
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(env);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
    });
  });

  test("a KV read failure falls through to the live RPC", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("KV down");
        },
        async put() {},
      },
    };
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(env);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
    });
  });
});

describe("GET /api/v1/network/parameters via the Worker", () => {
  test("returns all three decoded fields for a successful RPC read", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const res = await handleRequest(
        req("/api/v1/network/parameters"),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(body.data.stake_threshold_tao, GOLDEN_STAKE_THRESHOLD_TAO);
      assert.equal(
        body.data.pending_childkey_cooldown_blocks,
        GOLDEN_COOLDOWN_BLOCKS,
      );
      assert.ok(body.data.queried_at);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("x-metagraph-contract-version"));
    });
  });

  test("returns 200 with null fields on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/network/parameters"),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.tao_weight, null);
      },
    );
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/testnet/network/parameters"),
          {},
          {},
        );
        assert.equal(res.status, 404);
      },
    );
  });
});
