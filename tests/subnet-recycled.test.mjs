import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  RECYCLED_KV_TTL,
  RECYCLED_NEGATIVE_KV_TTL,
  RECYCLED_RPC_TIMEOUT_MS,
  loadSubnetRecycled,
} from "../src/subnet-recycled.ts";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/sudo-key.test.mjs / tests/account-balance.test.mjs.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// Live-confirmed 2026-07-09 against finney (bittensor 10.4.0,
// substrate.create_storage_key("SubtensorModule", "RAORecycledForRegistration",
// [101]) + a raw state_getStorage RPC call, cross-checked against the
// high-level substrate.query(...) value AND the SubtensorModule::
// RAORecycledForRegistrationSet event emitted at the same block/extrinsic —
// see docs/block-explorer-data-model.md's pallet-audit section.
const GOLDEN_NETUID = 101;
const GOLDEN_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf05550675ef84d5b014be06eda8faa54a78fb6500";
const GOLDEN_RAW_STORAGE = "0x626ac0f623000000"; // little-endian u64 for 154463660642 rao
const GOLDEN_TAO = 154.463660642;

describe("loadSubnetRecycled", () => {
  test("decodes the little-endian u64 storage result to TAO (golden value)", async () => {
    const orig = globalThis.fetch;
    let seenKey;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      seenKey = body.params[0];
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_RAW_STORAGE,
        }),
      };
    };
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(seenKey, GOLDEN_STORAGE_KEY);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, GOLDEN_TAO);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("computes the correct storage key suffix for other netuids", async () => {
    const cases = [
      [1, "0100"],
      [4, "0400"],
      [0, "0000"],
      [65535, "ffff"],
    ];
    for (const [netuid, suffix] of cases) {
      const orig = globalThis.fetch;
      let seenKey;
      globalThis.fetch = async (_url, init) => {
        seenKey = JSON.parse(init.body).params[0];
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      };
      try {
        await loadSubnetRecycled({}, netuid);
        assert.equal(
          seenKey,
          "0x658faa385070e074c85bf6b568cf05550675ef84d5b014be06eda8faa54a78fb" +
            suffix,
          `netuid=${netuid}`,
        );
      } finally {
        globalThis.fetch = orig;
      }
    }
  });

  test("a zero-registration subnet decodes the chain's own zeroed default to a real 0", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: "0x0000000000000000",
      }),
    });
    try {
      const data = await loadSubnetRecycled({}, 999);
      assert.equal(data.recycled_tao, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("a genuinely unset storage result (raw null) reads as a real 0, not a failure", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    });
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("recycled_tao is null when the RPC response is not ok", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("recycled_tao is null when finney RPC times out", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    };
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, null);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("recycled_tao is null on a malformed (non-16-hex) storage result", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
    });
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      netuid: GOLDEN_NETUID,
      recycled_tao: GOLDEN_TAO,
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
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: false };
    };
    try {
      const data = await loadSubnetRecycled(env, GOLDEN_NETUID);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("rejects out-of-range netuids before KV or RPC work", async () => {
    let kvReads = 0;
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => {
          kvReads += 1;
          return null;
        },
      },
    };

    await withFetchStub(
      async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      async () => {
        await assert.rejects(
          () => loadSubnetRecycled(env, 65536),
          /0\.\.65535/,
        );
        assert.equal(kvReads, 0);
        assert.equal(fetchCalls, 0);
      },
    );
  });

  test("KV cache key is scoped per netuid", async () => {
    let sawKey;
    const env = {
      METAGRAPH_CONTROL: {
        async get(key) {
          sawKey = key;
          return null;
        },
        async put() {},
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      await loadSubnetRecycled(env, 42);
      assert.equal(sawKey, "recycled:42");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("positive-caches a successful RPC result with the 600s TTL", async () => {
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
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: GOLDEN_RAW_STORAGE,
      }),
    });
    try {
      await loadSubnetRecycled(env, GOLDEN_NETUID);
      assert.equal(putKey, `recycled:${GOLDEN_NETUID}`);
      assert.equal(putValue.recycled_tao, GOLDEN_TAO);
      assert.equal(putOptions.expirationTtl, RECYCLED_KV_TTL);
      assert.equal(RECYCLED_KV_TTL, 600);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("negative-caches RPC failures with the short TTL", async () => {
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
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      await loadSubnetRecycled(env, GOLDEN_NETUID);
      assert.equal(putOptions.expirationTtl, RECYCLED_NEGATIVE_KV_TTL);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal;
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      seenSignal = init?.signal;
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_RAW_STORAGE,
        }),
      };
    };
    try {
      await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(RECYCLED_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const data = await loadSubnetRecycled({}, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, null);
      assert.equal(data.schema_version, 1);
    } finally {
      globalThis.fetch = orig;
    }
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
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: GOLDEN_RAW_STORAGE }),
    });
    try {
      const data = await loadSubnetRecycled(env, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, GOLDEN_TAO);
    } finally {
      globalThis.fetch = orig;
    }
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
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: GOLDEN_RAW_STORAGE }),
    });
    try {
      const data = await loadSubnetRecycled(env, GOLDEN_NETUID);
      assert.equal(data.recycled_tao, GOLDEN_TAO);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("GET /api/v1/subnets/{netuid}/recycled via the Worker", () => {
  test("returns the decoded recycled TAO total for a successful RPC read", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_RAW_STORAGE,
        }),
      }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/subnets/${GOLDEN_NETUID}/recycled`),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.schema_version, 1);
        assert.equal(body.data.netuid, GOLDEN_NETUID);
        assert.equal(body.data.recycled_tao, GOLDEN_TAO);
        assert.ok(body.data.queried_at);
        assert.ok(res.headers.get("etag"));
        assert.ok(res.headers.get("x-metagraph-contract-version"));
      },
    );
  });

  test("returns 200 with recycled_tao:null on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/subnets/${GOLDEN_NETUID}/recycled`),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.recycled_tao, null);
      },
    );
  });

  test("rejects out-of-range u16 netuids before rate limiting or RPC fetch", async () => {
    let limiterCalls = 0;
    let fetchCalls = 0;
    const env = {
      RPC_RATE_LIMITER: {
        limit: async () => {
          limiterCalls += 1;
          return { success: true };
        },
      },
    };

    await withFetchStub(
      async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      async () => {
        const res = await handleRequest(
          req("/api/v1/subnets/65536/recycled"),
          env,
          {},
        );
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, "invalid_netuid");
        assert.match(body.error.message, /0\.\.65535/);
        assert.equal(limiterCalls, 0);
        assert.equal(fetchCalls, 0);
      },
    );
  });

  test("accepts the maximum u16 netuid", async () => {
    let rpcStorageKey;
    await withFetchStub(
      async (_url, init) => {
        const body = JSON.parse(init.body);
        rpcStorageKey = body.params[0];
        return {
          ok: true,
          json: async () => ({ result: GOLDEN_RAW_STORAGE }),
        };
      },
      async () => {
        const res = await handleRequest(
          req("/api/v1/subnets/65535/recycled"),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.netuid, 65535);
        assert.ok(rpcStorageKey.endsWith("ffff"));
      },
    );
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/testnet/subnets/${GOLDEN_NETUID}/recycled`),
          {},
          {},
        );
        assert.equal(res.status, 404);
      },
    );
  });

  test("applies per-client RPC rate limiting", async () => {
    let limiterKey;
    let fetchCalls = 0;
    const env = {
      RPC_RATE_LIMITER: {
        limit: async ({ key }) => {
          limiterKey = key;
          return { success: false };
        },
      },
    };
    await withFetchStub(
      async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      async () => {
        const res = await handleRequest(
          new Request(
            `https://api.metagraph.sh/api/v1/subnets/${GOLDEN_NETUID}/recycled`,
            { headers: { "cf-connecting-ip": "203.0.113.9" } },
          ),
          env,
          {},
        );
        assert.equal(res.status, 429);
        assert.equal(limiterKey, `recycled:203.0.113.9`);
        assert.equal(fetchCalls, 0);
        assert.equal(res.headers.get("x-ratelimit-limit"), "100");
        assert.equal(res.headers.get("retry-after"), "60");
      },
    );
  });

  test("proceeds to the live RPC when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: {
        limit: async () => ({ success: true }),
      },
    };
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ result: GOLDEN_RAW_STORAGE }),
      }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/subnets/${GOLDEN_NETUID}/recycled`),
          env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.recycled_tao, GOLDEN_TAO);
      },
    );
  });
});
