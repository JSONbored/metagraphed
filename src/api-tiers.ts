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

import type {
  RateLimitTierPolicy,
  TieredRateLimitConfig,
} from "../workers/tiered-rate-limit.ts";

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

/**
 * The MCP surface's tiered rate-limit policy.
 *
 * #8520: anonymous callers keep the existing MCP_RATE_LIMITER ceiling (100/60s,
 * IP-keyed, unchanged); a caller presenting a valid mg_... key gets the 5x
 * MCP_RATE_LIMITER_KEYED tier, keyed by account id via the SEPARATE binding --
 * never the same binding at a different number.
 *
 * HERE RATHER THAN IN src/mcp-server.ts, which is where it lived (#10238).
 * workers/data-api.ts imports it for ONE number, and that import dragged
 * mcp-server -- and through it src/graphql.ts and workers/api.ts -- into
 * data-api's bundle, pushing it over the Worker STARTUP CPU limit. Measured:
 * cutting that edge and one other took data-api from 1072 KiB gzip / ~600 ms
 * module init to 377 KiB / ~220 ms.
 *
 * This module is the right home anyway: buildTierPolicies is already here, and
 * a rate-limit ceiling is tier configuration rather than protocol handling.
 * mcp-server.ts re-exports it so nothing else had to change.
 */
export const MCP_TIERED_RATE_LIMIT: TieredRateLimitConfig = {
  anonymous: { envVar: "MCP_RATE_LIMITER", limit: 100, windowSeconds: 60 },
  // Fallback for a valid key on a tier not priced below -- never an outage.
  keyed: { envVar: "MCP_RATE_LIMITER_KEYED", limit: 500, windowSeconds: 60 },
  // #8608: the ceilings as code, one entry per rpc_accounts.tier. Until now
  // every key got the single `keyed` policy regardless of tier, so a paid
  // account and a free one were throttled identically -- the tier was resolved
  // by validateApiKey and then discarded.
  //
  // `free` reuses MCP_RATE_LIMITER_KEYED at its existing 500/min, so nobody
  // holding a key today loses headroom. `community` and `paid` get bindings of
  // their OWN -- see the note on buildTierPolicies for why sharing one is not
  // an option.
  tiers: buildTierPolicies("MCP_RATE_LIMITER", 500),
  keyPrefix: "mcp",
};
