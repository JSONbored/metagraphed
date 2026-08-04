// Unit tests for workers/tiered-rate-limit.ts (#8386). Key validation goes
// through src/api-key-validation.ts's real KV-cache-fronted lookup, which on
// a miss calls the DATA_API service binding's internal verify route --
// mocked here exactly like tests/fullnode-rpc-proxy.test.ts's own convention.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  applyTieredRateLimit,
  spendDeferredDailyQuota,
  tieredRateLimitHeaders,
  tieredRejectionResponse,
} from "../workers/tiered-rate-limit.ts";
import { MCP_TIERED_RATE_LIMIT } from "../src/mcp-server.ts";
import { AI_TIERED_RATE_LIMIT } from "../src/ai-search.ts";
import { STATE_QUERY_TIERED_RATE_LIMIT } from "../workers/request-handlers/rpc-proxy.ts";
import { WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const ANONYMOUS = { envVar: "TEST_ANON_LIMITER", limit: 60, windowSeconds: 60 };
const KEYED = { envVar: "TEST_KEYED_LIMITER", limit: 300, windowSeconds: 60 };
const CONFIG = { anonymous: ANONYMOUS, keyed: KEYED, keyPrefix: "test" };

function createFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      if (!store.has(key)) return null;
      const raw = store.get(key)!;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const VALID_KEY = "mg_aValidOpaqueUnkeyGeneratedSuffix";

function envWithTier(tier: string, overrides: Row = {}) {
  return {
    METAGRAPH_CONTROL: createFakeKv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
    DATA_API: {
      fetch: async () =>
        new Response(
          JSON.stringify({ valid: true, code: "VALID", tier, accountId: "42" }),
          { status: 200 },
        ),
    },
    ...overrides,
  } as unknown as Env;
}

function envWithKeyVerify(overrides: Row = {}) {
  return {
    METAGRAPH_CONTROL: createFakeKv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
    DATA_API: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            valid: overrides.revoked_at ? false : true,
            code: overrides.revoked_at ? "DISABLED" : "VALID",
            tier: "free",
            accountId: "42",
          }),
          { status: 200 },
        ),
    },
    ...overrides,
  } as unknown as Env;
}

describe("applyTieredRateLimit", () => {
  test("no Authorization header -> anonymous tier, keyed by IP", async () => {
    const calls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      TEST_ANON_LIMITER: {
        limit: async (args: unknown) => {
          calls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/chain-events",
      {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      },
    );
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.policy, ANONYMOUS);
    assert.equal(result.accountId, null);
    assert.deepEqual(calls, [{ key: "test:203.0.113.9" }]);
  });

  test("a valid Authorization key -> keyed tier, keyed by accountId not IP", async () => {
    const calls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      TEST_KEYED_LIMITER: {
        limit: async (args: unknown) => {
          calls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/chain-events",
      {
        headers: {
          authorization: `Bearer ${VALID_KEY}`,
          "cf-connecting-ip": "203.0.113.9",
        },
      },
    );
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.policy, KEYED);
    assert.equal(result.accountId, "42");
    // #8608: tier-scoped, so a tier change starts a fresh window.
    assert.deepEqual(calls, [{ key: "test:free:42" }]);
  });

  test("an invalid/malformed key falls back to the anonymous tier, not a rejection", async () => {
    const env = {
      ...envWithKeyVerify(),
      TEST_ANON_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/chain-events",
      {
        headers: { authorization: "Bearer not-a-real-key" },
      },
    );
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.policy, ANONYMOUS);
    assert.equal(result.accountId, null);
  });

  test("a revoked key falls back to the anonymous tier", async () => {
    const env = {
      ...envWithKeyVerify({ revoked_at: 1 }),
      TEST_ANON_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/chain-events",
      {
        headers: { authorization: `Bearer ${VALID_KEY}` },
      },
    );
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.policy, ANONYMOUS);
  });

  test("reports allowed:false when the tier's binding rejects", async () => {
    const env = {
      ...envWithKeyVerify(),
      TEST_ANON_LIMITER: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/api/v1/chain-events");
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.allowed, false);
  });

  test("missing anonymous binding fails open (allowed:true) -- matches every existing rate-limit checkpoint's own posture", async () => {
    const env = envWithKeyVerify();
    const request = new Request("https://api.metagraph.sh/api/v1/chain-events");
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.allowed, true);
  });

  test("missing keyed binding fails open too -- a valid key must never be blocked by an unprovisioned deploy prerequisite", async () => {
    const env = envWithKeyVerify();
    const request = new Request(
      "https://api.metagraph.sh/api/v1/chain-events",
      {
        headers: { authorization: `Bearer ${VALID_KEY}` },
      },
    );
    const result = await applyTieredRateLimit(request, env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.policy, KEYED);
    assert.equal(result.accountId, "42");
  });
});

