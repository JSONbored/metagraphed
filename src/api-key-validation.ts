// KV-cache-fronted API key validation (freemium-API rework, 2026-07-19).
// Resolves a caller-supplied mg_... key to its Unkey-verified identity
// with cached provider verification for managed keys -- mirrors this file's
// original ADR 0020/0021 shape, except the "live" fallback on a cache miss
// now calls Unkey's verifyKey() (via the DATA_API service binding's internal
// route, the only place holding UNKEY_ROOT_KEY -- src/unkey-client.ts)
// instead of a Postgres secret_hash lookup.
//
// The cache is keyed by a LOCAL SHA-256 hash of the full raw key, not a
// public prefix: Unkey's key format (mg_<opaque random>) has no separate
// public/non-secret prefix segment the way the old mg_<prefix>_<secret>
// format did, so there's nothing else safe to key a cache entry by. Hashing
// locally costs nothing (no network round trip) and never reveals the key
// even if the KV namespace itself were ever exposed (one-way digest). This
// module itself never imports src/unkey-client.ts -- the actual Unkey call
// happens on the OTHER side of the DATA_API service-binding hop (that
// Worker is the only place holding UNKEY_ROOT_KEY); this file only ever
// talks to DATA_API's internal route.
//
// TTL is asymmetric and deliberately NOT the same for every outcome: a
// verified, valid key gets a long TTL (30 min) -- this is the one place
// accepting eventual consistency for provider identity changes (NOT rate-limiting;
// see src/unkey-client.ts's header for why that stays live/uncached), and a
// longer TTL directly cuts how often verifyKey() gets called, keeping usage
// comfortably inside Unkey's free tier. An observed rejection is reused for
// only 30s before retrying. Cached managed identities require a fresh ledger
// state check on every request. Unmanaged credentials are verified externally
// each time. Provider-side changes to managed keys still require provider
// refresh; account blocklist and request rate/quota checks run separately.
import {
  authLookupCacheWrite,
  readAuthLookupCache,
} from "./auth-lookup-cache.ts";
import { isUnkeyKeyId } from "./api-key-state.ts";

export const API_KEY_LOOKUP_KV_TTL = 1800; // 30 min
export const API_KEY_LOOKUP_NEGATIVE_KV_TTL = 30;
export const API_KEY_LOOKUP_TOKEN_HEADER = "x-api-key-lookup-token";

const CACHE_POLICY = {
  positiveTtlSeconds: API_KEY_LOOKUP_KV_TTL,
  negativeTtlSeconds: API_KEY_LOOKUP_NEGATIVE_KV_TTL,
};

// Loose, not an exact-length assertion -- Unkey's own random-suffix
// charset/length isn't a contract this codebase hard-codes. Just enough to
// fail fast on obviously-wrong input (empty, wrong tag, way too short)
// without a real Unkey/KV round trip.
const MIN_BARE_KEY_LENGTH = 20;

function bareKeyFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.startsWith("Bearer ") ? value.slice(7) : value;
  if (!bare.startsWith("mg_") || bare.length < MIN_BARE_KEY_LENGTH) return null;
  return bare;
}

async function hashKeyForCache(bareKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bareKey),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cacheKeyFor(hash: string): string {
  return `api-key-lookup:v3:${hash}`;
}

export interface ApiKeyLookupRecord {
  found: boolean;
  code?: unknown;
  tier?: unknown;
  accountId?: unknown;
  keyId?: unknown;
  managed?: unknown;
}

