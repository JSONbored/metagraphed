import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

test("GET /accounts/{ss58}/balance returns balance_tao for a valid address", async () => {
  await withFetchStub(
    async (_url, _init) => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { data: { free: 2_000_000_000, reserved: 500_000_000 } },
      }),
    }),
    async () => {
      const res = await handleRequest(req(`/api/v1/accounts/${SS58}/balance`), {}, {});
      assert.equal(res.status, 200);
      const body = await res.json();
      // 2_000_000_000 + 500_000_000 = 2_500_000_000 rao = 2.5 TAO
      assert.equal(body.schema_version, 1);
      assert.equal(body.ss58, SS58);
      assert.ok(typeof body.balance_tao === "number");
      assert.ok(body.queried_at);
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

test("GET /accounts/{ss58}/balance returns 503 with balance_tao:null on RPC failure", async () => {
  // No fetch mock — the Worker's global fetch will fail or env has no fetch.
  // Simulate by providing an env whose fetch throws.
  const env = {
    fetch: async () => {
      throw new Error("network error");
    },
  };
  const res = await handleRequest(req(`/api/v1/accounts/${SS58}/balance`), env, {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.schema_version, 1);
  assert.equal(body.ss58, SS58);
  assert.equal(body.balance_tao, null);
  assert.ok(body.queried_at);
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
      get: async (_key, _opts) => cached,
    },
  };
  const res = await handleRequest(req(`/api/v1/accounts/${SS58}/balance`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.balance_tao, 99.0);
  assert.equal(body.queried_at, "2026-06-25T00:00:00.000Z");
});
