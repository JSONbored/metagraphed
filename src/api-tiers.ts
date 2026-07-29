// Tier ceilings as code (#8608) -- ONE definition, shared by every tiered
// surface (MCP, AI, data, state-query, webhook).
//
// Two ceilings per tier, and they are deliberately scoped differently:
//
//   * PER-MINUTE is per SURFACE. Each surface has its own burst profile -- an
//     LLM-backed /ask cannot absorb the same requests-per-minute as a cached
//     artifact read -- so the numbers below are multipliers on whatever that
//     surface already allows a keyed caller, not absolute values.
//
//   * DAILY is per ACCOUNT, shared across all surfaces. It counts COST units
//     (src/route-cost-weights.ts), and `api_quota_daily` is keyed on
//     (account_id, day) with NO route dimension precisely so that one budget
//     covers everything an account does. Giving each surface its own daily cap
//     would mean an account's day could be exhausted five separate times,
//     which is not a budget anyone can reason about.
//
// A NAMED CLOUDFLARE BINDING IS ONE FIXED limit/period PAIR. The `limit` field
// on a policy is what the 429 headers advertise; the enforcement comes from
// the binding named in `envVar`. So every tier needs its OWN binding -- three
// tiers pointing at one binding silently throttles them all at that binding's
// number while advertising three different ones, which is worse than having no
// tiers at all (a paid caller capped at the free ceiling, and told otherwise).
// tests/api-tiers.test.ts asserts every envVar below exists in wrangler.jsonc
// with the limit its policy claims, so that mismatch cannot come back.

import type { RateLimitTierPolicy } from "../workers/tiered-rate-limit.ts";

/**
 * Per-minute ceiling as a multiple of the surface's existing keyed limit.
 *
 * `free` is exactly 1x on purpose: every key issued today is on `free`, and a
 * tier rollout must not retro-actively tighten anyone. It is the two tiers
 * above it that are new.
 */
export const TIER_RATE_MULTIPLIER = {
  free: 1,
  community: 3,
  paid: 10,
} as const;

/**
 * Daily ceiling in COST units (src/route-cost-weights.ts), per account, across
 * all surfaces. `free` is absent -- deliberately UNCAPPED daily, for the same
 * reason its multiplier is 1x: a daily quota is a paid-model control, not a
 * new restriction on people who already hold a key. The per-minute limiter
 * still bounds free callers.
 *
 * Sized off ADR 0022's cost shapes: 250k units is ~250k cached reads or ~10k
 * LLM-backed calls a day, which is far above any legitimate interactive use
 * and still cheap to serve; 2M is the same shape at the paid tier.
 */
export const TIER_DAILY_UNITS: Readonly<Record<string, number>> = {
  community: 250_000,
  paid: 2_000_000,
};

export const API_TIERS = ["free", "community", "paid"] as const;
export type ApiTier = (typeof API_TIERS)[number];

/**
 * Build a surface's per-tier policies from its existing keyed binding.
 *
 * `envVarPrefix` is the binding family (e.g. "MCP_RATE_LIMITER"): `free` keeps
 * the surface's existing `_KEYED` binding so nothing changes for today's
 * callers, and the new tiers get `_COMMUNITY` / `_PAID` bindings of their own.
 */
export function buildTierPolicies(
  envVarPrefix: string,
  keyedLimit: number,
  windowSeconds = 60,
): Record<ApiTier, RateLimitTierPolicy> {
  const suffix: Record<ApiTier, string> = {
    free: "_KEYED",
    community: "_COMMUNITY",
    paid: "_PAID",
  };
  return Object.fromEntries(
    API_TIERS.map((tier) => [
      tier,
      {
        envVar: `${envVarPrefix}${suffix[tier]}`,
        limit: keyedLimit * TIER_RATE_MULTIPLIER[tier],
        windowSeconds,
        ...(TIER_DAILY_UNITS[tier] === undefined
          ? {}
          : { dailyUnits: TIER_DAILY_UNITS[tier] }),
      },
    ]),
  ) as Record<ApiTier, RateLimitTierPolicy>;
}
