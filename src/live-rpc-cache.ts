// Logical retry windows are independent of Workers KV's 60-second expiry floor.
// https://developers.cloudflare.com/kv/api/write-key-value-pairs/#parameters
const LIVE_RPC_CACHE_MIN_KV_TTL = 60;

/** Minimal binding surface, also accepted by the conviction reader's KvLike. */
interface LiveRpcKv {
  get?: (key: string, options: { type: "json" }) => Promise<unknown>;
  put?: (
    key: string,
    value: string,
    options: { expirationTtl: number },
  ) => Promise<unknown>;
}

interface ShortCacheEntry {
  live_rpc_cache_version: 1;
  expires_at_ms: number;
  value: unknown;
}

function shortCacheValue(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as ShortCacheEntry;
  if (
    entry.live_rpc_cache_version !== 1 ||
    !Number.isSafeInteger(entry.expires_at_ms) ||
    entry.expires_at_ms <= Date.now() ||
    entry.value === null ||
    typeof entry.value !== "object" ||
    Array.isArray(entry.value)
  ) {
    return null;
  }
  return entry.value;
}

/** Failures never share a write key with successes. KV has no compare-and-swap. */
export function liveRpcFailureCacheKey(key: string): string {
  return `${key}:failure:v1`;
}

/**
 * Prefer a successful observation for its existing TTL, even if an overlapping
 * request failed later. Legacy successful bodies keep their original key/shape.
 * Storage errors propagate to the reader's existing non-fatal fallback.
 */
export async function readLiveRpcCache<T>(
  kv: LiveRpcKv,
  key: string,
  accepts: (value: T) => boolean = () => true,
): Promise<T | null> {
  const raw = await kv.get!(key, { type: "json" });
  const value =
    raw &&
    typeof raw === "object" &&
    Object.hasOwn(raw, "live_rpc_cache_version")
      ? shortCacheValue(raw)
      : raw;
  if (value != null && accepts(value as T)) return value as T;
  const failure = shortCacheValue(
    await kv.get!(liveRpcFailureCacheKey(key), { type: "json" }),
  );
  return failure != null && accepts(failure as T) ? (failure as T) : null;
}

/** Logical expiry is exclusive; retained failure keys cannot extend retry time. */
export async function writeLiveRpcCache(
  kv: LiveRpcKv,
  key: string,
  value: unknown,
  { ttlSeconds, negative }: { ttlSeconds: number; negative: boolean },
): Promise<void> {
  const body =
    negative || ttlSeconds < LIVE_RPC_CACHE_MIN_KV_TTL
      ? {
          live_rpc_cache_version: 1,
          expires_at_ms: Date.now() + ttlSeconds * 1000,
          value,
        }
      : value;
  await kv.put!(
    negative ? liveRpcFailureCacheKey(key) : key,
    JSON.stringify(body),
    {
      expirationTtl: Math.max(LIVE_RPC_CACHE_MIN_KV_TTL, ttlSeconds),
    },
  );
}
