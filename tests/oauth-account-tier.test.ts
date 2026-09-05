// Unit tests for src/oauth-account-tier.ts (#11562) -- the lookup that lets an
// OAuth-authenticated caller resolve a real tier instead of falling through to
// "anonymous". The DATA_API service binding and KV are mocked the same way
// tests/tiered-rate-limit.test.ts mocks them.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { authLookupCacheWrite } from "../src/auth-lookup-cache.ts";
import {
  OAUTH_ACCOUNT_TIER_KV_TTL,
  OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL,
  oauthAccountIdFrom,
  resolveOAuthAccountTier,
} from "../src/oauth-account-tier.ts";
import type { Row } from "./row-type.ts";

interface KvPut {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function createFakeKv(seed: Row = {}) {
  const store = new Map<string, string>(
    Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const puts: KvPut[] = [];
  return {
    puts,
    async get(key: string, options?: { type?: string }) {
      if (!store.has(key)) return null;
      const raw = store.get(key)!;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) {
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
}

function envWith(
  body: Row | null,
  overrides: Row = {},
  status = 200,
): { env: Env; requests: Request[] } {
  const requests: Request[] = [];
  const env = {
    METAGRAPH_CONTROL: createFakeKv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
    DATA_API: {
      fetch: async (request: Request) => {
        requests.push(request);
        return new Response(body === null ? "nope" : JSON.stringify(body), {
          status,
        });
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, requests };
}

describe("oauthAccountIdFrom", () => {
  test("accepts a positive integer, as a number or a JSON-roundtripped string", () => {
    assert.equal(oauthAccountIdFrom(7), 7);
    assert.equal(oauthAccountIdFrom("7"), 7);
  });

  test("rejects everything that is not a positive integer", () => {
    // Each of these must resolve to "no identity", which the caller reads as
    // anonymous -- never as a permissive default.
    for (const value of [
      undefined,
      null,
      true,
      false,
      {},
      [],
      "",
      "abc",
      "7.5",
      7.5,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.equal(oauthAccountIdFrom(value), null, String(value));
    }
  });
});

describe("resolveOAuthAccountTier", () => {
  test("an unreadable account id never reaches the network", async () => {
    const { env, requests } = envWith({ found: true, tier: "paid" });
    assert.deepEqual(await resolveOAuthAccountTier(env, "not-an-id"), {
      found: false,
    });
    assert.equal(requests.length, 0);
  });

  test("resolves a tier and calls the internal route with the account id", async () => {
    const { env, requests } = envWith({ found: true, tier: "community" });
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: "community",
    });
    assert.equal(requests.length, 1);
    assert.equal(
      new URL(requests[0]!.url).pathname,
      "/api/v1/internal/accounts/github/tier",
    );
    assert.equal(
      requests[0]!.headers.get("x-api-key-lookup-token"),
      "test-lookup-token",
    );
    assert.deepEqual(await requests[0]!.json(), { account_id: 42 });
  });

  test("an account that exists with a null tier stays found", async () => {
    // "found with no tier" and "no such account" are different answers and the
    // caller branches on `found`, so they must not collapse into each other.
    const { env } = envWith({ found: true });
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: null,
    });
  });

  test("an unknown account is not found", async () => {
    const { env } = envWith({ found: false });
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), { found: false });
  });

  test("caches a hit under the account id, on the tier TTL", async () => {
    const kv = createFakeKv();
    const { env, requests } = envWith(
      { found: true, tier: "paid" },
      { METAGRAPH_CONTROL: kv },
    );
    await resolveOAuthAccountTier(env, 42);
    assert.equal(kv.puts.length, 1);
    assert.equal(kv.puts[0]!.key, "oauth-account-tier:v2:42");
    assert.equal(kv.puts[0]!.options?.expirationTtl, OAUTH_ACCOUNT_TIER_KV_TTL);
    assert.deepEqual(JSON.parse(kv.puts[0]!.value).record, {
      found: true,
      tier: "paid",
    });
    // Second call is served from cache -- no second round trip.
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: "paid",
    });
    assert.equal(requests.length, 1);
  });

