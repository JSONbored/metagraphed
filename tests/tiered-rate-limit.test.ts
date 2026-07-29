// Unit tests for workers/tiered-rate-limit.ts (#8386). Key validation goes
// through src/api-key-validation.ts's real KV-cache-fronted lookup, which on
// a miss calls the DATA_API service binding's internal verify route --
// mocked here exactly like tests/fullnode-rpc-proxy.test.ts's own convention.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  applyTieredRateLimit,
  tieredRateLimitHeaders,
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