// Calls the data-api Worker's internal verify route (the only place holding
// UNKEY_ROOT_KEY) with the raw key. Returns
// { found, code, tier, accountId, keyId, managed } -- found requires a valid
// provider identity and the data Worker's current ledger guard,
// never null/throws, so callers have one shape to check regardless of
// whether the upstream call itself succeeded.
async function lookupViaDataApi(
  env: Env,
  bareKey: string,
): Promise<ApiKeyLookupRecord> {
  if (!env?.DATA_API?.fetch || !env?.API_KEY_LOOKUP_INTERNAL_TOKEN) {
    return { found: false };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request("https://api.metagraph.sh/api/v1/internal/keys/verify", {
        method: "POST",
        headers: {
          [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ key: bareKey }),
      }),
    );
    if (!upstream.ok) return { found: false };
    const record: Record<string, unknown> = await upstream.json();
    if (
      record.valid === true &&
      (!isUnkeyKeyId(record.keyId) || typeof record.managed !== "boolean")
    ) {
      return { found: false };
    }
    return {
      found: record.valid === true,
      code: record.code,
      tier: record.tier ?? null,
      accountId: record.accountId ?? null,
      keyId: record.keyId,
      managed: record.managed,
    };
  } catch {
    // Upstream failure is non-fatal -- treated as "not found" below rather
    // than throwing (a validation call must never 500 the caller's RPC
    // request; it just fails closed as "invalid key").
    return { found: false };
  }
}

async function checkCachedApiKey(
  env: Env,
  record: ApiKeyLookupRecord,
): Promise<ApiKeyLookupRecord | null> {
  if (!record.found) return record;
  // Old or malformed positives cannot skip fresh provider verification.
  if (record.managed !== true || !isUnkeyKeyId(record.keyId)) return null;
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN)
    return { found: false };
  try {
    const upstream = await env.DATA_API.fetch(
      new Request("https://api.metagraph.sh/api/v1/internal/keys/state", {
        method: "POST",
        headers: {
          [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          keyId: record.keyId,
          accountId: record.accountId,
        }),
      }),
    );
    if (!upstream.ok) return { found: false };
    const body: Record<string, unknown> = await upstream.json();
    if (body.state === "active") return record;
    // A missing ledger row is compatibility fallback, not authorization.
    // The verification route will check the ledger again after the provider.
    if (body.state === "unmanaged") return null;
    return {
      found: false,
      code:
        body.state === "pending" || body.state === "revoked"
          ? "DISABLED"
          : "NOT_FOUND",
    };
  } catch {
    return { found: false };
  }
}

async function lookupApiKey(
  env: Env,
  bareKey: string,
): Promise<ApiKeyLookupRecord> {
  const kv = env?.METAGRAPH_CONTROL;
  const cacheKey = cacheKeyFor(await hashKeyForCache(bareKey));
  if (kv?.get) {
    try {
      const cached = readAuthLookupCache(
        await kv.get(cacheKey, { type: "json" }),
        CACHE_POLICY,
      );
      if (cached) {
        const checked = await checkCachedApiKey(env, cached);
        if (checked) return checked;
      }
    } catch {
      // KV read failure is non-fatal -- fall through to the live lookup.
    }
  }

  const payload = await lookupViaDataApi(env, bareKey);
  if (kv?.put && (!payload.found || payload.managed === true)) {
    try {
      const entry = authLookupCacheWrite(payload, CACHE_POLICY);
      await kv.put(cacheKey, entry.value, {
        expirationTtl: entry.expirationTtl,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }
  return payload;
}

export type ApiKeyValidationResult =
  | { ok: true; tier: unknown; accountId: unknown }
  | { ok: false; code: "invalid_key" | "key_revoked" };

/** Validates a caller-supplied key end to end: format, KV-cache-fronted
 * Unkey verification. Returns { ok: true, tier, accountId } or
 * { ok: false, code }. Never throws on attacker-controlled input. */
export async function validateApiKey(
  env: Env,
  rawKey: unknown,
): Promise<ApiKeyValidationResult> {
  const bareKey = bareKeyFrom(rawKey);
  if (!bareKey) return { ok: false, code: "invalid_key" };
  const record = await lookupApiKey(env, bareKey);
  if (!record.found) {
    return {
      ok: false,
      code: record.code === "DISABLED" ? "key_revoked" : "invalid_key",
    };
  }
  return { ok: true, tier: record.tier, accountId: record.accountId };
}
