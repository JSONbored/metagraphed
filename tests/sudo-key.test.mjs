import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUDO_KEY_KV_TTL,
  SUDO_KEY_NEGATIVE_KV_TTL,
  SUDO_KEY_RPC_TIMEOUT_MS,
  loadSudoKey,
} from "../src/sudo-key.mjs";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/account-balance.test.mjs.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// Live-confirmed 2026-07-08 against finney (bittensor 10.5.0,
// substrate.create_storage_key("Sudo", "Key") + a raw state_getStorage RPC
// call, cross-checked against the high-level substrate.query("Sudo", "Key")
// value) — see docs/block-explorer-data-model.md's pallet-audit section.
const GOLDEN_RAW_STORAGE =
  "0x4471816662ea3cfadc9868e5f083e26a3be6706b8d8dad7fbef565983afb3556";
const GOLDEN_SS58 = "5DcSqBNqCmfdJZRGFSwwcRb2dZdJHZuKK8Tb1Gx8gbmF5E8s";

describe("loadSudoKey", () => {
  test("SS58-encodes the raw AccountId32 storage result (golden value)", async () => {
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
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, GOLDEN_SS58);
      assert.equal(data.schema_version, 1);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when the sudo key storage is genuinely unset", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    });
    try {
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when the RPC response is not ok", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when finney RPC times out", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    };
    try {
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, null);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null on a malformed (non-64-hex) storage result", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
    });
    try {
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      hotkey: GOLDEN_SS58,
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
      const data = await loadSudoKey(env);
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
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: GOLDEN_RAW_STORAGE,
      }),
    });
    try {
      await loadSudoKey(env);
      assert.equal(putKey, "sudo:key");
      assert.equal(putValue.hotkey, GOLDEN_SS58);
      assert.equal(putOptions.expirationTtl, SUDO_KEY_KV_TTL);
      assert.equal(SUDO_KEY_KV_TTL, 3600);
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
      await loadSudoKey(env);
      assert.equal(putOptions.expirationTtl, SUDO_KEY_NEGATIVE_KV_TTL);
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
      await loadSudoKey({});
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(SUDO_KEY_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe without KV or fetch bindings behaving unexpectedly (no throw)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const data = await loadSudoKey({});
      assert.equal(data.hotkey, null);
      assert.equal(data.schema_version, 1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("GET /api/v1/sudo/key via the Worker", () => {
  test("returns the SS58-encoded hotkey for a successful RPC read", async () => {
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
        const res = await handleRequest(req("/api/v1/sudo/key"), {}, {});
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.schema_version, 1);
        assert.equal(body.data.hotkey, GOLDEN_SS58);
        assert.ok(body.data.queried_at);
        // Cacheable envelope: weak ETag + contract-version header.
        assert.ok(res.headers.get("etag"));
        assert.ok(res.headers.get("x-metagraph-contract-version"));
      },
    );
  });

  test("returns 200 with hotkey:null on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(req("/api/v1/sudo/key"), {}, {});
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.hotkey, null);
      },
    );
  });
});
