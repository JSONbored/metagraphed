import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  authLookupCacheWrite,
  readAuthLookupCache,
} from "../src/auth-lookup-cache.ts";
import { validateApiKey } from "../src/api-key-validation.ts";
import { resolveOAuthAccountTier } from "../src/oauth-account-tier.ts";
import { applyTieredRateLimit } from "../workers/tiered-rate-limit.ts";
import { mockEnv } from "./row-type.ts";

const NOW = 1_800_000_000_000;
const RAW_KEY = "mg_cache_lifetime_regression_fixture";
const POLICY = { positiveTtlSeconds: 300, negativeTtlSeconds: 30 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

// Enforce Workers KV's real minimum and physical expiry. A negative entry
// remains readable at 30 seconds so the application's logical guard must work.
function providerKv() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const puts: { key: string; value: string; expirationTtl: number }[] = [];
  return {
    store,
    puts,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry && entry.expiresAt > Date.now()
        ? JSON.parse(entry.value)
        : null;
    }),
    put: vi.fn(
      async (
        key: string,
        value: string,
        options: { expirationTtl: number },
      ) => {
        assert.ok(options.expirationTtl >= 60, "KV rejects TTLs below 60s");
        puts.push({ key, value, ...options });
        store.set(key, {
          value,
          expiresAt: Date.now() + options.expirationTtl * 1000,
        });
      },
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("auth cache envelope validation", () => {
  test.each([true, false])(
    "retains the original record for found=%s",
    (found) => {
      const record = { found, tier: null, accountId: "7", code: "DISABLED" };
      const entry = authLookupCacheWrite(record, POLICY);
      assert.equal(entry.expirationTtl, found ? 300 : 60);
      assert.deepEqual(
        readAuthLookupCache(JSON.parse(entry.value), POLICY),
        record,
      );
    },
  );

  const valid = {
    auth_lookup_cache_version: 1,
    cached_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    record: { found: false },
  };
  test.each([
    null,
    [],
    "garbage",
    {},
    { found: true },
    { ...valid, auth_lookup_cache_version: 2 },
    { ...valid, record: null },
    { ...valid, record: [] },
    { ...valid, record: { found: "true", tier: "paid" } },
    { ...valid, cached_at_ms: "1800000000000" },
    { ...valid, cached_at_ms: 1.5 },
    { ...valid, cached_at_ms: Number.NaN },
    { ...valid, cached_at_ms: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, expires_at_ms: "1800000030000" },
    { ...valid, expires_at_ms: Number.POSITIVE_INFINITY },
    { ...valid, cached_at_ms: NOW + 1 },
    { ...valid, expires_at_ms: NOW },
    { ...valid, expires_at_ms: NOW - 1 },
    { ...valid, expires_at_ms: NOW + 60_000 },
    { ...valid, record: { found: true } },
  ])("treats malformed or expired cache data as a miss (%#)", (value) => {
    assert.equal(readAuthLookupCache(value, POLICY), null);
  });
});

const MODES = [
  {
    name: "API key",
    prefix: "api-key-lookup",
    version: "v3",
    positiveTtl: 1800,
    lookup: (env: Env) => validateApiKey(env, RAW_KEY),
    positive: {
      keyId: "key_fixture",
      managed: true,
      valid: true,
      tier: "paid",
      accountId: "7",
    },
    negative: { valid: false, code: "DISABLED" },
    positiveResult: { ok: true, tier: "paid", accountId: "7" },
    negativeResult: { ok: false, code: "key_revoked" },
    failedResult: { ok: false, code: "invalid_key" },
  },
  {
    name: "OAuth account tier",
    prefix: "oauth-account-tier",
    version: "v2",
    positiveTtl: 300,
    lookup: (env: Env) => resolveOAuthAccountTier(env, 7),
    positive: { found: true, tier: "paid" },
    negative: { found: false },
    positiveResult: { found: true, tier: "paid" },
    negativeResult: { found: false },
    failedResult: { found: false },
  },
];

for (const mode of MODES) {
  function harness() {
    const kv = providerKv();
    const fetch = vi.fn(async (_request?: Request) =>
      Response.json(mode.negative),
    );
    const env = mockEnv({
      METAGRAPH_CONTROL: kv,
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
      DATA_API: {
        fetch: async (request: Request) =>
          new URL(request.url).pathname.endsWith("/keys/state")
            ? Response.json({ state: "active" })
            : fetch(request),
      },
    });
    return { kv, fetch, env };
  }

  describe(`${mode.name} cache lifetime`, () => {
    test("persists negatives for 60s but retries exactly at 30s and recovers", async () => {
      const { kv, fetch, env } = harness();
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      assert.equal(kv.puts[0]!.expirationTtl, 60);
      fetch.mockImplementation(async () => Response.json(mode.positive));
      vi.setSystemTime(NOW + 29_999);
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      assert.equal(fetch.mock.calls.length, 1);
      vi.setSystemTime(NOW + 30_000);
      assert.ok(
        await kv.get(kv.puts[0]!.key),
        "physical negative still exists",
      );
      assert.deepEqual(await mode.lookup(env), mode.positiveResult);
      assert.equal(fetch.mock.calls.length, 2);
      assert.equal(kv.puts[1]!.expirationTtl, mode.positiveTtl);
      assert.equal(kv.puts[0]!.key, kv.puts[1]!.key);
    });

    test("preserves positive TTL and rechecks a rejection at its exact boundary", async () => {
      const { kv, fetch, env } = harness();
      fetch.mockImplementationOnce(async () => Response.json(mode.positive));
      assert.deepEqual(await mode.lookup(env), mode.positiveResult);
      assert.equal(kv.puts[0]!.expirationTtl, mode.positiveTtl);
      vi.setSystemTime(NOW + mode.positiveTtl * 1000 - 1);
      assert.deepEqual(await mode.lookup(env), mode.positiveResult);
      assert.equal(fetch.mock.calls.length, 1);
      vi.setSystemTime(NOW + mode.positiveTtl * 1000);
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      assert.equal(fetch.mock.calls.length, 2);
    });

    test("rejects malformed envelopes and ignores legacy raw cache namespaces", async () => {
      const { kv, fetch, env } = harness();
      await mode.lookup(env);
      const key = kv.puts[0]!.key;
      assert.ok(key.startsWith(`${mode.prefix}:${mode.version}:`));
      assert.ok(!key.includes(RAW_KEY));
      assert.ok(!kv.puts[0]!.value.includes(RAW_KEY));
      kv.store.clear();
      kv.store.set(key.replace(`:${mode.version}:`, ":"), {
        value: JSON.stringify({ found: true, tier: "paid", accountId: "7" }),
        expiresAt: NOW + 1_800_000,
      });
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      kv.store.set(key, {
        value: JSON.stringify({
          auth_lookup_cache_version: 1,
          cached_at_ms: NOW,
          expires_at_ms: NOW + 30_000,
          record: { found: "true", tier: "paid" },
        }),
        expiresAt: NOW + 60_000,
      });
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      assert.equal(fetch.mock.calls.length, 3);
    });

    test.each(["throw", "non-ok", "malformed JSON"])(
      "retries upstream failure (%s) after the logical negative lifetime",
      async (failure) => {
        const { kv, fetch, env } = harness();
        fetch.mockImplementationOnce(async () => {
          if (failure === "throw") throw new Error("lookup unavailable");
          return new Response("invalid JSON", {
            status: failure === "non-ok" ? 503 : 200,
          });
        });
        assert.deepEqual(await mode.lookup(env), mode.failedResult);
        assert.equal(kv.puts[0]!.expirationTtl, 60);
        fetch.mockImplementation(async () => Response.json(mode.positive));
        vi.setSystemTime(NOW + 30_000);
        assert.deepEqual(await mode.lookup(env), mode.positiveResult);
      },
    );

    test.each(["negative", "positive"])(
      "keeps completion-order replacement when a delayed %s arrives last",
      async (last) => {
        const { kv, fetch, env } = harness();
        const first = deferred<Response>();
        const second = deferred<Response>();
        const startedFirst = deferred<void>();
        const startedSecond = deferred<void>();
        fetch.mockImplementationOnce(() => {
          startedFirst.resolve();
          return first.promise;
        });
        fetch.mockImplementationOnce(() => {
          startedSecond.resolve();
          return second.promise;
        });
        const pendingFirst = mode.lookup(env);
        await startedFirst.promise;
        const pendingSecond = mode.lookup(env);
        await startedSecond.promise;
        second.resolve(
          Response.json(last === "negative" ? mode.positive : mode.negative),
        );
        await pendingSecond;
        vi.setSystemTime(NOW + 20_000);
        first.resolve(
          Response.json(last === "negative" ? mode.negative : mode.positive),
        );
        await pendingFirst;
        assert.deepEqual(
          await mode.lookup(env),
          last === "negative" ? mode.negativeResult : mode.positiveResult,
        );
        assert.equal(kv.store.size, 1, "no permanent success preference");
        assert.equal(fetch.mock.calls.length, 2);
        if (last === "negative") {
          fetch.mockImplementation(async () => Response.json(mode.positive));
          vi.setSystemTime(NOW + 49_999);
          assert.deepEqual(await mode.lookup(env), mode.negativeResult);
          vi.setSystemTime(NOW + 50_000);
          assert.deepEqual(await mode.lookup(env), mode.positiveResult);
        }
      },
    );

    test("cache failures preserve live authorization results", async () => {
      const { kv, fetch, env } = harness();
      kv.get.mockRejectedValue(new Error("read unavailable"));
      kv.put.mockRejectedValue(new Error("write unavailable"));
      assert.deepEqual(await mode.lookup(env), mode.negativeResult);
      fetch.mockImplementation(async () => Response.json(mode.positive));
      assert.deepEqual(await mode.lookup(env), mode.positiveResult);
      assert.equal(fetch.mock.calls.length, 2);
    });
  });
}

test("account and credential identities remain isolated in a shared KV", async () => {
  const kv = providerKv();
  const fetch = vi.fn(async (request: Request) => {
    const input = (await request.json()) as {
      account_id?: number;
      key?: string;
    };
    return Response.json(
      input.account_id
        ? { found: input.account_id === 7, tier: "paid" }
        : {
            keyId: "key_fixture",
            managed: true,
            valid: input.key === RAW_KEY,
            tier: "free",
            accountId: "7",
          },
    );
  });
  const env = mockEnv({
    METAGRAPH_CONTROL: kv,
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
    DATA_API: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname.endsWith("/keys/state")
          ? Response.json({ state: "active" })
          : fetch(request),
    },
  });
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: true,
    tier: "free",
    accountId: "7",
  });
  assert.deepEqual(await validateApiKey(env, `${RAW_KEY}_other`), {
    ok: false,
    code: "invalid_key",
  });
  assert.deepEqual(await resolveOAuthAccountTier(env, 7), {
    found: true,
    tier: "paid",
  });
  assert.deepEqual(await resolveOAuthAccountTier(env, 8), { found: false });
  assert.equal(kv.store.size, 4);
  assert.equal(fetch.mock.calls.length, 4);
});

