import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BALANCE_NEGATIVE_KV_TTL,
  BALANCE_RPC_TIMEOUT_MS,
  isFinneySs58Address,
  loadAccountBalance,
} from "../src/account-balance.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

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

describe("loadAccountBalance", () => {
  test("decodes hex-encoded rao balances from finney RPC", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { data: { free: "0x77359400", reserved: "0x1dcd6500" } },
      }),
    });
    try {
      const data = await loadAccountBalance({}, SS58);
      assert.equal(data.ss58, SS58);
      assert.equal(data.balance_tao, 2.5);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("decodes numeric rao balances from finney RPC", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { data: { free: 2_000_000_000, reserved: 500_000_000 } },
      }),
    });
    try {
      const data = await loadAccountBalance({}, SS58);
      assert.equal(data.balance_tao, 2.5);
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
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: false };
    };
    try {
      const data = await loadAccountBalance(env, SS58);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("negative-caches RPC failures with the short TTL", async () => {
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
    globalThis.fetch = async () => ({ ok: false });
    try {
      const data = await loadAccountBalance(env, SS58);
      assert.equal(data.balance_tao, null);
      assert.equal(putKey, `balance:${SS58}`);
      assert.equal(putValue.balance_tao, null);
      assert.equal(putOptions.expirationTtl, BALANCE_NEGATIVE_KV_TTL);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("returns balance_tao:null when finney RPC times out (#2075)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    };
    try {
      const data = await loadAccountBalance({}, SS58);
      assert.equal(data.ss58, SS58);
      assert.equal(data.balance_tao, null);
      assert.ok(data.queried_at);
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
          result: { data: { free: 1_000_000_000, reserved: 0 } },
        }),
      };
    };
    try {
      await loadAccountBalance({}, SS58);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(BALANCE_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
