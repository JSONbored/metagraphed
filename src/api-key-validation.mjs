// KV-cache-fronted API key validation (ADR 0020 section 4 / ADR 0021 section
// 1's reuse). Resolves a caller-supplied mg_... key to its tier/revoked
// state without a Postgres round trip on every request -- mirrors
// src/address-mapping.mjs's env-taking + KV-cache-fronted-with-live-fallback
// shape, except the "live" fallback is a service-binding fetch to
// workers/data-api.mjs (the only place with a Postgres binding) rather than
// a chain RPC call.
//
// The cache is keyed by PREFIX only -- public, non-secret, safe as a cache
// key (src/api-keys.mjs's own header). The secret itself is never sent to
// data-api.mjs and never cached: it is compared locally, once per request,
// against the cached/looked-up secret_hash via isValidApiKeySecret.
import { isValidApiKeySecret, parseApiKey } from "./api-keys.mjs";

export const API_KEY_LOOKUP_KV_TTL = 300; // 5 min, matches ADR 0020's stated pattern
export const API_KEY_LOOKUP_NEGATIVE_KV_TTL = 30;
export const API_KEY_LOOKUP_TOKEN_HEADER = "x-api-key-lookup-token";

function cacheKeyFor(prefix) {
  return `api-key-lookup:${prefix}`;
}

// Looks up one prefix's stored record: KV cache first, then the data-api
// Worker's internal lookup route on a miss. Returns { found: false } (never
// null/throws) so callers have one shape to check regardless of source.
async function lookupApiKeyPrefix(env, prefix) {
  const kv = env?.METAGRAPH_CONTROL;
  const cacheKey = cacheKeyFor(prefix);
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached;
    } catch {
      // KV read failure is non-fatal -- fall through to the live lookup.
    }
  }

  let record = null;
  if (env?.DATA_API?.fetch && env?.API_KEY_LOOKUP_INTERNAL_TOKEN) {
    try {
      const upstream = await env.DATA_API.fetch(
        new Request(`https://api.metagraph.sh/api/v1/internal/keys/${prefix}`, {
          headers: {
            [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
          },
        }),
      );
      if (upstream.ok) record = await upstream.json();
    } catch {
      // Upstream failure is non-fatal -- treat as "not found" below rather
      // than throwing (a validation call must never 500 the caller's RPC
      // request; it just fails closed as "invalid key").
    }
  }

  const payload = record ? { found: true, ...record } : { found: false };
  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: record
          ? API_KEY_LOOKUP_KV_TTL
          : API_KEY_LOOKUP_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }
  return payload;
}

/** Validates a caller-supplied key end to end: format, lookup, secret
 * comparison, revocation. Returns { ok: true, tier, accountId } or
 * { ok: false, code }. Never throws on attacker-controlled input. */
export async function validateApiKey(env, rawKey) {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return { ok: false, code: "invalid_key" };
  const record = await lookupApiKeyPrefix(env, parsed.prefix);
  if (!record.found) return { ok: false, code: "invalid_key" };
  if (record.revoked_at) return { ok: false, code: "key_revoked" };
  const validSecret = await isValidApiKeySecret(
    parsed.secret,
    record.secret_hash,
  );
  if (!validSecret) return { ok: false, code: "invalid_key" };
  return { ok: true, tier: record.tier, accountId: record.account_id ?? null };
}
