import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  RANDOMNESS_KV_TTL,
  RANDOMNESS_NEGATIVE_KV_TTL,
  RANDOMNESS_RPC_TIMEOUT_MS,
  loadRandomnessStatus,
} from "../src/randomness.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import type { Row, AnyFn } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/network-parameters.test.mjs / tests/sudo-key.test.mjs.
function withFetchStub(stub: AnyFn, fn: AnyFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// Golden round numbers, little-endian u64-encoded (round 5,000,000 /
// 4,993,000 — arbitrary but internally consistent: span = 7001).
const GOLDEN_LAST_ROUND_RAW = "0x404b4c0000000000";
const GOLDEN_LAST_ROUND = 5_000_000;
const GOLDEN_OLDEST_ROUND_RAW = "0xe82f4c0000000000";
const GOLDEN_OLDEST_ROUND = 4_993_000;
const GOLDEN_SPAN = 7001;

const LAST_STORED_ROUND_KEY =
  "0xa285cdb66e8b8524ea70b1693c7b1e05087f3dd6e0ceded0e388dd34f810a73d";
const OLDEST_STORED_ROUND_KEY =
  "0xa285cdb66e8b8524ea70b1693c7b1e05bc30947083dc3a2cb9eb93b9db7c6fbd";

// Routes each of the 2 parallel state_getStorage calls to its own golden
// raw value by storage key, mirroring a real finney response.
function goldenFetchStub() {
  return async (_url: unknown, init: Row) => {
    const body = JSON.parse(init.body);
    const key = body.params[0];
    const byKey: Record<string, string> = {
      [LAST_STORED_ROUND_KEY]: GOLDEN_LAST_ROUND_RAW,
      [OLDEST_STORED_ROUND_KEY]: GOLDEN_OLDEST_ROUND_RAW,
    };
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: byKey[key] }),
    };
  };
}

describe("loadRandomnessStatus", () => {
  test("decodes both fields correctly and derives the round span (golden values)", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadRandomnessStatus(mockEnv());
      assert.equal(data.schema_version, 1);
      assert.equal(data.last_stored_round, GOLDEN_LAST_ROUND);
      assert.equal(data.oldest_stored_round, GOLDEN_OLDEST_ROUND);
      assert.equal(data.stored_round_span, GOLDEN_SPAN);
      assert.ok(data.queried_at);
    });
  });

  test("queries both storage keys", async () => {
    const seenKeys = new Set();
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        seenKeys.add(JSON.parse(init.body).params[0]);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadRandomnessStatus(mockEnv());
        assert.ok(seenKeys.has(LAST_STORED_ROUND_KEY));
        assert.ok(seenKeys.has(OLDEST_STORED_ROUND_KEY));
        assert.equal(seenKeys.size, 2);
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
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, 0);
        assert.equal(data.oldest_stored_round, 0);
        assert.equal(data.stored_round_span, 1);
      },
    );
  });

  test("both fields are null on a malformed (non-16-hex, non-null) storage result", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
      }),
      async () => {
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, null);
        assert.equal(data.oldest_stored_round, null);
        assert.equal(data.stored_round_span, null);
      },
    );
  });

  test("both fields are null when the RPC response is not ok", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, null);
        assert.equal(data.oldest_stored_round, null);
      },
    );
  });

  test("both fields are null when finney RPC times out", async () => {
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
        const err = new Error("The operation timed out.");
        err.name = "TimeoutError";
        throw err;
      },
      async () => {
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, null);
        assert.ok(data.queried_at);
      },
    );
  });

  test("a single field's failure does not blank the other, and the span stays null (no misleading partial span)", async () => {
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        const key = JSON.parse(init.body).params[0];
        if (key === OLDEST_STORED_ROUND_KEY) return { ok: false };
        return {
          ok: true,
          json: async () => ({ result: GOLDEN_LAST_ROUND_RAW }),
        };
      },
      async () => {
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, GOLDEN_LAST_ROUND);
        assert.equal(data.oldest_stored_round, null);
        assert.equal(data.stored_round_span, null);
      },
    );
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      last_stored_round: GOLDEN_LAST_ROUND,
      oldest_stored_round: GOLDEN_OLDEST_ROUND,
      stored_round_span: GOLDEN_SPAN,
      queried_at: "2026-01-01T00:00:00.000Z",
    };
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    } as unknown as Env;
    let fetchCalled = false;
    await withFetchStub(
      async () => {
        fetchCalled = true;
        return { ok: false };
      },
      async () => {
        const data = await loadRandomnessStatus(env);
        assert.deepEqual(data, cached);
        assert.equal(fetchCalled, false);
      },
    );
  });

  test("positive-caches a fully successful RPC result with the 30s TTL", async () => {
    let putKey: string | undefined;
    let putValue: Row | undefined;
    let putOptions: Row | undefined;
    const env = {
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
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      await loadRandomnessStatus(env);
      assert.equal(putKey, "network:randomness");
      assert.equal(putValue!.last_stored_round, GOLDEN_LAST_ROUND);
      assert.equal(putOptions!.expirationTtl, RANDOMNESS_KV_TTL);
      assert.equal(RANDOMNESS_KV_TTL, 30);
    });
  });

  test("negative-caches a partial RPC failure with the short TTL (does not cache stale-looking partial data)", async () => {
    let putOptions: Row | undefined;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key: string, _value: string, options: Row) {
          putOptions = options;
        },
      },
    } as unknown as Env;
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        const key = JSON.parse(init.body).params[0];
        if (key === OLDEST_STORED_ROUND_KEY) return { ok: false };
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadRandomnessStatus(env);
        assert.equal(putOptions!.expirationTtl, RANDOMNESS_NEGATIVE_KV_TTL);
      },
    );
  });

  test("passes AbortSignal.timeout to each finney fetch", async () => {
    const seenSignals: Row[] = [];
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        seenSignals.push(init?.signal);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadRandomnessStatus(mockEnv());
        assert.equal(seenSignals.length, 2);
        for (const signal of seenSignals) {
          assert.ok(signal);
          assert.equal(typeof signal.aborted, "boolean");
        }
        assert.equal(RANDOMNESS_RPC_TIMEOUT_MS, 5000);
      },
    );
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network down");
      },
      async () => {
        const data = await loadRandomnessStatus(mockEnv());
        assert.equal(data.last_stored_round, null);
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
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadRandomnessStatus(env);
      assert.equal(data.last_stored_round, GOLDEN_LAST_ROUND);
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
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadRandomnessStatus(env);
      assert.equal(data.last_stored_round, GOLDEN_LAST_ROUND);
    });
  });
});

describe("GET /api/v1/network/randomness via the Worker", () => {
  test("returns both decoded fields and the derived span for a successful RPC read", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const res = await handleRequest(
        req("/api/v1/network/randomness"),
        {} as unknown as Env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.last_stored_round, GOLDEN_LAST_ROUND);
      assert.equal(body.data.oldest_stored_round, GOLDEN_OLDEST_ROUND);
      assert.equal(body.data.stored_round_span, GOLDEN_SPAN);
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
          req("/api/v1/network/randomness"),
          {} as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.last_stored_round, null);
      },
    );
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/testnet/network/randomness"),
          {} as unknown as Env,
          {},
        );
        assert.equal(res.status, 404);
      },
    );
  });
});
