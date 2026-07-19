// Thin fetch wrapper for Unkey's v2 keys.* API (freemium-API rework,
// 2026-07-19) -- replaces src/api-keys.mjs's local mg_... generation/hashing
// and the Postgres-backed secret_hash comparison previously done in
// src/api-key-validation.mjs. Unkey is now the actual key store: it mints,
// hashes, verifies, and revokes every key; this codebase only keeps a thin
// (account_id, unkey_key_id) mapping row (workers/data-api.mjs) for listing/
// ownership checks.
//
// Deliberately does NOT use Unkey's own per-key `ratelimits` as the request-
// throttling mechanism. That was the first design tried here, and it doesn't
// work with a KV-cache-fronted validator: a rate-limit decision from
// verifyKey() is only accurate at the instant it's checked, but this
// module's cache TTL is tens of minutes (accepted for identity/revocation,
// where eventual consistency is fine) -- caching a "not rate limited"
// verdict for that long would let a burst in second one get replayed as
// "fine" for the rest of the window, and re-checking Unkey live on every
// request to avoid that defeats the entire reason for caching (staying
// comfortably inside Unkey's free-tier request quota). So: Unkey stays the
// identity/secret layer only; actual per-request throttling is still
// Cloudflare's own Rate Limiting bindings (FULLNODE_RPC_RATE_LIMITER*,
// unchanged), now keyed by the stable `accountId`/`keyId` this module
// returns instead of the old local `prefix`. `tier` here is informational
// (stored in Unkey's `meta`, shown on verify) -- rpc_accounts.tier in
// Postgres is still the source of truth callers key their own rate-limit
// binding selection on.
//
// Every call needs env.UNKEY_ROOT_KEY (a root key scoped to ONLY this
// workspace's one API/keyspace -- api.<UNKEY_API_ID>.{create,verify,update,
// delete}_key, never the account-wide api.*.* wildcard) and env.UNKEY_API_ID
// (the keyspace's public apiId, not a secret). See wrangler.data.jsonc's own
// provisioning comment.
const UNKEY_BASE_URL = "https://api.unkey.com";

// Never throws on a network failure, a non-2xx response, or a malformed
// response body -- a key-management/verification call must fail closed with
// a discriminated result, not crash the caller's request.
async function unkeyFetch(env, path, body) {
  if (!env?.UNKEY_ROOT_KEY || !env?.UNKEY_API_ID) {
    return { ok: false, code: "unkey_not_configured" };
  }
  let response;
  try {
    response = await fetch(`${UNKEY_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.UNKEY_ROOT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "unkey_unreachable" };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: "unkey_invalid_response" };
  }
  if (!response.ok || !payload?.data) {
    return { ok: false, code: "unkey_error", status: response.status };
  }
  return { ok: true, data: payload.data };
}

/** Mints a new key under this deployment's one API/keyspace. `externalId` is
 * this codebase's own account identifier (rpc_accounts.id, stringified) --
 * Unkey's own opaque link back to "whose key is this," never the ss58
 * address itself. `tier` is stored in `meta` purely for display/debugging;
 * see this file's header for why it isn't an Unkey-side rate limit. Returns
 * { ok: true, keyId, key } -- `key` is the full mg_... credential, returned
 * only once, exactly like the old generateApiKey() contract. */
export async function createUnkeyKey(env, { externalId, tier }) {
  const result = await unkeyFetch(env, "/v2/keys.createKey", {
    apiId: env.UNKEY_API_ID,
    externalId,
    meta: { tier },
  });
  if (!result.ok) return result;
  return { ok: true, keyId: result.data.keyId, key: result.data.key };
}

/** Verifies a caller-supplied raw key against Unkey: identity, revocation,
 * and expiry only -- no rate-limit check (see this file's header). Returns
 * { ok: true, valid, code, keyId, tier, accountId } on a successful CALL to
 * Unkey (valid may still be false -- e.g. NOT_FOUND/DISABLED/EXPIRED, see
 * `code`) or { ok: false, code } if Unkey itself couldn't be reached/
 * misconfigured -- callers must treat ok:false the same as valid:false
 * (fail closed), never distinguish the two into a different error surface. */
export async function verifyUnkeyKey(env, rawKey) {
  const result = await unkeyFetch(env, "/v2/keys.verifyKey", { key: rawKey });
  if (!result.ok) return result;
  const { valid, code, keyId, meta, identity } = result.data;
  return {
    ok: true,
    valid: !!valid,
    code,
    keyId,
    tier: meta?.tier ?? null,
    accountId: identity?.externalId ?? null,
  };
}

/** Updates the display-only tier stamped on an existing key's `meta` -- the
 * internal tier-promotion route's mechanism. Does NOT change any Unkey-side
 * rate limit (there isn't one); the caller's own rpc_accounts.tier row is
 * what actually changes the request-throttling binding selection. */
export async function updateUnkeyKeyTier(env, { keyId, tier }) {
  return unkeyFetch(env, "/v2/keys.updateKey", { keyId, meta: { tier } });
}

/** Revokes a key by disabling it (keys.updateKey enabled:false), not
 * deleting it -- Unkey's own documented recommendation for user-initiated
 * self-serve revocation: immediately invalidated (verifyKey() reports
 * `DISABLED`), but structurally reversible at the Unkey level as a safety
 * net if a key is ever revoked by mistake, unlike keys.deleteKey (reserved
 * for admin-driven security incidents, not exposed here). This codebase's
 * OWN /api/v1/keys route still never exposes a reactivate endpoint -- that
 * one-way behavior is enforced at our API layer, not by permanently
 * destroying the underlying key. */
export async function revokeUnkeyKey(env, keyId) {
  return unkeyFetch(env, "/v2/keys.updateKey", { keyId, enabled: false });
}
