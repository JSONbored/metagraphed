import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  accountInfoTotalRao,
  BALANCE_NEGATIVE_KV_TTL,
  BALANCE_RPC_TIMEOUT_MS,
  isFinneySs58Address,
  loadAccountBalance,
  systemAccountStorageKey,
} from "../src/account-balance.ts";
import { mockEnv, type Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// A SCALE-encoded AccountInfo blob: nonce/consumers/providers/sufficients
// (u32 LE each) then AccountData's free + reserved (u128 LE each).
function accountInfoHex(freeRao: bigint, reservedRao: bigint): string {
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

describe("isFinneySs58Address", () => {
  test("accepts a valid finney address", () => {
    assert.equal(isFinneySs58Address(SS58), true);
  });

  test("rejects malformed captures", () => {
    assert.equal(isFinneySs58Address("notanss58address"), false);
    assert.equal(
      isFinneySs58Address("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXc6TYeyZ1km1"),
      false,
    );
  });

  test("rejects a finney-shaped address with a bad SS58 checksum", () => {
    // Same prefix/length as SS58 but last base58 digit flipped → checksum mismatch.
    const badChecksum = `${SS58.slice(0, -1)}4`;
    assert.notEqual(badChecksum, SS58);
    assert.equal(isFinneySs58Address(badChecksum), false);
  });
});

describe("systemAccountStorageKey", () => {
  test("derives twox128(System)++twox128(Account)++blake2_128Concat(accountId)", () => {
    const accountId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = systemAccountStorageKey(accountId);
    // 0x + 32-byte prefix + 16-byte blake2_128 + 32-byte accountId = 160 hex chars.
    assert.equal(key.length, 2 + 64 + 32 + 64);
    assert.match(
      key,
      /^0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9/,
    );
    // blake2_128Concat appends the raw key, so the accountId is the tail verbatim.
    assert.ok(
      key.endsWith(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      ),
    );
  });
});

describe("accountInfoTotalRao", () => {
  test("sums free + reserved from a SCALE AccountInfo blob", () => {
    assert.equal(accountInfoTotalRao({ result: accountInfoHex(7n, 3n) }), 10n);
  });

  test("treats an absent storage entry as a zero balance", () => {
    assert.equal(accountInfoTotalRao({ result: null }), 0n);
  });

  test("returns null for an RPC error, a missing body, or a non-string result", () => {
    assert.equal(accountInfoTotalRao({ error: { code: -32601 } }), null);
    assert.equal(accountInfoTotalRao(null), null);
    assert.equal(accountInfoTotalRao({ result: 42 }), null);
  });

  test("returns null for a truncated or non-hex blob", () => {
    assert.equal(accountInfoTotalRao({ result: "0xdeadbeef" }), null);
    assert.equal(accountInfoTotalRao({ result: "0xzz" }), null);
    assert.equal(accountInfoTotalRao({ result: "0x123" }), null);
    assert.equal(accountInfoTotalRao({ result: "0x" }), null);
  });

  test("tolerates a blob without the 0x prefix", () => {
    assert.equal(
      accountInfoTotalRao({ result: accountInfoHex(7n, 3n).slice(2) }),
      10n,
    );
  });
});

describe("loadAccountBalance", () => {
  test("reads System::Account storage and sums free + reserved into TAO", async () => {
    const orig = globalThis.fetch;
    let sentBody: Row | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: accountInfoHex(2_000_000_000n, 500_000_000n),
        }),
      };
    }) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(), SS58);
      assert.equal(data.ss58, SS58);
      assert.equal(data.balance_tao, 2.5);
      // #6506: system_account is not a real RPC method — the loader must do a
      // raw System::Account storage read instead.
      assert.equal(sentBody!.method, "state_getStorage");
      assert.match(sentBody!.params[0], /^0x26aa394eea5630e07c48ae0c9558cef7/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("returns balance_tao:null for an address that isn't a decodable ss58", async () => {
    // Routes shape-check with isFinneySs58Address first, but the loader itself
    // must stay schema-stable rather than throw if handed a bad address.
    const orig = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return { ok: true, json: async () => ({ result: null }) };
    }) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(), "notavalidss58address");
      assert.equal(data.balance_tao, null);
      assert.equal(
        fetched,
        false,
        "must not query the node without an AccountId",
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("resolves a never-seen account (no storage entry) to 0, not null", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
    })) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(), SS58);
      assert.equal(data.balance_tao, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("returns balance_tao:null when the node reports an RPC error", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      }),
    })) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(), SS58);
      assert.equal(data.balance_tao, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("serves from KV cache when present", async () => {
    const cached = {
      schema_version: 1,
      ss58: SS58,
      balance_tao: 9.99,
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
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: false };
    }) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(env), SS58);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("negative-caches RPC failures with the short TTL", async () => {
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
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
    })) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(env), SS58);
      assert.equal(data.balance_tao, null);
      assert.equal(putKey, `balance:${SS58}`);
      assert.equal(putValue!.balance_tao, null);
      assert.equal(putOptions!.expirationTtl, BALANCE_NEGATIVE_KV_TTL);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("returns balance_tao:null when finney RPC times out (#2075)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (
      _url: unknown,
      init: RequestInit | undefined,
    ) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    try {
      const data = await loadAccountBalance(mockEnv(), SS58);
      assert.equal(data.ss58, SS58);
      assert.equal(data.balance_tao, null);
      assert.ok(data.queried_at);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (
      _url: unknown,
      init: RequestInit | undefined,
    ) => {
      seenSignal = init?.signal;
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { data: { free: 1_000_000_000, reserved: 0 } },
        }),
      };
    }) as unknown as typeof fetch;
    try {
      await loadAccountBalance(mockEnv(), SS58);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal!.aborted, "boolean");
      assert.equal(BALANCE_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
