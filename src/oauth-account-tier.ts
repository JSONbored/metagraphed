// The tier behind an OAuth-authenticated caller (#11562).
//
// ## THE BUG THIS CLOSES
//
// `applyTieredRateLimit` resolved a tier from ONE thing: a valid `mg_...` key
// (workers/tiered-rate-limit.ts). An OAuth 2.1 access token our own provider
// issued is not an `mg_` key, so a caller who completed the entire GitHub
// authorization flow fell through to `anonymous` -- rate-limited, quota'd and
// priced exactly like a caller who sent nothing.
//
// Measured before the fix: over 60 days the `github:` distinct_id namespace
// carried 460 `$mcp_tool_call` events across 5 identities, EVERY ONE at tier
// `anonymous`. Five people authenticated and the access model did not notice.
// `api_keys` was empty at the same time, so the only path that could grant a
// tier had never been walked -- the whole ladder in src/api-tiers.ts had never
// had a single row of input.
//
// ## WHY A LOOKUP AND NOT A CLAIM IN THE GRANT
//
// The tier is already known at authorization time: the account upsert returns
// it (workers/data-api.ts) and src/github-oauth.ts then drops it on the floor.
// Carrying it in `props` instead would be free at request time -- and wrong.
// `props` is minted once by completeAuthorization and stored WITH the grant, so
// a tier baked into it does not move until the user re-consents. The first
// thing that will ever change a tier is a subscription upgrade, and a customer
// who has just paid must not have to log out to be served.
//
// src/api-tiers.ts already states the property being preserved here, for keys:
// the tier is read from the lookup on every request, so a server-side change
// takes effect without re-issuing the credential, bounded by the cache TTL.
//
// ## WHY THE TTL IS SHORTER THAN THE KEY CACHE'S
//
// api-key-validation.ts caches a valid key for 30 minutes, which is right for
// its job: that cache exists to keep `verifyKey()` call volume down, and key
// REVOCATION has its own faster path (the blocklist, on its own short TTL). No
// such second path exists for a tier change, so this cache's TTL *is* the
// upgrade latency. Five minutes keeps the read cheap while keeping "I paid and
// nothing happened" inside the window a person will sit through.

import { API_KEY_LOOKUP_TOKEN_HEADER } from "./api-key-validation.ts";

/** How long a resolved tier is cached. This is the upgrade latency -- see the
 * header for why it is not the key cache's 30 minutes. */
export const OAUTH_ACCOUNT_TIER_KV_TTL = 300; // 5 min
/** How long "no such account" is cached. Short, so an account that appears
 * (or a lookup that failed transiently) is not denied for a full TTL. */
export const OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL = 30;

export interface OAuthAccountTierRecord {
  found: boolean;
  tier?: unknown;
}

function cacheKeyFor(accountId: number): string {
  return `oauth-account-tier:${accountId}`;
}

/**
 * Normalise whatever `executionCtx.props.accountId` happens to hold.
 *
 * The OAuth provider stores props as JSON, so an id that went in as a number
 * can come back as a string -- and a grant minted by an older build may carry
 * neither. Everything that is not a positive integer resolves to null, which
 * the caller treats as "anonymous", never as a permissive default. This is the
 * same direction applyTieredRateLimit already takes for an unrecognised tier
 * and `tierClears` takes for an unknown one: an id we cannot read is not
 * evidence of entitlement.
 */
export function oauthAccountIdFrom(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Calls the data-api Worker's internal tier route over the service binding --
// the same gate and transport handleGithubAccountUpsert already uses, because
// the caller is the same Worker holding the same secret. Never throws: an
// upstream failure is `found: false`, which falls back to the anonymous
// ceiling rather than 500-ing a request that was otherwise fine.
async function lookupViaDataApi(
  env: Env,
  accountId: number,
): Promise<OAuthAccountTierRecord> {
  if (!env?.DATA_API?.fetch || !env?.API_KEY_LOOKUP_INTERNAL_TOKEN) {
    return { found: false };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/accounts/github/tier",
        {
          method: "POST",
          headers: {
            [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ account_id: accountId }),
        },
      ),
    );
    if (!upstream.ok) return { found: false };
    const record: Record<string, unknown> = await upstream.json();
    // `found` mirrors the route's own answer rather than being inferred from
    // the presence of `tier`, so "account exists, tier is null" stays
    // distinguishable from "no such account".
    return record.found
      ? { found: true, tier: record.tier ?? null }
      : { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * The current tier for an OAuth-authenticated account, KV-cache-fronted.
 *
 * Returns `{ found: false }` for an unreadable id, an unknown account, or any
 * upstream/KV failure -- one shape for every "we cannot say", so the caller has
 * exactly one branch to take and it is the safe one.
 */
export async function resolveOAuthAccountTier(
  env: Env,
  rawAccountId: unknown,
): Promise<OAuthAccountTierRecord> {
  const accountId = oauthAccountIdFrom(rawAccountId);
  if (accountId === null) return { found: false };

  const kv = env?.METAGRAPH_CONTROL;
  const cacheKey = cacheKeyFor(accountId);
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as OAuthAccountTierRecord;
    } catch {
      // KV read failure is non-fatal -- fall through to the live lookup.
    }
  }

  const payload = await lookupViaDataApi(env, accountId);
  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: payload.found
          ? OAUTH_ACCOUNT_TIER_KV_TTL
          : OAUTH_ACCOUNT_TIER_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }
  return payload;
}
