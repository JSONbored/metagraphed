import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ADDRESS_MAPPING_KV_TTL,
  ADDRESS_MAPPING_NEGATIVE_KV_TTL,
  ADDRESS_MAPPING_RPC_TIMEOUT_MS,
  H160_PATTERN,
  loadAddressMapping,
} from "../src/address-mapping.ts";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Mirrors withFetchStub in tests/sudo-key.test.mjs / tests/account-balance.test.mjs.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

const H160 = "0x0000000000000000000000000000000000000001";
// The AccountId32 <-> SS58 encoding math is verified independently in
// tests/ss58.test.mjs and tests/sudo-key.test.mjs (same golden pair, a
// different RPC method entirely) -- reused here to check THIS module's own
// eth_call-result parsing + encoding, not a claim about what this specific
// H160 maps to on the real chain.
const GOLDEN_ETH_CALL_RESULT =
  "0x4471816662ea3cfadc9868e5f083e26a3be6706b8d8dad7fbef565983afb3556";
const GOLDEN_SS58 = "5DcSqBNqCmfdJZRGFSwwcRb2dZdJHZuKK8Tb1Gx8gbmF5E8s";

describe("H160_PATTERN", () => {
  test("matches a well-formed 20-byte address", () => {
    assert.ok(H160_PATTERN.test(H160));
  });

  test("rejects malformed addresses", () => {
    assert.equal(H160_PATTERN.test("not-an-address"), false);
    assert.equal(H160_PATTERN.test("0x1234"), false);
    assert.equal(
      H160_PATTERN.test("0000000000000000000000000000000000000001"),
      false,
    );
  });
});

describe("loadAddressMapping", () => {
  test("SS58-encodes the eth_call result (golden value)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.method, "eth_call");
      assert.equal(
        body.params[0].to,
        "0x000000000000000000000000000000000000080c",
      );
      assert.ok(body.params[0].data.startsWith("0x"));
      assert.equal(body.params[1], "latest");
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_ETH_CALL_RESULT,
        }),
      };
    };
    try {
      const data = await loadAddressMapping({}, H160);
      assert.equal(data.schema_version, 1);
      assert.equal(data.h160, H160);
      assert.equal(data.ss58, GOLDEN_SS58);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("lowercases h160 in the response", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
    });
    try {
      const data = await loadAddressMapping(
        {},
        "0x0000000000000000000000000000000000000ABC",
      );
      assert.equal(data.h160, "0x0000000000000000000000000000000000000abc");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("ss58 is null when the RPC response is not ok", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      const data = await loadAddressMapping({}, H160);
      assert.equal(data.ss58, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("ss58 is null on a malformed (non-64-hex) eth_call result", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: "0xnotvalid" }),
    });
    try {
      const data = await loadAddressMapping({}, H160);
      assert.equal(data.ss58, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("ss58 is null when finney RPC times out", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    };
    try {
      const data = await loadAddressMapping({}, H160);
      assert.equal(data.ss58, null);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      h160: H160,
      ss58: GOLDEN_SS58,
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
      const data = await loadAddressMapping(env, H160);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("positive-caches a successful RPC result with the long (1h) TTL", async () => {
    let putKey;
    let putValue;
    let putOptions;
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
      json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
    });
    try {
      await loadAddressMapping(env, H160);
      assert.equal(putKey, `evm-address-mapping:${H160}`);
      assert.equal(putValue.ss58, GOLDEN_SS58);
      assert.equal(putOptions.expirationTtl, ADDRESS_MAPPING_KV_TTL);
      assert.equal(ADDRESS_MAPPING_KV_TTL, 3600);
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
      await loadAddressMapping(env, H160);
      assert.equal(putOptions.expirationTtl, ADDRESS_MAPPING_NEGATIVE_KV_TTL);
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
        json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
      };
    };
    try {
      await loadAddressMapping({}, H160);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(ADDRESS_MAPPING_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe when fetch throws unexpectedly (no throw)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const data = await loadAddressMapping({}, H160);
      assert.equal(data.ss58, null);
      assert.equal(data.schema_version, 1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe when a KV read throws (falls through to RPC)", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("kv down");
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
    });
    try {
      const data = await loadAddressMapping(env, H160);
      assert.equal(data.ss58, GOLDEN_SS58);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe when a KV write throws (result still returned)", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("kv down");
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
    });
    try {
      const data = await loadAddressMapping(env, H160);
      assert.equal(data.ss58, GOLDEN_SS58);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("GET /api/v1/evm/address/{h160} via the Worker", () => {
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
          new Request(`https://api.metagraph.sh/api/v1/evm/address/${H160}`, {
            headers: { "cf-connecting-ip": "203.0.113.9" },
          }),
          env,
          {},
        );
        assert.equal(res.status, 429);
        assert.equal(limiterKey, `evm-address-mapping:203.0.113.9`);
        assert.equal(fetchCalls, 0);
        assert.equal(res.headers.get("retry-after"), "60");
      },
    );
  });

  test("proceeds when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
      }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/evm/address/${H160}`),
          env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.ss58, GOLDEN_SS58);
      },
    );
  });

  test("returns the SS58-encoded mapping for a successful RPC read", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ result: GOLDEN_ETH_CALL_RESULT }),
      }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/evm/address/${H160}`),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.schema_version, 1);
        assert.equal(body.data.h160, H160);
        assert.equal(body.data.ss58, GOLDEN_SS58);
        assert.ok(body.data.queried_at);
        assert.ok(res.headers.get("etag"));
        assert.ok(res.headers.get("x-metagraph-contract-version"));
      },
    );
  });

  test("returns 200 with ss58:null on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req(`/api/v1/evm/address/${H160}`),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.ss58, null);
      },
    );
  });

  test("returns 400 for a malformed h160 (route pattern is deliberately loose)", async () => {
    // EVM_ADDRESS_MAPPING_PATH_PATTERN captures any non-slash segment (same
    // looseness as ACCOUNT_BALANCE_PATH_PATTERN), so this reaches
    // handleEvmAddressMapping's own H160_PATTERN guard rather than falling
    // through to a generic "no route matched" 404.
    const res = await handleRequest(
      req("/api/v1/evm/address/not-an-address"),
      {},
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_h160");
  });
});
