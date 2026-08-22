// #11179: the paid-depth seam -- tier gates DEPTH, never visibility.
//
// The contract this pins, in the order it matters:
//   1. every tool stays LISTED and CALLABLE at every tier; only depth refuses
//   2. a free call inside the free depth is never touched
//   3. a free call past it gets a structured `payment_required` carrying the
//      tier it needs and where to get one -- an agent relays that upward,
//      which is what makes the refusal a sales channel rather than a wall
//   4. a paid call past it goes through
//
// An UNRECOGNISED tier must not clear a boundary: the alternative turns a typo
// in an account record into free access to every paid depth.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FREE_HISTORY_WINDOW_DAYS,
  MCP_TIER_RANK,
  MCP_UPGRADE_URL,
  paymentRequiredToolError,
  requireTierForDepth,
  tierClears,
} from "../src/mcp-tier-gate.ts";
import { handleMcpRequest, MCP_CORE_TOOL_NAMES } from "../src/mcp-server.ts";
import { applyTieredRateLimit } from "../workers/tiered-rate-limit.ts";
import { mockEnv, type Row } from "./row-type.ts";

const guard = (tier: string, requested: number | null) =>
  requireTierForDepth({
    tier,
    requiredTier: "paid",
    boundary: "history_window_days",
    requested,
    limit: FREE_HISTORY_WINDOW_DAYS,
  });

describe("tierClears", () => {
  test("ranks anonymous below every issued tier", () => {
    assert.equal(MCP_TIER_RANK[0], "anonymous");
    assert.equal(tierClears("anonymous", "free"), false);
    assert.equal(tierClears("free", "free"), true);
    assert.equal(tierClears("paid", "community"), true);
    assert.equal(tierClears("community", "paid"), false);
  });

  test("an unrecognised tier clears NOTHING", () => {
    // A tier string this build does not know is not evidence of entitlement.
    for (const unknown of ["", "enterprise", "__proto__", "constructor", null])
      assert.equal(tierClears(unknown, "free"), false, String(unknown));
  });
});

describe("the depth guard", () => {
  test("a request inside the free depth passes at any tier", () => {
    for (const tier of ["anonymous", "free", "paid"]) {
      assert.doesNotThrow(() => guard(tier, FREE_HISTORY_WINDOW_DAYS));
      assert.doesNotThrow(() => guard(tier, 7));
    }
  });

  test("a free caller past the depth is refused, with both sides named", () => {
    const error = (() => {
      try {
        guard("anonymous", 365);
        return null;
      } catch (thrown) {
        return thrown as Row;
      }
    })();
    assert.ok(error, "365 days must not pass at the anonymous tier");
    assert.equal(error.code, "payment_required");
    assert.equal(error.toolError, true);
    const payment = error.payment as Row;
    assert.equal(payment.required_tier, "paid");
    assert.equal(payment.tier, "anonymous");
    assert.equal(payment.boundary, "history_window_days");
    assert.equal(payment.limit, FREE_HISTORY_WINDOW_DAYS);
    assert.equal(payment.requested, 365);
    assert.equal(payment.upgrade_url, MCP_UPGRADE_URL);
    // The prose must carry the upgrade path too: a client that only renders
    // `message` still shows its human something actionable.
    assert.match(String(error.message), new RegExp(MCP_UPGRADE_URL));
  });

  test("an UNBOUNDED window crosses every finite ceiling", () => {
    // `all` parses to days: null. Treating null as "no request" would have
    // made the deepest possible read the one thing that passed free.
    assert.throws(() => guard("free", null), /payment_required|paid tier/);
    assert.doesNotThrow(() => guard("paid", null));
  });

  test("a paid caller passes the same depth that refuses a free one", () => {
    assert.throws(() => guard("community", 365));
    assert.doesNotThrow(() => guard("paid", 365));
  });
});

describe("the refusal shape is x402-ready", () => {
  test("payment is a block, not flattened onto the error", () => {
    const error = paymentRequiredToolError({
      tier: "free",
      requiredTier: "paid",
      boundary: "history_window_days",
    });
    assert.equal(error.code, "payment_required");
    // Exactly the members declared today; a challenge later joins THIS block
    // rather than introducing a second error vocabulary.
    assert.deepEqual(Object.keys(error.payment).sort(), [
      "boundary",
      "required_tier",
      "tier",
      "upgrade_url",
    ]);
  });
});

/** One real MCP tools/call through the dispatcher, anonymous (no key). */
async function callEconomicsTrends(window: string) {
  const res = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_economics_trends", arguments: { window } },
      }),
    }),
    mockEnv(),
  );
  const text = await res.text();
  const json = text.startsWith("event:")
    ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
    : JSON.parse(text);
  return (json.result ?? json) as Row;
}

describe("the boundary, through a real dispatch", () => {
  test("an anonymous 1y call is refused with the structured payment block", async () => {
    const result = await callEconomicsTrends("1y");
    assert.equal(result.isError, true);
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "payment_required");
    const payment = error.payment as Row;
    assert.equal(payment.required_tier, "paid");
    assert.equal(payment.boundary, "history_window_days");
    assert.equal(payment.upgrade_url, MCP_UPGRADE_URL);
  });

  test("the same anonymous caller gets 30d without a refusal", async () => {
    // The free depth is a real product: the tool answers (or fails on the
    // hermetic env's missing data tier) -- what it must NOT do is demand
    // payment.
    const result = await callEconomicsTrends("30d");
    const error = (result.structuredContent as Row | undefined)?.error as
      Row | undefined;
    assert.notEqual(
      error?.code,
      "payment_required",
      "a 30-day window must never be gated",
    );
  });
});

