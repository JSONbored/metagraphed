import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUDO_KEY_KV_TTL,
  SUDO_KEY_NEGATIVE_KV_TTL,
  SUDO_KEY_RPC_TIMEOUT_MS,
  loadSudoKey,
} from "../src/sudo-key.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv, type Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/account-balance.test.mjs.
function withFetchStub(stub: typeof fetch, fn: () => unknown) {
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
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: GOLDEN_RAW_STORAGE,
      }),
    })) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
      assert.equal(data.hotkey, GOLDEN_SS58);
      assert.equal(data.schema_version, 1);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when the sudo key storage is genuinely unset", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    })) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
      assert.equal(data.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when the RPC response is not ok", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
      assert.equal(data.hotkey, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null when finney RPC times out", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
      assert.equal(data.hotkey, null);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("hotkey is null on a malformed (non-64-hex) storage result", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
    })) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
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
    const env: Row = {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    };
    let fetchCalled = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: false };
    }) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(env as unknown as Env);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("positive-caches a successful RPC result with the long (1h) TTL", async () => {
    let putKey: string | undefined;
    let putValue: Row | undefined;
    let putOptions: Row | undefined;
    const env: Row = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(key: string, value: string, options: Row) {
          putKey = key;
          putValue = JSON.parse(value);
          putOptions = options;
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: GOLDEN_RAW_STORAGE,
      }),
    })) as unknown as typeof fetch;
    try {
      await loadSudoKey(env as unknown as Env);
      assert.equal(putKey, "sudo:key");
      assert.equal(putValue!.hotkey, GOLDEN_SS58);
      assert.equal(putOptions!.expirationTtl, SUDO_KEY_KV_TTL);
      assert.equal(SUDO_KEY_KV_TTL, 3600);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("negative-caches RPC failures with the short TTL", async () => {
    let putOptions: Row | undefined;
    const env: Row = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key: string, _value: string, options: Row) {
          putOptions = options;
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    try {
      await loadSudoKey(env as unknown as Env);
      assert.equal(putOptions!.expirationTtl, SUDO_KEY_NEGATIVE_KV_TTL);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal: AbortSignal | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_RAW_STORAGE,
        }),
      };
    }) as unknown as typeof fetch;
    try {
      await loadSudoKey(mockEnv());
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal!.aborted, "boolean");
      assert.equal(SUDO_KEY_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe without KV or fetch bindings behaving unexpectedly (no throw)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      const data = await loadSudoKey(mockEnv());
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
      (async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: GOLDEN_RAW_STORAGE,
        }),
      })) as unknown as typeof fetch,
      async () => {
        const res = await handleRequest(
          req("/api/v1/sudo/key"),
          {} as unknown as Env,
          {},
        );
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
      (async () => ({ ok: false })) as unknown as typeof fetch,
      async () => {
        const res = await handleRequest(
          req("/api/v1/sudo/key"),
          {} as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.hotkey, null);
      },
    );
  });
});
