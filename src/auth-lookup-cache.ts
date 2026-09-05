import { recordOrNull } from "./read-store.ts";

interface AuthLookupCachePolicy {
  positiveTtlSeconds: number;
  negativeTtlSeconds: number;
}

/** Auth answers share one key: an observed rejection must replace a grant.
 * KV is eventually consistent and concurrent writes remain last-write-wins;
 * these timestamps bound reuse, not the ordering of authorization decisions.
 * Versioned reader namespaces keep these envelopes isolated from legacy code.
 */
export function authLookupCacheWrite<T extends { found: boolean }>(
  record: T,
  policy: AuthLookupCachePolicy,
): { value: string; expirationTtl: number } {
  const ttl = record.found
    ? policy.positiveTtlSeconds
    : policy.negativeTtlSeconds;
  const cachedAt = Date.now();
  return {
    value: JSON.stringify({
      auth_lookup_cache_version: 1,
      cached_at_ms: cachedAt,
      expires_at_ms: cachedAt + ttl * 1000,
      record,
    }),
    // Workers KV rejects expirationTtl below 60 seconds. The envelope retains
    // the shorter logical retry lifetime even while its physical entry exists.
    expirationTtl: Math.max(60, ttl),
  };
}

export function readAuthLookupCache(
  value: unknown,
  policy: AuthLookupCachePolicy,
): ({ found: boolean } & Record<string, unknown>) | null {
  const envelope = recordOrNull(value);
  if (envelope?.auth_lookup_cache_version !== 1) return null;
  const record = recordOrNull(envelope.record);
  if (!record || typeof record.found !== "boolean") return null;
  const cachedAt = envelope.cached_at_ms;
  const expiresAt = envelope.expires_at_ms;
  if (
    typeof cachedAt !== "number" ||
    !Number.isSafeInteger(cachedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return null;
  }
  const ttl = record.found
    ? policy.positiveTtlSeconds
    : policy.negativeTtlSeconds;
  const now = Date.now();
  if (
    cachedAt > now ||
    expiresAt <= now ||
    expiresAt - cachedAt !== ttl * 1000
  ) {
    return null;
  }
  return { ...record, found: record.found };
}