test("OAuth tier upgrades and downgrades refresh without changing identity", async () => {
  const kv = providerKv();
  let tier = "free";
  const env = mockEnv({
    METAGRAPH_CONTROL: kv,
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
    DATA_API: { fetch: async () => Response.json({ found: true, tier }) },
  });
  for (const [elapsed, nextTier] of [
    [0, "free"],
    [300_000, "paid"],
    [600_000, "free"],
  ] as const) {
    tier = nextTier;
    vi.setSystemTime(NOW + elapsed);
    assert.deepEqual(await resolveOAuthAccountTier(env, 7), {
      found: true,
      tier,
    });
  }
  assert.equal(kv.store.size, 1);
});

test("a cached identity still undergoes each request's account block and rate checks", async () => {
  const kv = providerKv();
  const fetch = vi.fn(async (_request?: Request) =>
    Response.json({
      keyId: "key_fixture",
      managed: true,
      valid: true,
      tier: "free",
      accountId: "7",
    }),
  );
  const limit = vi.fn(async () => ({ success: true }));
  const env = mockEnv({
    METAGRAPH_CONTROL: kv,
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
    DATA_API: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname.endsWith("/keys/state")
          ? Response.json({ state: "active" })
          : fetch(request),
    },
    TEST_KEYED_LIMITER: { limit },
  });
  const policy = { envVar: "TEST_KEYED_LIMITER", limit: 60, windowSeconds: 60 };
  const config = { anonymous: policy, keyed: policy, keyPrefix: "test" };
  const request = new Request("https://api.metagraph.sh/api/v1/chain-events", {
    headers: { Authorization: `Bearer ${RAW_KEY}` },
  });
  assert.equal(
    (await applyTieredRateLimit(request, env, config)).allowed,
    true,
  );
  assert.equal(
    (await applyTieredRateLimit(request, env, config)).allowed,
    true,
  );
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(limit.mock.calls.length, 2);
  kv.store.set("api-key-blocklist", {
    value: JSON.stringify({
      blocks: [
        { accountId: 7, accountKind: "rpc", reasonCode: "abuse_manual" },
      ],
    }),
    expiresAt: NOW + 60_000,
  });
  const blocked = await applyTieredRateLimit(request, env, config);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.block?.blocked, true);
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(limit.mock.calls.length, 2);
});
