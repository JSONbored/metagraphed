// #8608: the tier ceilings, and the invariant that binds them to reality.
//
// The bug this file exists to prevent: a tiers map whose three policies all
// named ONE Cloudflare binding. A named binding is one fixed limit/period
// pair, so all three tiers were really throttled at that binding's number
// while the 429 headers advertised three different ones -- a paid caller
// capped at the free ceiling and explicitly told otherwise. Every policy's
// advertised `limit` is now checked against the binding that actually enforces
// it, so config and infrastructure cannot drift apart silently again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  API_TIERS,
  TIER_DAILY_UNITS,
  TIER_RATE_MULTIPLIER,
  buildTierPolicies,
} from "../src/api-tiers.ts";
import type {
  RateLimitTierPolicy,
  TieredRateLimitConfig,
} from "../workers/tiered-rate-limit.ts";
import { MCP_TIERED_RATE_LIMIT } from "../src/mcp-server.ts";
import { AI_TIERED_RATE_LIMIT } from "../src/ai-search.ts";
import { STATE_QUERY_TIERED_RATE_LIMIT } from "../workers/request-handlers/rpc-proxy.ts";
import {
  DATA_TIERED_RATE_LIMIT,
  WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
} from "../workers/api.ts";

/** wrangler.jsonc's `ratelimits`, by binding name. */
function limiterBindings(): Map<string, { limit: number; period: number }> {
  const raw = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  )
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(raw) as {
    ratelimits?: { name: string; simple: { limit: number; period: number } }[];
  };
  return new Map(
    (parsed.ratelimits ?? []).map((entry) => [entry.name, entry.simple]),
  );
}

const SURFACES: [string, TieredRateLimitConfig][] = [
  ["mcp", MCP_TIERED_RATE_LIMIT],
  ["ai", AI_TIERED_RATE_LIMIT],
  ["data", DATA_TIERED_RATE_LIMIT],
  ["state-query", STATE_QUERY_TIERED_RATE_LIMIT],
  ["webhook", WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT],
];

describe("tier ceilings are backed by real bindings (#8608)", () => {
  const bindings = limiterBindings();

  for (const [name, config] of SURFACES) {
    test(`${name}: every tier has its OWN binding, at the limit it advertises`, () => {
      const tiers = config.tiers;
      assert.ok(tiers, `${name} defines per-tier ceilings`);
      const seen = new Set<string>();
      for (const tier of API_TIERS) {
        const policy: RateLimitTierPolicy | undefined = tiers[tier];
        assert.ok(policy, `${name}.${tier} is priced`);
        const binding = bindings.get(policy.envVar);
        assert.ok(
          binding,
          `${policy.envVar} exists in wrangler.jsonc (${name}.${tier})`,
        );
        // The header number and the enforced number must be the SAME number.
        assert.equal(
          binding.limit,
          policy.limit,
          `${policy.envVar} enforces the ${policy.limit}/min ${name}.${tier} advertises`,
        );
        assert.equal(binding.period, policy.windowSeconds);
        assert.ok(
          !seen.has(policy.envVar),
          `${policy.envVar} is not shared with another tier on ${name}`,
        );
        seen.add(policy.envVar);
      }
    });

    test(`${name}: anonymous and the keyed fallback are unchanged and real`, () => {
      // "Anonymous (keyless) access keeps current public limits; nothing
      // existing breaks" -- #8608's own scope.
      for (const policy of [config.anonymous, config.keyed]) {
        const binding = bindings.get(policy.envVar);
        assert.ok(binding, `${policy.envVar} exists`);
        assert.equal(binding.limit, policy.limit);
      }
      // free is exactly the pre-existing keyed ceiling: no key issued today
      // loses headroom on this change.
      assert.equal(config.tiers?.free.limit, config.keyed.limit);
      assert.equal(config.tiers?.free.envVar, config.keyed.envVar);
    });

    test(`${name}: only the paid tiers carry a daily quota`, () => {
      assert.equal(
        config.tiers?.free.dailyUnits,
        undefined,
        "free is uncapped daily -- a quota is a paid control, not a new restriction",
      );
      assert.equal(
        config.tiers?.community.dailyUnits,
        TIER_DAILY_UNITS.community,
      );
      assert.equal(config.tiers?.paid.dailyUnits, TIER_DAILY_UNITS.paid);
    });
  }

  test("the daily budget is per ACCOUNT, identical across every surface", () => {
    // api_quota_daily is keyed (account_id, day) with no route dimension, so a
    // per-surface daily number would be counted against one shared row and the
    // effective cap would depend on which surface you happened to hit first.
    for (const tier of ["community", "paid"] as const) {
      const values = new Set(
        SURFACES.map(([, config]) => config.tiers?.[tier].dailyUnits),
      );
      assert.equal(values.size, 1, `${tier} has one daily budget, not five`);
      assert.equal([...values][0], TIER_DAILY_UNITS[tier]);
    }
  });
});

describe("buildTierPolicies", () => {
  test("derives limits from the surface's own keyed ceiling", () => {
    const policies = buildTierPolicies("X_LIMITER", 100);
    assert.equal(policies.free.limit, 100 * TIER_RATE_MULTIPLIER.free);
    assert.equal(
      policies.community.limit,
      100 * TIER_RATE_MULTIPLIER.community,
    );
    assert.equal(policies.paid.limit, 100 * TIER_RATE_MULTIPLIER.paid);
    assert.equal(policies.free.envVar, "X_LIMITER_KEYED");
    assert.equal(policies.community.envVar, "X_LIMITER_COMMUNITY");
    assert.equal(policies.paid.envVar, "X_LIMITER_PAID");
  });

  test("omits dailyUnits entirely for free rather than setting it to zero", () => {
    // applyTieredRateLimit gates on `if (policy.dailyUnits)`, so a 0 and an
    // absent field behave the same today -- but `dailyUnits: 0` reads as "no
    // allowance at all", which is the opposite of what free means.
    const policies = buildTierPolicies("X_LIMITER", 100);
    assert.ok(!("dailyUnits" in policies.free));
    assert.equal(policies.community.dailyUnits, TIER_DAILY_UNITS.community);
  });

  test("honours a non-default window", () => {
    const policies = buildTierPolicies("X_LIMITER", 10, 10);
    for (const tier of API_TIERS) {
      assert.equal(policies[tier].windowSeconds, 10);
    }
  });
});