describe("applyTieredRateLimit with the MCP surface config (#8520)", () => {
  test("an anonymous MCP request is keyed by mcp:<ip> via MCP_RATE_LIMITER", async () => {
    const calls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      MCP_RATE_LIMITER: {
        limit: async (args: unknown) => {
          calls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/mcp", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      MCP_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.policy, MCP_TIERED_RATE_LIMIT.anonymous);
    assert.equal(result.accountId, null);
    assert.deepEqual(calls, [{ key: "mcp:203.0.113.9" }]);
  });

  test("a keyed MCP request rides the higher MCP_RATE_LIMITER_KEYED tier even when the anonymous tier would reject", async () => {
    const keyedCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      // anonymous tier is exhausted (rejects); a valid key must NOT be capped by it.
      MCP_RATE_LIMITER: { limit: async () => ({ success: false }) },
      MCP_RATE_LIMITER_KEYED: {
        limit: async (args: unknown) => {
          keyedCalls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/mcp", {
      headers: {
        authorization: `Bearer ${VALID_KEY}`,
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      MCP_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      MCP_TIERED_RATE_LIMIT.tiers?.free ?? MCP_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
    // keyed by accountId under the mcp: prefix, and the anon limiter is untouched.
    assert.deepEqual(keyedCalls, [{ key: "mcp:free:42" }]);
  });

  test("a keyed MCP request fails open when MCP_RATE_LIMITER_KEYED is unprovisioned", async () => {
    const env = {
      ...envWithKeyVerify(),
      MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      // MCP_RATE_LIMITER_KEYED intentionally absent (pre-provision deploy).
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/mcp", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      MCP_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      MCP_TIERED_RATE_LIMIT.tiers?.free ?? MCP_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
  });
});

describe("applyTieredRateLimit with the AI search/ask surface config (#8521)", () => {
  test("a keyed AI request rides the higher AI_RATE_LIMITER_KEYED tier above the anonymous ceiling", async () => {
    const keyedCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      // anonymous tier is exhausted (rejects); a valid key must NOT be capped by it.
      AI_RATE_LIMITER: { limit: async () => ({ success: false }) },
      AI_RATE_LIMITER_KEYED: {
        limit: async (args: unknown) => {
          keyedCalls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/api/v1/ask", {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_KEY}`,
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      AI_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      AI_TIERED_RATE_LIMIT.tiers?.free ?? AI_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
    // keyed by accountId under the ai: prefix, and the anon limiter is untouched.
    assert.deepEqual(keyedCalls, [{ key: "ai:free:42" }]);
  });

  test("the anonymous ceiling is unchanged -- 20/60s, keyed by ai:<ip> via AI_RATE_LIMITER (regression)", async () => {
    const anonCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      AI_RATE_LIMITER: {
        limit: async (args: unknown) => {
          anonCalls.push(args);
          return { success: false };
        },
      },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/search/semantic?q=x",
      { headers: { "cf-connecting-ip": "203.0.113.9" } },
    );
    const result = await applyTieredRateLimit(
      request,
      env,
      AI_TIERED_RATE_LIMIT,
    );
    // No key -> anonymous tier, still cut off at the same 20/60s IP-keyed ceiling.
    assert.equal(result.allowed, false);
    assert.equal(result.policy, AI_TIERED_RATE_LIMIT.anonymous);
    assert.equal(result.policy.limit, 20);
    assert.equal(result.policy.windowSeconds, 60);
    assert.equal(result.accountId, null);
    assert.deepEqual(anonCalls, [{ key: "ai:203.0.113.9" }]);
  });

  test("a keyed AI request fails open when AI_RATE_LIMITER_KEYED is unprovisioned", async () => {
    const env = {
      ...envWithKeyVerify(),
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
      // AI_RATE_LIMITER_KEYED intentionally absent (pre-provision deploy).
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/api/v1/ask", {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      AI_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      AI_TIERED_RATE_LIMIT.tiers?.free ?? AI_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
  });
});

describe("applyTieredRateLimit with the state-query surface config (#8522)", () => {
  test("a keyed state-query request rides the higher STATE_QUERY_RATE_LIMITER_KEYED tier above the anonymous ceiling", async () => {
    const keyedCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      STATE_QUERY_RATE_LIMITER: { limit: async () => ({ success: false }) },
      STATE_QUERY_RATE_LIMITER_KEYED: {
        limit: async (args: unknown) => {
          keyedCalls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/rpc/v1/finney", {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_KEY}`,
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      STATE_QUERY_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      STATE_QUERY_TIERED_RATE_LIMIT.tiers?.free ??
        STATE_QUERY_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
    assert.deepEqual(keyedCalls, [{ key: "state:free:42" }]);
  });

  test("the anonymous ceiling is unchanged -- 20/60s, keyed by state:<ip> via STATE_QUERY_RATE_LIMITER (regression)", async () => {
    const anonCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      STATE_QUERY_RATE_LIMITER: {
        limit: async (args: unknown) => {
          anonCalls.push(args);
          return { success: false };
        },
      },
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/rpc/v1/finney", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      STATE_QUERY_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, false);
    assert.equal(result.policy, STATE_QUERY_TIERED_RATE_LIMIT.anonymous);
    assert.equal(result.policy.limit, 20);
    assert.equal(result.policy.windowSeconds, 60);
    assert.equal(result.accountId, null);
    assert.deepEqual(anonCalls, [{ key: "state:203.0.113.9" }]);
  });

  test("a keyed state-query request fails open when STATE_QUERY_RATE_LIMITER_KEYED is unprovisioned", async () => {
    const env = {
      ...envWithKeyVerify(),
      STATE_QUERY_RATE_LIMITER: { limit: async () => ({ success: true }) },
      // STATE_QUERY_RATE_LIMITER_KEYED intentionally absent (pre-provision deploy).
    } as unknown as Env;
    const request = new Request("https://api.metagraph.sh/rpc/v1/finney", {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    const result = await applyTieredRateLimit(
      request,
      env,
      STATE_QUERY_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      STATE_QUERY_TIERED_RATE_LIMIT.tiers?.free ??
        STATE_QUERY_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
  });
});

describe("applyTieredRateLimit with the webhook-subscription surface config (#8523)", () => {
  test("a keyed webhook request rides the higher WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED tier above the anonymous ceiling", async () => {
    const keyedCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      WEBHOOK_SUBSCRIPTION_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      },
      WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED: {
        limit: async (args: unknown) => {
          keyedCalls.push(args);
          return { success: true };
        },
      },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/webhooks/subscriptions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_KEY}`,
          "cf-connecting-ip": "203.0.113.9",
        },
      },
    );
    const result = await applyTieredRateLimit(
      request,
      env,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT.tiers?.free ??
        WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
    assert.deepEqual(keyedCalls, [{ key: "webhook:free:42" }]);
  });

  test("the anonymous ceiling is unchanged -- 10/60s, keyed by webhook:<ip> via WEBHOOK_SUBSCRIPTION_RATE_LIMITER (regression)", async () => {
    const anonCalls: unknown[] = [];
    const env = {
      ...envWithKeyVerify(),
      WEBHOOK_SUBSCRIPTION_RATE_LIMITER: {
        limit: async (args: unknown) => {
          anonCalls.push(args);
          return { success: false };
        },
      },
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/webhooks/subscriptions",
      {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      },
    );
    const result = await applyTieredRateLimit(
      request,
      env,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, false);
    assert.equal(
      result.policy,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT.anonymous,
    );
    assert.equal(result.policy.limit, 10);
    assert.equal(result.policy.windowSeconds, 60);
    assert.equal(result.accountId, null);
    assert.deepEqual(anonCalls, [{ key: "webhook:203.0.113.9" }]);
  });

  test("a keyed webhook request fails open when WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED is unprovisioned", async () => {
    const env = {
      ...envWithKeyVerify(),
      WEBHOOK_SUBSCRIPTION_RATE_LIMITER: {
        limit: async () => ({ success: true }),
      },
      // WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED intentionally absent.
    } as unknown as Env;
    const request = new Request(
      "https://api.metagraph.sh/api/v1/webhooks/subscriptions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      },
    );
    const result = await applyTieredRateLimit(
      request,
      env,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(
      result.policy,
      WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT.tiers?.free ??
        WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT.keyed,
    );
    assert.equal(result.accountId, "42");
  });
});

describe("tieredRateLimitHeaders", () => {
  test("remaining is always 0 -- a 429 means the limit was hit, not an estimate", () => {
    const headers = tieredRateLimitHeaders(ANONYMOUS);
    assert.equal(headers["x-ratelimit-remaining"], "0");
  });

  test("limit/retry-after/policy reflect the given tier exactly", () => {
    const headers = tieredRateLimitHeaders(KEYED);
    assert.equal(headers["x-ratelimit-limit"], "300");
    assert.equal(headers["retry-after"], "60");
    assert.equal(headers["x-ratelimit-policy"], "300;w=60");
  });

  test("reset is an ISO timestamp roughly windowSeconds in the future", () => {
    const before = Date.now();
    const headers = tieredRateLimitHeaders(ANONYMOUS);
    const resetMs = Date.parse(headers["x-ratelimit-reset"]!);
    assert.ok(resetMs >= before + ANONYMOUS.windowSeconds * 1000);
    assert.ok(resetMs <= before + ANONYMOUS.windowSeconds * 1000 + 5000);
  });
});

describe("per-tier ceilings (#8608)", () => {
  // Before this, every valid key got the single `keyed` policy no matter what
  // tier it was on -- validateApiKey resolved the tier and the result was
  // thrown away, so a paid account and a free one were throttled identically
  // and #6646 had nothing to attach a paid model to.
  const CONFIG = {
    anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
    keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
    tiers: {
      free: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
      paid: { envVar: "KEYED", limit: 5000, windowSeconds: 60 },
    },
    keyPrefix: "t",
  };

  function limiterEnv(tier: string) {
    const calls: unknown[] = [];
    const env = envWithTier(tier, {
      ANON: { limit: async () => ({ success: true }) },
      KEYED: {
        limit: async (arg: unknown) => {
          calls.push(arg);
          return { success: true };
        },
      },
    });
    return { env, calls };
  }

  const req = () =>
    new Request("https://api.metagraph.sh/x", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

  test("a paid key gets the paid ceiling, not the generic keyed one", async () => {
    const { env } = limiterEnv("paid");
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.policy.limit, 5000);
    assert.equal(result.tier, "paid");
  });

  test("a free key keeps exactly the ceiling it has today — nobody loses headroom", async () => {
    const { env } = limiterEnv("free");
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.policy.limit, 100);
    assert.equal(result.policy.limit, CONFIG.keyed.limit);
  });

  test("an unpriced tier falls back to `keyed` rather than failing the request", async () => {
    // An account on a tier this route has not priced yet must never become an
    // outage for a paying caller.
    const { env } = limiterEnv("enterprise-2027");
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.policy.limit, CONFIG.keyed.limit);
    assert.equal(result.tier, "enterprise-2027");
  });

  test("the limiter key is scoped by tier, so a tier change starts a fresh window", async () => {
    // Otherwise a downgrade would inherit the old tier's partially-spent
    // window (dodging the new lower ceiling), and an upgrade would stay
    // throttled for the rest of it.
    const paid = limiterEnv("paid");
    await applyTieredRateLimit(req(), paid.env, CONFIG);
    assert.deepEqual(paid.calls, [{ key: "t:paid:42" }]);

    const free = limiterEnv("free");
    await applyTieredRateLimit(req(), free.env, CONFIG);
    assert.deepEqual(free.calls, [{ key: "t:free:42" }]);
  });

  test("anonymous is untouched by the tier table", async () => {
    const calls: unknown[] = [];
    const env = envWithTier("paid", {
      ANON: {
        limit: async (arg: unknown) => {
          calls.push(arg);
          return { success: true };
        },
      },
    });
    const result = await applyTieredRateLimit(
      new Request("https://api.metagraph.sh/x", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
      CONFIG,
    );
    assert.equal(result.tier, "anonymous");
    assert.equal(result.policy.limit, 10);
    assert.deepEqual(calls, [{ key: "t:203.0.113.9" }]);
  });

  test("the 429 headers name the tier the caller was measured against", () => {
    // Without it a 429 is unactionable: "you are on free, upgrade" and "you
    // are on paid and genuinely over" look identical.
    const headers = tieredRateLimitHeaders(CONFIG.tiers.paid, "paid");
    assert.equal(headers["x-ratelimit-tier"], "paid");
    assert.equal(headers["x-ratelimit-limit"], "5000");
    // Omitted entirely when no tier is supplied — never rendered as "undefined".
    assert.equal(
      tieredRateLimitHeaders(CONFIG.anonymous)["x-ratelimit-tier"],
      undefined,
    );
  });
});

describe("daily quotas (#8608)", () => {
  // Cloudflare's Rate Limiting bindings only do 10s/60s periods, so the daily
  // ceiling is counted in `api_quota_daily` on our own indexer box, reached
  // over the DATA_API service binding (workers/data-api.ts's
  // handleApiQuotaSpend). It is consulted ONLY for tiers that define
  // dailyUnits, so the extra round trip lands on precisely the callers the
  // quota is for.
  const CONFIG = {
    anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
    keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
    tiers: {
      free: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
      paid: {
        envVar: "KEYED",
        limit: 5000,
        windowSeconds: 60,
        dailyUnits: 1000,
      },
    },
    keyPrefix: "t",
  };

  function envWith(
    tier: string,
    quotaFetch?: (r: Request) => Promise<Response>,
  ) {
    const spends: unknown[] = [];
    // DATA_API must ROUTE BY PATH, exactly like the real data-api Worker does
    // -- the key-verify call and the quota spend both go down this one binding.
    // A stub that ignores the path and answers every request with the verify
    // payload is how the first cut of this suite hid a fail-CLOSED bug in
    // spendDailyQuota: the verify body has no `allowed` field, `!undefined` is
    // true, and every quota'd caller would have been 429'd by a store that
    // never rejected anything.
    const env = envWithTier(tier, {
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: true }) },
      DATA_API: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/internal/keys/quota") {
            spends.push({
              url: path,
              token: request.headers.get("x-api-key-lookup-token"),
              body: JSON.parse(await request.clone().text()),
            });
            if (!quotaFetch) return new Response("not found", { status: 404 });
            return quotaFetch(request);
          }
          return new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier,
              accountId: "42",
            }),
            { status: 200 },
          );
        },
      },
    });
    return { env, spends };
  }

  const req = (path = "/api/v1/subnets") =>
    new Request(`https://api.metagraph.sh${path}`, {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

  const ok = (body: Row) => async () =>
    new Response(JSON.stringify(body), { status: 200 });

  // #9414: a multiplexed transport (POST /mcp) cannot be priced by pathname --
  // every call shares one -- so it defers the spend until the body names the
  // tools, then debits through spendDeferredDailyQuota.
  test("deferQuota hands back the pending handle instead of spending", async () => {
    const { env, spends } = envWith("paid", ok({ allowed: true }));
    const result = await applyTieredRateLimit(req(), env, CONFIG, {
      deferQuota: true,
    });
    assert.equal(result.allowed, true);
    // Nothing debited yet -- that is the whole point of deferring.
    assert.deepEqual(spends, []);
    assert.equal(result.quota, undefined);
    assert.deepEqual(result.quotaPending, {
      accountId: "42",
      dailyUnits: 1000,
    });
  });

  test("spendDeferredDailyQuota debits the deferred cost, not one flat unit", async () => {
    const { env, spends } = envWith(
      "paid",
      ok({
        allowed: true,
        used: 50,
        limit: 1000,
        remaining: 950,
        resetAt: "x",
      }),
    );
    const verdict = await spendDeferredDailyQuota(
      req(),
      env,
      { accountId: "42", dailyUnits: 1000 },
      50,
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.remaining, 950);
    // The cost travelled through verbatim: a 10-message batch of 5-unit tools.
    assert.equal((spends[0] as { body: { cost: number } }).body.cost, 50);
  });

  test("a deferred spend can still refuse, and reports which ceiling did", async () => {
    const { env } = envWith(
      "paid",
      ok({
        allowed: false,
        used: 1000,
        limit: 1000,
        remaining: 0,
        resetAt: "x",
      }),
    );
    const verdict = await spendDeferredDailyQuota(
      req(),
      env,
      { accountId: "42", dailyUnits: 1000 },
      25,
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.remaining, 0);
  });

  test("a tier with NO dailyUnits never touches the quota store", async () => {
    // free must not pay the round trip, and today's keyed callers gain no cap.
    const { env, spends } = envWith("free", ok({ allowed: true }));
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.deepEqual(spends, []);
    assert.equal(result.quota, undefined);
  });

  test("spends the ROUTE'S cost, not one unit per request", async () => {
    const { env, spends } = envWith(
      "paid",
      ok({
        allowed: true,
        used: 25,
        limit: 1000,
        remaining: 975,
        resetAt: "x",
      }),
    );
    await applyTieredRateLimit(req("/api/v1/ask"), env, CONFIG);
    assert.deepEqual(spends, [
      {
        url: "/api/v1/internal/keys/quota",
        // Authenticated with the same shared secret the usage counter uses --
        // an unauthenticated spend would let anything reachable on the service
        // binding zero an account's day.
        token: "test-lookup-token",
        body: { account_id: 42, cost: 25, limit: 1000 },
      },
    ]);
  });

  test("an over-quota caller is rejected even when the per-minute limiter would allow", async () => {
    const { env } = envWith(
      "paid",
      ok({
        allowed: false,
        used: 1000,
        limit: 1000,
        remaining: 0,
        resetAt: "2026-07-30T00:00:00.000Z",
      }),
    );
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, false);
    assert.equal(result.quota?.remaining, 0);
  });

  // Every way the quota store can fail to deliver a verdict must fail OPEN.
  // Same posture as every other checkpoint in this file: an unprovisioned
  // deploy prerequisite, or a database having a moment, must never block a
  // paying caller. Only an explicit `allowed: false` rejects.
  const FAILS_OPEN: [string, () => Promise<Response>][] = [
    // The route does not exist -- an un-deployed or rolled-back data-api.
    [
      "a 404 from the quota route",
      async () => new Response("", { status: 404 }),
    ],
    // Hyperdrive down, so handleApiQuotaSpend's withAccountsSql 503s.
    [
      "a 503 (hyperdrive unavailable)",
      async () => new Response("", { status: 503 }),
    ],
    // The shared secret rotated on one side but not the other.
    ["a 401 (secret mismatch)", async () => new Response("", { status: 401 })],
    // A 200 whose body is not a verdict. This is the subtle one: `!undefined`
    // is true, so before the typeof guard in spendDailyQuota this rejected
    // every quota'd request from a store that never said no.
    ["a 200 with no `allowed` field", async () => Response.json({ ok: true })],
    // `allowed` present but not a boolean -- same trap, one step further in.
    [
      "a 200 with a non-boolean `allowed`",
      async () => Response.json({ allowed: "no" }),
    ],
    // Body claims JSON and isn't.
    [
      "a 200 with an unparseable body",
      async () => new Response("<html>502</html>", { status: 200 }),
    ],
    // The binding itself throws.
    [
      "a binding that throws",
      async () => {
        throw new Error("data-api unreachable");
      },
    ],
  ];

  for (const [label, response] of FAILS_OPEN) {
    test(`${label} fails OPEN`, async () => {
      const { env } = envWith("paid", response);
      const result = await applyTieredRateLimit(req(), env, CONFIG);
      assert.equal(result.allowed, true);
      assert.equal(result.quota, undefined, "and reports no quota headers");
    });
  }

  test("a DATA_API binding that disappears after the key is cached fails OPEN", async () => {
    // Realistic shape of the missing-binding case: the key lookup is cached in
    // KV (API_KEY_LOOKUP_KV_TTL), so a later request still authenticates as
    // `paid` even with no service binding left to ask about quota. The gate
    // must let it through rather than 429 a paying caller over a config gap.
    const { env } = envWith(
      "paid",
      ok({ allowed: false, used: 1e9, remaining: 0 }),
    );
    // Prime the cache while the binding is still there.
    await applyTieredRateLimit(req(), env, CONFIG);
    delete (env as unknown as Record<string, unknown>).DATA_API;
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.quota, undefined);
  });

  test("a valid key with NO tier falls back to `keyed` rather than going unlimited", async () => {
    // validateApiKey can return a null/absent tier -- an account row predating
    // the column, or a lookup that answered without one. That must land on the
    // `keyed` fallback policy (today's ceiling), not on a missing policy, and
    // must be REPORTED as "keyed" so the 429 and the limiter key agree.
    const limiterKeys: string[] = [];
    const env = envWithTier(null as unknown as string, {
      ANON: { limit: async () => ({ success: true }) },
      KEYED: {
        limit: async ({ key }: { key: string }) => {
          limiterKeys.push(key);
          return { success: true };
        },
      },
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.tier, "keyed");
    assert.equal(result.policy.envVar, CONFIG.keyed.envVar);
    assert.equal(result.policy.limit, CONFIG.keyed.limit);
    assert.deepEqual(limiterKeys, ["t:keyed:42"]);
  });

  test("a missing internal token skips the spend rather than sending it unauthenticated", async () => {
    // The binding is present but the shared secret is not, so the spend could
    // not be authenticated. Sending it anyway would only earn a 401; not
    // sending it is the same fail-open trade every case above makes.
    const { env, spends } = envWith("paid", ok({ allowed: false, used: 1e9 }));
    delete (env as unknown as Record<string, unknown>)
      .API_KEY_LOOKUP_INTERNAL_TOKEN;
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.deepEqual(spends, [], "no unauthenticated spend was attempted");
  });

  test("a quota rejection with units LEFT still reports the day, not the minute", async () => {
    // The case a cost-weighted quota exists to create: 10 units remain and the
    // call costs 25, so the quota rejects while `remaining` is still positive.
    // Keying the header scope off `remaining <= 0` labelled this a per-minute
    // rejection and told the caller to retry in 60s -- when the truth is "not
    // until UTC midnight". The store's own verdict is the only correct signal.
    const resetAt = "2026-07-30T00:00:00.000Z";
    const headers = tieredRateLimitHeaders(CONFIG.tiers.paid, "paid", {
      allowed: false,
      used: 990,
      limit: 1000,
      remaining: 10,
      resetAt,
    });
    assert.equal(headers["x-ratelimit-scope"], "daily-quota");
    assert.equal(headers["x-ratelimit-limit"], "1000");
    assert.equal(headers["x-ratelimit-reset"], resetAt);
  });

  test("an ALLOWED quota verdict does not hijack a per-minute rejection's headers", async () => {
    // Under the quota but over the minute: the 429 is per-minute and must say
    // so, even though a quota verdict rode along on the result.
    const headers = tieredRateLimitHeaders(CONFIG.tiers.paid, "paid", {
      allowed: true,
      used: 100,
      limit: 1000,
      remaining: 900,
      resetAt: "2026-07-30T00:00:00.000Z",
    });
    assert.equal(headers["x-ratelimit-scope"], "per-minute");
    assert.equal(headers["x-ratelimit-limit"], "5000");
    assert.equal(headers["retry-after"], "60");
  });

  test("a daily rejection reports the DAY's numbers and an exact reset", async () => {
    const resetAt = "2026-07-30T00:00:00.000Z";
    const headers = tieredRateLimitHeaders(CONFIG.tiers.paid, "paid", {
      allowed: false,
      used: 1000,
      limit: 1000,
      remaining: 0,
      resetAt,
    });
    assert.equal(headers["x-ratelimit-scope"], "daily-quota");
    assert.equal(headers["x-ratelimit-limit"], "1000");
    assert.equal(headers["x-ratelimit-reset"], resetAt);
    // Unlike the per-minute window, this reset is exact rather than an
    // upper-bound approximation.
    assert.notEqual(headers["x-ratelimit-policy"], "5000;w=60");
  });

  test("a per-minute rejection still reports the minute's numbers", async () => {
    const headers = tieredRateLimitHeaders(CONFIG.tiers.paid, "paid");
    assert.equal(headers["x-ratelimit-scope"], "per-minute");
    assert.equal(headers["x-ratelimit-limit"], "5000");
  });

  test("the tier label is omitted, not stringified, when there is no tier", async () => {
    // Anonymous callers have no tier, and `x-ratelimit-tier: undefined` would
    // be worse than no header at all. Holds on both header branches.
    const daily = tieredRateLimitHeaders(CONFIG.tiers.paid, undefined, {
      allowed: false,
      used: 1000,
      limit: 1000,
      remaining: 0,
      resetAt: "2026-07-30T00:00:00.000Z",
    });
    assert.equal(daily["x-ratelimit-scope"], "daily-quota");
    assert.ok(!("x-ratelimit-tier" in daily));
    const minute = tieredRateLimitHeaders(CONFIG.anonymous);
    assert.equal(minute["x-ratelimit-scope"], "per-minute");
    assert.ok(!("x-ratelimit-tier" in minute));
  });
});

describe("per-minute limiter runs before the daily quota is spent (#8812)", () => {
  // spendDailyQuota is a COMMIT (it POSTs to /api/v1/internal/keys/quota and
  // debits units), so it must run only for a request the per-minute limiter has
  // already accepted -- otherwise a caller refused with a 429 is billed for a
  // request that was never served.
  const CONFIG = {
    anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
    keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
    tiers: {
      paid: {
        envVar: "KEYED",
        limit: 5000,
        windowSeconds: 60,
        dailyUnits: 1000,
      },
    },
    keyPrefix: "t",
  };

  // Like the #8608 block's envWith, but the per-minute limiter's verdict is a
  // parameter, and the quota POSTs are recorded so a test can assert the store
  // was never touched.
  function envWith(
    limiterSuccess: boolean,
    quotaFetch?: (r: Request) => Promise<Response>,
  ) {
    const spends: unknown[] = [];
    const env = envWithTier("paid", {
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: limiterSuccess }) },
      DATA_API: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/internal/keys/quota") {
            spends.push(path);
            if (!quotaFetch) return new Response("not found", { status: 404 });
            return quotaFetch(request);
          }
          return new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "paid",
              accountId: "42",
            }),
            { status: 200 },
          );
        },
      },
    });
    return { env, spends };
  }

  const req = (path = "/api/v1/subnets") =>
    new Request(`https://api.metagraph.sh${path}`, {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

  const ok = (body: Row) => async () =>
    new Response(JSON.stringify(body), { status: 200 });

  test("a per-minute rejection spends NO daily quota (fails on main)", async () => {
    // The store answers allowed:true, so if the quota were ever consulted the
    // request would be let through AND debited -- the pre-#8812 bug. After the
    // reorder the limiter's success:false short-circuits before the spend.
    const { env, spends } = envWith(false, ok({ allowed: true }));
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, false);
    assert.deepEqual(spends, [], "the quota store must not be POSTed to");
    assert.equal(result.quota, undefined);
  });

  test("a per-minute rejection reports x-ratelimit-scope: per-minute with retry-after = windowSeconds", async () => {
    const { env } = envWith(false, ok({ allowed: true }));
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    // quota is undefined on a per-minute rejection, so the header helper takes
    // its per-minute branch.
    const headers = tieredRateLimitHeaders(
      result.policy,
      result.tier,
      result.quota,
    );
    assert.equal(headers["x-ratelimit-scope"], "per-minute");
    assert.equal(headers["retry-after"], "60");
  });

  test("within the minute but over the day still rejects with the daily-quota scope and exact resetAt", async () => {
    const { env, spends } = envWith(
      true,
      ok({
        allowed: false,
        used: 1000,
        limit: 1000,
        remaining: 0,
        resetAt: "2026-07-30T00:00:00.000Z",
      }),
    );
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, false);
    assert.equal(result.quota?.remaining, 0);
    assert.deepEqual(spends, ["/api/v1/internal/keys/quota"]);
    const headers = tieredRateLimitHeaders(
      result.policy,
      result.tier,
      result.quota,
    );
    assert.equal(headers["x-ratelimit-scope"], "daily-quota");
    assert.equal(headers["x-ratelimit-reset"], "2026-07-30T00:00:00.000Z");
  });

  test("allowed by both spends the quota exactly once, with cost = the route weight", async () => {
    const { env, spends } = envWith(
      true,
      ok({ allowed: true, used: 1, limit: 1000, remaining: 999 }),
    );
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    assert.equal(result.quota?.remaining, 999);
    assert.deepEqual(spends, ["/api/v1/internal/keys/quota"]);
  });

  test("a blocked caller short-circuits before both the limiter and the quota", async () => {
    const spends: unknown[] = [];
    // The blocklist snapshot lives under the "api-key-blocklist" KV key as a
    // { blocks: [{ accountId, reasonCode }] } array (see the #8611 block).
    const env = envWithTier("paid", {
      METAGRAPH_CONTROL: {
        get: async (key: string) =>
          key === "api-key-blocklist"
            ? { blocks: [{ accountId: 42, reasonCode: "abuse_scraping" }] }
            : null,
        put: async () => {},
      },
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: true }) },
      DATA_API: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/internal/keys/quota") {
            spends.push(path);
            return Response.json({ allowed: true });
          }
          return Response.json({
            valid: true,
            code: "VALID",
            tier: "paid",
            accountId: "42",
          });
        },
      },
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, false);
    assert.ok(result.block, "the verdict carries the block");
    assert.deepEqual(spends, [], "no quota spend on a blocked caller");
  });
});

