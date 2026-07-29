// Shared tiered rate-limit helper (#8386), generalized from
// workers/request-handlers/fullnode-rpc-proxy.ts's own
// FULLNODE_RPC_TIER_RATE_LIMITS pattern (ADR 0021) so a general public-API
// route can opt into "anonymous vs. self-serve keyed" tiering without
// re-deriving that pattern per route.
//
// A caller with a valid `mg_...` API key (src/api-key-validation.ts) gets the
// route's `keyed` policy, keyed by accountId (stable per account, so many
// callers legitimately sharing one key aren't starved, and rotating source
// IPs can't inflate one key's effective ceiling). Everyone else gets the
// route's unchanged `anonymous` policy, keyed by client IP -- the existing,
// regression-tested posture every route already has today.
//
// Deliberately still a Cloudflare-native Rate Limiting binding per tier (not
// Unkey's own per-key ratelimits) -- same reasoning as the fullnode gate's
// own header comment: this repo's rate limiting stays on infrastructure this
// codebase can introspect/test directly, not a third party's opaque counter.
import { resolveClientIp } from "./config.ts";
import { validateApiKey } from "../src/api-key-validation.ts";

export interface RateLimitTierPolicy {
  /** Env binding name for this tier's Cloudflare Rate Limiting binding. */
  envVar: string;
  limit: number;
  windowSeconds: number;
}

export interface TieredRateLimitConfig {
  anonymous: RateLimitTierPolicy;
  /**
   * Fallback for a valid key whose tier has no entry in `tiers` -- an account
   * on a tier this route has not priced yet, or a tier string we do not
   * recognise. Deliberately a fallback rather than an error: an unpriced tier
   * must never become an outage for a paying caller.
   */
  keyed: RateLimitTierPolicy;
  /**
   * Per-tier ceilings, keyed by `rpc_accounts.tier` (#8608). Before this, every
   * valid key got the single `keyed` policy no matter what tier it was on --
   * `validateApiKey` already resolved the tier and the result was thrown away,
   * so a paid account and a free one were rate-limited identically and #6646
   * had nothing to attach a paid model to.
   *
   * The tier is read from the key lookup on every request, so a server-side
   * tier change takes effect WITHOUT re-issuing the key -- bounded by the
   * lookup's KV cache (API_KEY_LOOKUP_KV_TTL, 30 min), not by the key's
   * lifetime.
   */
  tiers?: Record<string, RateLimitTierPolicy>;
  /** Short label used in the rate-limit key, e.g. "data" -- keeps different
   * routes' limiter keys from colliding if they ever share a binding. */
  keyPrefix: string;
}

export interface TieredRateLimitResult {
  allowed: boolean;
  policy: RateLimitTierPolicy;
  /** The tier the policy was chosen for: a tier name, or "anonymous". */
  tier: string;
  /** The verified account id when a valid API key was supplied, else null
   * (anonymous, IP-keyed). */
  accountId: string | null;
}

/**
 * Resolves which tier applies (valid `mg_...` key -> keyed, else anonymous)
 * and checks that tier's Cloudflare Rate Limiting binding. Never throws on
 * attacker-controlled input -- an invalid/malformed key silently falls back
 * to the anonymous tier rather than rejecting the request outright (a bad
 * key is not itself abuse; the anonymous ceiling still applies to it).
 */
export async function applyTieredRateLimit(
  request: Request,
  env: Env,
  config: TieredRateLimitConfig,
): Promise<TieredRateLimitResult> {
  const authHeader = request.headers.get("authorization");
  const auth = authHeader
    ? await validateApiKey(env, authHeader)
    : { ok: false as const };

  if (auth.ok) {
    const tier = typeof auth.tier === "string" && auth.tier ? auth.tier : null;
    const policy = (tier && config.tiers?.[tier]) || config.keyed;
    const limiter = (env as unknown as Record<string, RateLimit | undefined>)[
      policy.envVar
    ];
    const result = {
      policy,
      tier: tier ?? "keyed",
      accountId: String(auth.accountId),
    };
    if (!limiter?.limit) return { allowed: true, ...result };
    // Keyed by account AND tier: moving an account between tiers must start a
    // fresh window on the new ceiling rather than inheriting the old tier's
    // partially-spent one, which would otherwise let a downgrade be dodged (or
    // an upgrade be throttled) for the rest of the window.
    const { success } = await limiter.limit({
      key: `${config.keyPrefix}:${result.tier}:${auth.accountId}`,
    });
    return { allowed: success, ...result };
  }

  const policy = config.anonymous;
  const limiter = (env as unknown as Record<string, RateLimit | undefined>)[
    policy.envVar
  ];
  if (!limiter?.limit) {
    return { allowed: true, policy, tier: "anonymous", accountId: null };
  }
  const { success } = await limiter.limit({
    key: `${config.keyPrefix}:${resolveClientIp(request)}`,
  });
  return { allowed: success, policy, tier: "anonymous", accountId: null };
}

/**
 * Headers for a 429 raised by applyTieredRateLimit's result. `x-ratelimit-
 * remaining` is always "0" -- a 429 means the limit was hit, so that's true
 * by definition, not an estimate. `x-ratelimit-reset` is an upper-bound
 * APPROXIMATION (now + the window length), not the real window boundary --
 * Cloudflare's Rate Limiting binding (`.limit()`) only ever returns a
 * success/fail boolean, it exposes no remaining-count or exact reset instant
 * to derive an exact value from. Documented here rather than fabricating
 * precision the underlying primitive doesn't have.
 */
export function tieredRateLimitHeaders(
  policy: RateLimitTierPolicy,
  tier?: string,
): Record<string, string> {
  const resetAt = new Date(
    Date.now() + policy.windowSeconds * 1000,
  ).toISOString();
  return {
    "retry-after": String(policy.windowSeconds),
    "x-ratelimit-limit": String(policy.limit),
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": resetAt,
    "x-ratelimit-policy": `${policy.limit};w=${policy.windowSeconds}`,
    // #8608: which ceiling this caller was measured against. Without it a 429
    // is unactionable -- a caller cannot tell "you are on free, upgrade" from
    // "you are on paid and genuinely over", which is the first question anyone
    // asks when they get rate limited.
    ...(tier ? { "x-ratelimit-tier": tier } : {}),
  };
}
