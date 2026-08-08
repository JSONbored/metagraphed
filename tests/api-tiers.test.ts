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
  CHAIN_FIREHOSE_INGEST_RATE_LIMIT,
  DATA_TIERED_RATE_LIMIT,
  INTERNAL_SYNC_RATE_LIMIT,
  WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
} from "../workers/api.ts";
import { FULLNODE_RPC_TIER_RATE_LIMITS } from "../workers/request-handlers/fullnode-rpc-proxy.ts";

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

// THE SAME BUG, ON THE BINDINGS THIS FILE'S TIERED LOOP NEVER LOOKED AT
// (#10180). `SURFACES` covers the five tiered configs, which is 20 of the 27
// bindings. The rest are flat -- one constant, one binding -- and nothing
// checked them, so `INTERNAL_SYNC_RATE_LIMIT` sat at 300 in workers/api.ts
// while INTERNAL_SYNC_RATE_LIMITER enforced 30 in wrangler.jsonc.
//
// That constant feeds ONLY the 429 response headers. Raising it advertised
// headroom that did not exist, and the producer kept being refused: the
// validator-nominators lane 429'd from 2026-08-07 18:22, freezing
// nominator_positions, validator_nominator_counts and hotkey_alpha together,
// because all three land through the same proxy.

/** Flat limiters: one advertised constant, one binding, no tiers. */
const FLAT_LIMITERS: [
  string,
  { limit: number; windowSeconds: number },
  string,
][] = [
  ["internal-sync", INTERNAL_SYNC_RATE_LIMIT, "INTERNAL_SYNC_RATE_LIMITER"],
  [
    "chain-firehose-ingest",
    CHAIN_FIREHOSE_INGEST_RATE_LIMIT,
    "CHAIN_FIREHOSE_INGEST_RATE_LIMITER",
  ],
];

/**
 * Bindings that enforce a limit but advertise no number to compare against.
 *
 * Listed rather than skipped by pattern: the coverage test below fails on any
 * binding that appears in neither this list nor a config, so a new limiter
 * cannot be added without someone deciding which kind it is. That decision is
 * the point -- an advertised limit needs pinning, an unadvertised one does not.
 */
const UNADVERTISED_BINDINGS = new Set([
  // src/mcp-server.ts's call_rpc guard returns a bare `rate_limited` with no
  // x-ratelimit headers, so there is no second number that could disagree.
  "RPC_RATE_LIMITER",
  // fullnode-rpc-proxy's pre-auth guess guard; its 429 carries the TIER's
  // numbers, checked below, not this binding's.
  "FULLNODE_RPC_GUESS_RATE_LIMITER",
]);

describe("untiered ceilings are backed by real bindings (#10180)", () => {
  const bindings = limiterBindings();

  for (const [name, policy, envVar] of FLAT_LIMITERS) {
    test(`${name}: enforces the ${policy.limit}/${policy.windowSeconds}s it advertises`, () => {
      const binding = bindings.get(envVar);
      assert.ok(binding, `${envVar} exists in wrangler.jsonc`);
      assert.equal(
        binding.limit,
        policy.limit,
        `${envVar} enforces the limit ${name}'s 429 headers advertise`,
      );
      assert.equal(binding.period, policy.windowSeconds);
    });
  }

  for (const [tier, policy] of Object.entries(FULLNODE_RPC_TIER_RATE_LIMITS)) {
    test(`fullnode-rpc ${tier}: enforces the ${policy.limit}/min it advertises`, () => {
      const binding = bindings.get(policy.envVar);
      assert.ok(binding, `${policy.envVar} exists in wrangler.jsonc`);
      assert.equal(binding.limit, policy.limit);
      assert.equal(binding.period, policy.windowSeconds);
    });
  }

  test("every binding in wrangler.jsonc is claimed by some config", () => {
    // The hole this closes is the one that produced #10180: a binding nothing
    // compares against drifts silently, and drift is invisible in the
    // direction that matters -- the enforced number is the low one.
    // Not vacuous: an empty parse would make `orphans` empty and pass.
    assert.ok(
      bindings.size >= 20,
      `limiterBindings() parsed ${bindings.size} bindings -- it reads wrangler.jsonc`,
    );
    const claimed = new Set<string>(UNADVERTISED_BINDINGS);
    for (const [, config] of SURFACES) {
      for (const policy of [config.anonymous, config.keyed]) {
        claimed.add(policy.envVar);
      }
      for (const tier of API_TIERS) {
        const policy = config.tiers?.[tier];
        if (policy) claimed.add(policy.envVar);
      }
    }
    for (const [, , envVar] of FLAT_LIMITERS) claimed.add(envVar);
    for (const policy of Object.values(FULLNODE_RPC_TIER_RATE_LIMITS)) {
      claimed.add(policy.envVar);
    }
    const orphans = [...bindings.keys()].filter((name) => !claimed.has(name));
    assert.deepEqual(
      orphans,
      [],
      "each of these enforces a limit no config declares -- add it to a tier " +
        "config, to FLAT_LIMITERS, or to UNADVERTISED_BINDINGS",
    );
  });
});