describe("key-level blocklist (#8611)", () => {
  const CONFIG = {
    anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
    keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
    tiers: {
      paid: {
        envVar: "KEYED",
        limit: 5000,
        windowSeconds: 60,
        dailyUnits: 1000,
      },
    },
    keyPrefix: "t",
  };

  function envWithBlocklist(snapshot: unknown, quotaSpends: unknown[] = []) {
    const kv = {
      get: async (key: string) =>
        key === "api-key-blocklist" ? snapshot : null,
      put: async () => {},
    };
    return envWithTier("paid", {
      METAGRAPH_CONTROL: kv,
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: true }) },
      DATA_API: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/internal/keys/quota") {
            quotaSpends.push(await request.clone().json());
            return Response.json({
              allowed: true,
              used: 1,
              limit: 1000,
              remaining: 999,
              resetAt: "x",
            });
          }
          return Response.json({
            valid: true,
            code: "VALID",
            tier: "paid",
            accountId: "42",
          });
        },
      },
    });
  }

  const req = () =>
    new Request("https://api.metagraph.sh/api/v1/subnets", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

  test("a blocked account is rejected, with its reason code", async () => {
    const env = envWithBlocklist({
      blocks: [{ accountId: 42, reasonCode: "abuse_scraping" }],
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, false);
    assert.equal(result.block?.blocked, true);
    assert.equal(result.block?.reasonCode, "abuse_scraping");
  });

  test("the block is checked BEFORE the daily quota is spent", async () => {
    // Spending quota on a request we are about to refuse would bill a blocked
    // caller for units they never got served, and would surface the block as a
    // 429 once that quota ran out.
    const spends: unknown[] = [];
    const env = envWithBlocklist(
      { blocks: [{ accountId: 42, reasonCode: "abuse_manual" }] },
      spends,
    );
    await applyTieredRateLimit(req(), env, CONFIG);
    assert.deepEqual(spends, [], "no quota was spent for a blocked caller");
  });

  test("an unblocked account is unaffected and still carries no block field", async () => {
    const env = envWithBlocklist({
      blocks: [{ accountId: 999, reasonCode: "abuse_manual" }],
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(result.allowed, true);
    // A 200 must not reveal that a blocklist exists at all.
    assert.equal(result.block, undefined);
  });

  test("an absent, empty or unreadable blocklist blocks NOBODY", async () => {
    for (const snapshot of [null, {}, { blocks: null }, { blocks: "all" }]) {
      const env = envWithBlocklist(snapshot);
      const result = await applyTieredRateLimit(req(), env, CONFIG);
      assert.equal(result.allowed, true, JSON.stringify(snapshot));
    }
    // A KV binding that throws must also fail open, not lock everyone out.
    const throwing = envWithTier("paid", {
      METAGRAPH_CONTROL: {
        get: async () => {
          throw new Error("kv down");
        },
      },
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: true }) },
    });
    assert.equal(
      (await applyTieredRateLimit(req(), throwing, CONFIG)).allowed,
      true,
    );
    // As must a missing binding entirely.
    const unbound = envWithTier("paid", {
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: true }) },
    });
    assert.equal(
      (await applyTieredRateLimit(req(), unbound, CONFIG)).allowed,
      true,
    );
  });

  test("a block is reported as 403, not 429", async () => {
    // 429 means "retry shortly", which will never work and invites exactly the
    // retry storm a block exists to stop.
    const env = envWithBlocklist({
      blocks: [{ accountId: 42, reasonCode: "abuse_key_sharing" }],
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    const rejection = tieredRejectionResponse(result, {
      code: "rate_limited",
      message: "Too many requests; slow down.",
    })!;
    assert.equal(rejection.status, 403);
    assert.equal(rejection.code, "api_key_blocked");
    assert.equal(rejection.headers["x-ratelimit-scope"], "blocked");
    assert.equal(
      rejection.headers["x-api-key-block-reason"],
      "abuse_key_sharing",
    );
    // No retry-after: there is no time after which this starts working.
    assert.ok(!("retry-after" in rejection.headers));
    assert.match(rejection.message, /Contact support/);
  });

  test("a plain rate-limit rejection is still a 429", async () => {
    const env = envWithTier("paid", {
      METAGRAPH_CONTROL: { get: async () => null },
      ANON: { limit: async () => ({ success: true }) },
      KEYED: { limit: async () => ({ success: false }) },
    });
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    const rejection = tieredRejectionResponse(result, {
      code: "rate_limited",
      message: "Too many requests; slow down.",
    })!;
    assert.equal(rejection.status, 429);
    assert.equal(rejection.code, "rate_limited");
    assert.equal(rejection.headers["retry-after"], "60");
  });

  test("a block with no tier omits the tier header rather than stringifying it", async () => {
    const rejection = tieredRejectionResponse(
      {
        allowed: false,
        policy: CONFIG.keyed,
        tier: "",
        accountId: "42",
        block: {
          blocked: true,
          reasonCode: null,
          message: "Blocked.",
        },
      },
      { code: "rate_limited", message: "x" },
    )!;
    assert.equal(rejection.status, 403);
    // reasonCode null degrades to the generic code rather than emitting "null".
    assert.equal(rejection.headers["x-api-key-block-reason"], "abuse_manual");
    assert.ok(!("x-ratelimit-tier" in rejection.headers));
  });

  test("an allowed request produces no rejection at all", async () => {
    const env = envWithBlocklist(null);
    const result = await applyTieredRateLimit(req(), env, CONFIG);
    assert.equal(
      tieredRejectionResponse(result, {
        code: "rate_limited",
        message: "Too many requests; slow down.",
      }),
      null,
    );
  });
});

