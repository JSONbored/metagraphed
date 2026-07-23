import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import type { AnyFn, Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string): Request {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after.
function withFetchStub(stub: AnyFn, fn: AnyFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// A SCALE-encoded AccountInfo blob (#6506): nonce/consumers/providers/sufficients
// (u32 LE each), then AccountData's free + reserved (u128 LE each).
function accountInfoHex(freeRao: bigint, reservedRao: bigint = 0n): string {
  const u128 = (value: bigint): string => {
    let hex = "";
    let rest = BigInt(value);
    for (let index = 0; index < 16; index += 1) {
      hex += Number(rest & 0xffn)
        .toString(16)
        .padStart(2, "0");
      rest >>= 8n;
    }
    return hex;
  };
  return `0x${"00000000".repeat(4)}${u128(freeRao)}${u128(reservedRao)}`;
}

test("GET /accounts/{ss58}/balance returns balance_tao for a valid address", async () => {
  await withFetchStub(
    async (_url: unknown, _init: unknown) => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        // SCALE AccountInfo (#6506): nonce/consumers/providers/sufficients
        // (u32 LE each), then free = 2_000_000_000 and reserved = 500_000_000
        // (u128 LE each) = 2_500_000_000 rao = 2.5 TAO.
        result:
          `0x${"00000000".repeat(4)}` +
          "00943577000000000000000000000000" +
          "0065cd1d000000000000000000000000",
      }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      // 2_000_000_000 + 500_000_000 = 2_500_000_000 rao = 2.5 TAO
      assert.equal(body.ok, true);
      assert.equal(body.schema_version, 1);
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.ss58, SS58);
      assert.ok(typeof body.data.balance_tao === "number");
      assert.ok(body.data.queried_at);
      // Cacheable envelope: weak ETag + contract-version header.
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("x-metagraph-contract-version"));
    },
  );
});

test("GET /accounts/{ss58}/balance returns 400 for an invalid ss58", async () => {
  const res = await handleRequest(
    req("/api/v1/accounts/notanss58address/balance"),
    {},
    {},
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_ss58");
});

test("GET /accounts/{ss58}/balance returns 400 for a too-short address", async () => {
  // 5 + 45 chars = 46 total — one short of minimum
  const short = "5" + "a".repeat(45);
  const res = await handleRequest(
    req(`/api/v1/accounts/${short}/balance`),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/balance rejects overlong base58 before rate limiting or RPC", async () => {
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
      const overlong = "5" + "a".repeat(4096);
      const res = await handleRequest(
        req(`/api/v1/accounts/${overlong}/balance`),
        env,
        {},
      );
      assert.equal(res.status, 400);
      assert.equal(limiterCalls, 0);
      assert.equal(fetchCalls, 0);
      const body = await res.json();
      assert.equal(body.error.code, "invalid_ss58");
    },
  );
});

test("GET /accounts/{ss58}/balance returns 200 with balance_tao:null on RPC failure", async () => {
  // The loader calls globalThis.fetch, so stub that to throw (#6506: this used to
  // pass only because the real RPC rejected the bogus system_account method).
  const res = await withFetchStub(
    async () => {
      throw new Error("network error");
    },
    () => handleRequest(req(`/api/v1/accounts/${SS58}/balance`), {}, {}),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.schema_version, 1);
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.balance_tao, null);
  assert.ok(body.data.queried_at);
});

test("GET /accounts/{ss58}/balance returns 200 with balance_tao:null on RPC timeout (#2075)", async () => {
  await withFetchStub(
    async (_url: unknown, init: RequestInit | undefined) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    },
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.ss58, SS58);
      assert.equal(body.data.balance_tao, null);
      assert.ok(body.data.queried_at);
    },
  );
});