describe("depth is gated; visibility is not", () => {
  test("the gated tool is still listed to an anonymous caller", async () => {
    const res = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      mockEnv(),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const json = text.startsWith("event:")
      ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
      : JSON.parse(text);
    const names = ((json.result as Row).tools as Row[]).map((tool) =>
      String(tool.name),
    );
    assert.ok(
      names.includes("get_economics_trends"),
      "a gated tool that disappears is a tool nobody upgrades for",
    );
    // And the free-tier economics entry point stays in the curated core set.
    assert.ok(MCP_CORE_TOOL_NAMES.includes("get_economics"));
  });
});

// #11562: the boundary above is only reachable if a caller can BE on a tier.
// Until this landed, tier resolved solely from an `mg_` key, so an OAuth caller
// who completed the whole GitHub flow was measured `anonymous` -- 460 tool
// calls across 5 authenticated identities in production, every one of them.
//
// Composed from the REAL applyTieredRateLimit rather than a hand-written tier
// string, so this proves the chain (OAuth identity -> resolved tier -> the
// gate's verdict) rather than restating the gate's own assumption.
describe("an OAuth caller clears a boundary an anonymous caller does not", () => {
  const TIERS = {
    free: { envVar: "GATE_FREE_LIMITER", limit: 300, windowSeconds: 60 },
    paid: { envVar: "GATE_PAID_LIMITER", limit: 3000, windowSeconds: 60 },
  };
  const CONFIG = {
    anonymous: { envVar: "GATE_ANON_LIMITER", limit: 60, windowSeconds: 60 },
    keyed: TIERS.free,
    tiers: TIERS,
    keyPrefix: "gate",
  };
  const env = {
    GATE_ANON_LIMITER: { limit: async () => ({ success: true }) },
    GATE_PAID_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const request = () =>
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

  test("anonymous is refused a window past the free depth", async () => {
    const resolved = await applyTieredRateLimit(request(), env, CONFIG);
    assert.equal(resolved.tier, "anonymous");
    assert.throws(
      () => guard(resolved.tier, 365),
      (error: Error & { code?: string }) => error.code === "payment_required",
    );
  });

  test("the same window goes through for an OAuth account on paid", async () => {
    const resolved = await applyTieredRateLimit(request(), env, CONFIG, {
      oauthIdentity: { accountId: 7, tier: "paid" },
    });
    assert.equal(resolved.tier, "paid");
    assert.equal(resolved.accountKind, "github");
    assert.doesNotThrow(() => guard(resolved.tier, 365));
  });

  test("an OAuth account on the DEFAULT tier is still bounded", async () => {
    // `github_accounts.tier` defaults to 'free', so authenticating does not
    // silently hand out paid depth -- it makes the caller addressable, which
    // is what an upgrade then acts on.
    const resolved = await applyTieredRateLimit(request(), env, CONFIG, {
      oauthIdentity: { accountId: 7, tier: "free" },
    });
    assert.equal(resolved.tier, "free");
    assert.doesNotThrow(() => guard(resolved.tier, FREE_HISTORY_WINDOW_DAYS));
    assert.throws(
      () => guard(resolved.tier, 365),
      (error: Error & { code?: string }) => error.code === "payment_required",
    );
  });
});

// #11562: the same chain, driven through the REAL MCP entry point rather than
// applyTieredRateLimit directly -- so the props the OAuth provider sets on the
// ExecutionContext are proven to reach the tier resolver, which is the wiring
// that was missing.
describe("handleMcpRequest resolves a tier from the OAuth execution context", () => {
  function envWithTierLookup(tier: string | null, found = true) {
    return mockEnv({
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
      DATA_API: {
        fetch: async () =>
          new Response(JSON.stringify(found ? { found, tier } : { found }), {
            status: 200,
          }),
      },
      MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      MCP_RATE_LIMITER_KEYED: { limit: async () => ({ success: true }) },
      MCP_RATE_LIMITER_COMMUNITY: { limit: async () => ({ success: true }) },
      MCP_RATE_LIMITER_PAID: { limit: async () => ({ success: true }) },
    } as Row);
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const request = () =>
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    });

  test("an authenticated caller is served, and the lookup is consulted", async () => {
    const env = envWithTierLookup("paid");
    const res = await handleMcpRequest(request(), env, {
      executionCtx: { waitUntil() {}, props: { accountId: 7 } },
    });
    assert.equal(res.status, 200);
  });

  test("an account the lookup cannot resolve falls back to anonymous, not to a permissive default", async () => {
    // found:false, and a found-but-tierless row -- both must yield no identity.
    for (const env of [
      envWithTierLookup(null, false),
      envWithTierLookup(null, true),
      envWithTierLookup("", true),
    ]) {
      const res = await handleMcpRequest(request(), env, {
        executionCtx: { waitUntil() {}, props: { accountId: 7 } },
      });
      assert.equal(res.status, 200);
    }
  });

  test("an unreadable props.accountId never reaches the lookup", async () => {
    let called = 0;
    const env = mockEnv({
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
      DATA_API: {
        fetch: async () => {
          called += 1;
          return new Response("{}", { status: 200 });
        },
      },
      MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as Row);
    for (const accountId of [undefined, null, "abc", 0, -1]) {
      const res = await handleMcpRequest(request(), env, {
        executionCtx: { waitUntil() {}, props: { accountId } },
      });
      assert.equal(res.status, 200, String(accountId));
    }
    assert.equal(called, 0, "no lookup for a caller with no readable id");
  });

  test("no execution context at all is still served anonymously", async () => {
    const env = envWithTierLookup("paid");
    const res = await handleMcpRequest(request(), env, {});
    assert.equal(res.status, 200);
  });
});