describe("burst enforcement (#8608 acceptance)", () => {
  // "load test demonstrates enforcement under burst" -- driven against the
  // real accounting rather than a mocked boolean, so it proves the ceiling
  // holds rather than that a stub returned false.
  test("a 5,000-unit burst against a 1,000-unit day is cut off at exactly the limit", async () => {
    const { applyQuotaSpend } = await import("../src/daily-quota.ts");
    const now = Date.UTC(2026, 6, 29, 12);
    let used = 0;
    let allowed = 0;
    let rejected = 0;
    for (let i = 0; i < 5000; i += 1) {
      const r = applyQuotaSpend(used, 1, 1000, now);
      used = r.used;
      if (r.allowed) allowed += 1;
      else rejected += 1;
    }
    assert.equal(allowed, 1000, "exactly the ceiling gets through");
    assert.equal(rejected, 4000);
    assert.equal(used, 1000, "and the counter never exceeds it");
  });

  test("a burst of EXPENSIVE calls is cut off by cost, not by count", async () => {
    const { applyQuotaSpend } = await import("../src/daily-quota.ts");
    const now = Date.UTC(2026, 6, 29, 12);
    let used = 0;
    let allowed = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = applyQuotaSpend(used, 25, 1000, now);
      used = r.used;
      if (r.allowed) allowed += 1;
    }
    // 1000 / 25 = 40 LLM-class calls, versus 1000 cached reads.
    assert.equal(allowed, 40);
    assert.equal(used, 1000);
  });

  test("a rejected spend leaves the counter untouched", async () => {
    // The rule the SQL's `WHERE ... <= limit` conflict predicate implements:
    // one oversized call must not drain what is left of the day.
    const { applyQuotaSpend } = await import("../src/daily-quota.ts");
    const now = Date.UTC(2026, 6, 29, 12);
    const r = applyQuotaSpend(990, 25, 1000, now);
    assert.equal(r.allowed, false);
    assert.equal(r.used, 990, "nothing was spent");
    assert.equal(r.remaining, 10, "and the remainder is still available");
    // ...so a cheaper call still gets through afterwards.
    assert.equal(applyQuotaSpend(r.used, 1, 1000, now).allowed, true);
  });

  test("a spend larger than the entire day is rejected from a cold start", async () => {
    // No row exists yet, so the SQL's conflict guard never fires -- the
    // handler's own `cost > limit` check is the only thing standing between
    // this and a banked over-limit balance.
    const { applyQuotaSpend } = await import("../src/daily-quota.ts");
    const r = applyQuotaSpend(0, 5000, 1000, Date.UTC(2026, 6, 29, 12));
    assert.equal(r.allowed, false);
    assert.equal(r.used, 0);
    assert.equal(r.remaining, 1000);
  });

  test("the reset instant is the next UTC midnight, exactly", async () => {
    const { quotaResetAt, utcDayKey, msUntilUtcMidnight } =
      await import("../src/daily-quota.ts");
    const noon = Date.UTC(2026, 6, 29, 12, 30, 15, 500);
    assert.equal(utcDayKey(noon), "2026-07-29");
    assert.equal(quotaResetAt(noon), "2026-07-30T00:00:00.000Z");
    assert.equal(
      msUntilUtcMidnight(noon),
      11 * 3600_000 + 29 * 60_000 + 44_500,
    );
    // Month/year rollovers are the case a naive +1 day gets wrong.
    assert.equal(
      quotaResetAt(Date.UTC(2026, 11, 31, 23, 59)),
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("tier lookup must not walk the prototype chain (#8687 review)", () => {
  // `config.tiers?.[tier]` resolved inherited Object members for a tier named
  // "constructor"/"toString"/"valueOf"/"__proto__". Those are truthy, so the
  // `|| config.keyed` fallback never ran, the resulting object had no
  // `envVar`, the limiter binding lookup missed -- and the request was allowed
  // with NO rate limiting. A silent bypass, from a tier string that arrives
  // over the key-validation response.
  const CONFIG = {
    anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
    keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
    tiers: { paid: { envVar: "KEYED", limit: 5000, windowSeconds: 60 } },
    keyPrefix: "t",
  };

  for (const hostile of [
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
    "hasOwnProperty",
  ]) {
    test(`a tier named "${hostile}" falls back to keyed and is still limited`, async () => {
      const calls: unknown[] = [];
      const env = envWithTier(hostile, {
        ANON: { limit: async () => ({ success: true }) },
        KEYED: {
          limit: async (arg: unknown) => {
            calls.push(arg);
            return { success: false };
          },
        },
      });
      const result = await applyTieredRateLimit(
        new Request("https://api.metagraph.sh/x", {
          headers: { authorization: `Bearer ${VALID_KEY}` },
        }),
        env,
        CONFIG,
      );
      // The fallback policy is a real one, so a limiter actually runs...
      assert.equal(result.policy.envVar, "KEYED");
      assert.equal(calls.length, 1, "the limiter must have been consulted");
      // ...and its verdict is honoured rather than silently allowing.
      assert.equal(result.allowed, false);
    });
  }

  test("a genuinely configured tier still resolves", async () => {
    const env = envWithTier("paid", {
      KEYED: { limit: async () => ({ success: true }) },
    });
    const result = await applyTieredRateLimit(
      new Request("https://api.metagraph.sh/x", {
        headers: { authorization: `Bearer ${VALID_KEY}` },
      }),
      env,
      CONFIG,
    );
    assert.equal(result.policy.limit, 5000);
  });
});