test("GET /accounts/{ss58}/balance serves from KV cache when available", async () => {
  const cached = {
    schema_version: 1,
    ss58: SS58,
    balance_tao: 99.0,
    queried_at: "2026-06-25T00:00:00.000Z",
  };
  const env = {
    METAGRAPH_CONTROL: {
      get: async (_key: string, _opts: unknown) => cached,
    },
  };
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/balance`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.balance_tao, 99.0);
  assert.equal(body.data.queried_at, "2026-06-25T00:00:00.000Z");
});

test("GET /accounts/{ss58}/balance falls through on KV read failure", async () => {
  // KV.get throws → non-fatal, should fall through to RPC (which also fails here).
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => {
        throw new Error("kv error");
      },
    },
  };
  await withFetchStub(
    async () => {
      throw new Error("rpc down");
    },
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.balance_tao, null);
    },
  );
});

test("GET /accounts/{ss58}/balance decodes hex-encoded rao balances", async () => {
  // Real Bittensor RPC returns free+reserved as 0x-prefixed hex u128 strings.
  await withFetchStub(
    async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        // free 2_000_000_000 + reserved 500_000_000 rao = 2.5 TAO
        result: accountInfoHex(2_000_000_000n, 500_000_000n),
      }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      // 2_000_000_000 + 500_000_000 = 2_500_000_000 rao = 2.5 TAO
      assert.ok(typeof body.data.balance_tao === "number");
      assert.ok(body.data.balance_tao > 0);
    },
  );
});

test("GET /accounts/{ss58}/balance keeps u128 rao precision above 2^53 (#2070)", async () => {
  // A u128 `free` far above Number.MAX_SAFE_INTEGER rao. The pre-fix path
  // Number(BigInt(free)) / 1e9 collapses the low-order rao digits to the nearest
  // double *before* scaling; summing in BigInt and splitting whole/fractional TAO
  // at the very end preserves them. This magnitude is where the two paths diverge
  // as IEEE-754 doubles, so it doubles as a regression guard.
  const freeRao = 123_456_789_012_345_678_901n; // 0x6b14e9f812f366c35
  const exact =
    Number(freeRao / 1_000_000_000n) + Number(freeRao % 1_000_000_000n) / 1e9;
  const preFix = Number(freeRao) / 1e9; // what the old conversion produced
  assert.notEqual(exact, preFix); // sanity: the paths really differ at this scale
  await withFetchStub(
    async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: accountInfoHex(freeRao),
      }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.balance_tao, exact);
      assert.notEqual(body.data.balance_tao, preFix);
    },
  );
});

test("GET /accounts/{ss58}/balance returns null when RPC responds non-ok", async () => {
  await withFetchStub(
    async () => ({ ok: false }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.balance_tao, null);
    },
  );
});

test("GET /accounts/{ss58}/balance returns null when RPC data.free is absent", async () => {
  await withFetchStub(
    async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xdeadbeef" }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.balance_tao, null);
    },
  );
});

test("GET /accounts/{ss58}/balance writes to KV on successful RPC fetch", async () => {
  let putKey: string | undefined;
  let putValue: Row | undefined;
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => null, // cache miss → fall through to RPC
      put: async (key: string, value: string) => {
        putKey = key;
        putValue = JSON.parse(value);
      },
    },
  };
  await withFetchStub(
    async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: accountInfoHex(1_000_000_000n),
      }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      assert.equal(putKey, `balance:${SS58}`);
      assert.ok(typeof putValue!.balance_tao === "number");
    },
  );
});

test("GET /accounts/{ss58}/balance tolerates KV write failure", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async () => {
        throw new Error("kv write error");
      },
    },
  };
  await withFetchStub(
    async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: accountInfoHex(1_000_000_000n),
      }),
    }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        env,
        {},
      );
      // KV write failure is non-fatal — still returns the balance.
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.data.balance_tao === "number");
    },
  );
});

test("GET /accounts/{ss58}/balance rejects non-base58 captures before RPC", async () => {
  let fetchCalls = 0;
  await withFetchStub(
    async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    },
    async () => {
      const bad = "5" + "0".repeat(47);
      const res = await handleRequest(
        req(`/api/v1/accounts/${bad}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 400);
      assert.equal(fetchCalls, 0);
      const body = await res.json();
      assert.equal(body.error.code, "invalid_ss58");
    },
  );
});

test("GET /accounts/{ss58}/balance applies per-client RPC rate limiting", async () => {
  let limiterKey: string | undefined;
  let fetchCalls = 0;
  const env = {
    RPC_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
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
          `https://api.metagraph.sh/api/v1/accounts/${SS58}/balance`,
          {
            headers: { "cf-connecting-ip": "203.0.113.9" },
          },
        ),
        env,
        {},
      );
      assert.equal(res.status, 429);
      assert.equal(limiterKey, "balance:203.0.113.9");
      assert.equal(fetchCalls, 0);
      assert.equal(res.headers.get("x-ratelimit-limit"), "100");
    },
  );
});

test("GET /accounts/{ss58}/balance briefly negative-caches RPC failures", async () => {
  let putKey: string | undefined;
  let putValue: Row | undefined;
  let putOptions: Row | undefined;
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async (key: string, value: string, options: Row) => {
        putKey = key;
        putValue = JSON.parse(value);
        putOptions = options;
      },
    },
  };
  await withFetchStub(
    async () => ({ ok: false }),
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${SS58}/balance`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      assert.equal(putKey, `balance:${SS58}`);
      assert.equal(putValue!.balance_tao, null);
      assert.equal(putOptions!.expirationTtl, 10);
    },
  );
});

test("GET /accounts/{ss58}/balance rejects a base58 address with a non-finney network prefix (#1818)", async () => {
  // 48 base58 chars starting with '5' — this PASSES the OLD `^5[a-zA-Z0-9]{46,47}$`
  // guard — but decodes to SS58 network prefix 40, not finney's 42. The base58
  // decoder must reject it with a 400 before any RPC fan-out, which the loose
  // regex could not. Locks in the security value of the decoder over the regex.
  const wrongPrefix = `5${"1".repeat(47)}`;
  let fetched = false;
  await withFetchStub(
    async () => {
      fetched = true;
      throw new Error("must not reach the upstream RPC");
    },
    async () => {
      const res = await handleRequest(
        req(`/api/v1/accounts/${wrongPrefix}/balance`),
        {},
        {},
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, "invalid_ss58");
      assert.equal(fetched, false);
    },
  );
});