  test("caches a miss on the SHORTER negative TTL", async () => {
    const kv = createFakeKv();
    const { env } = envWith({ found: false }, { METAGRAPH_CONTROL: kv });
    await resolveOAuthAccountTier(env, 42);
    assert.equal(kv.puts[0]!.options?.expirationTtl, 60);
    const envelope = JSON.parse(kv.puts[0]!.value);
    assert.equal(
      envelope.expires_at_ms - envelope.cached_at_ms,
      OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL * 1000,
    );
    assert.ok(
      OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL < OAUTH_ACCOUNT_TIER_KV_TTL,
      "a negative answer must expire sooner than a resolved tier",
    );
  });

  test("the tier TTL is short enough to be a tolerable upgrade latency", () => {
    // Pin local tier reuse so it cannot drift up to the key cache's
    // 30 minutes without a deliberate policy change.
    assert.ok(OAUTH_ACCOUNT_TIER_KV_TTL <= 300);
  });

  test("serves a cached answer without calling upstream at all", async () => {
    const kv = createFakeKv({
      "oauth-account-tier:v2:9": JSON.parse(
        authLookupCacheWrite(
          { found: true, tier: "paid" },
          {
            positiveTtlSeconds: OAUTH_ACCOUNT_TIER_KV_TTL,
            negativeTtlSeconds: OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL,
          },
        ).value,
      ),
    });
    const { env, requests } = envWith(
      { found: true, tier: "free" },
      { METAGRAPH_CONTROL: kv },
    );
    assert.deepEqual(await resolveOAuthAccountTier(env, 9), {
      found: true,
      tier: "paid",
    });
    assert.equal(requests.length, 0);
  });

  test("a KV read failure falls through to the live lookup", async () => {
    const { env } = envWith(
      { found: true, tier: "paid" },
      {
        METAGRAPH_CONTROL: {
          get: async () => {
            throw new Error("kv down");
          },
          put: async () => {},
        },
      },
    );
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: "paid",
    });
  });

  test("a KV write failure is non-fatal", async () => {
    const { env } = envWith(
      { found: true, tier: "paid" },
      {
        METAGRAPH_CONTROL: {
          get: async () => null,
          put: async () => {
            throw new Error("kv down");
          },
        },
      },
    );
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: "paid",
    });
  });

  test("works with no KV binding at all", async () => {
    const { env } = envWith(
      { found: true, tier: "paid" },
      { METAGRAPH_CONTROL: undefined },
    );
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
      found: true,
      tier: "paid",
    });
  });

  test("an unprovisioned deployment resolves nothing rather than throwing", async () => {
    for (const overrides of [
      { DATA_API: undefined },
      { DATA_API: {} },
      { API_KEY_LOOKUP_INTERNAL_TOKEN: undefined },
    ]) {
      const { env } = envWith({ found: true, tier: "paid" }, overrides);
      assert.deepEqual(await resolveOAuthAccountTier(env, 42), {
        found: false,
      });
    }
  });

  test("an upstream non-200 resolves nothing", async () => {
    const { env } = envWith({ found: true, tier: "paid" }, {}, 500);
    assert.deepEqual(await resolveOAuthAccountTier(env, 42), { found: false });
  });

  test("an upstream that throws or answers unparseable JSON resolves nothing", async () => {
    const { env: throwing } = envWith(null, {
      DATA_API: {
        fetch: async () => {
          throw new Error("binding down");
        },
      },
    });
    assert.deepEqual(await resolveOAuthAccountTier(throwing, 42), {
      found: false,
    });
    // 200 with a body that is not JSON -- .json() rejects, and the catch must
    // treat it exactly like an outage rather than surfacing a parse error.
    const { env: garbage } = envWith(null);
    assert.deepEqual(await resolveOAuthAccountTier(garbage, 42), {
      found: false,
    });
  });
});
