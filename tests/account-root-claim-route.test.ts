import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("GET /accounts/{ss58}/root-claim returns 400 for an invalid ss58", async () => {
  const res = await handleRequest(
    req("/api/v1/accounts/notanss58address/root-claim"),
    {},
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_ss58");
});

test("GET /accounts/{ss58}/root-claim returns null fields on RPC failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("rpc down");
    }),
  );
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/root-claim`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ss58, SS58);
  assert.equal(body.data.claim_type, null);
  assert.equal(body.data.hotkeys, null);
  assert.ok(body.data.queried_at);
});

test("GET /accounts/{ss58}/root-claim applies per-client RPC rate limiting", async () => {
  const env = {
    RPC_RATE_LIMITER: {
      async limit() {
        return { success: false };
      },
    },
  };
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/root-claim`, {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    }),
    env,
    {},
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "root_claim_rate_limited");
});

test("GET /accounts/{ss58}/root-claim proceeds when the RPC rate limiter allows", async () => {
  let limiterKey: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("rpc down");
    }),
  );
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/root-claim`, {
      headers: { "cf-connecting-ip": "9.9.9.9" },
    }),
    {
      RPC_RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          limiterKey = key;
          return { success: true };
        },
      },
    },
    {},
  );
  assert.equal(res.status, 200);
  assert.match(limiterKey!, /^root-claim:/);
  assert.equal((await res.json()).data.hotkeys, null);
});

test("GET /accounts/{ss58}/root-claim serves from KV cache", async () => {
  const cached = {
    schema_version: 1,
    ss58: SS58,
    claim_type: { kind: "Swap" },
    hotkeys: [],
    queried_at: "2026-07-20T00:00:00.000Z",
  };
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/root-claim`),
    {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    },
    {},
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, cached);
  assert.equal(fetchSpy.mock.calls.length, 0);
});
