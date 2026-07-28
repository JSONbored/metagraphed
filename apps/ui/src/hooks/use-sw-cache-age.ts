import { useEffect, useState } from "react";
import { buildUrl } from "@/lib/metagraphed/client";

const SWR_API_CACHE = "metagraphed-api-v1";
const STALE_AFTER_MS = 15 * 60 * 1000; // must match public/sw.js's SWR_STALE_AFTER_MS

/**
 * #8384 requirement (c): reads the age of the service worker's own cached
 * copy of one of the watchlist home module's SWR-eligible endpoints,
 * straight from the Cache Storage API (`x-sw-cached-at`, stamped by
 * public/sw.js's handleSwrApi) -- deliberately NOT threaded through
 * apiFetch/React Query, since neither exposes the underlying Response's
 * headers today and this is the one place in the app that needs them.
 * Returns `null` when there's no service worker, no cache entry yet, or the
 * entry is still fresh enough that showing its age would just be noise.
 */
export function useSwCacheAge(path: string): number | null {
  const [ageMs, setAgeMs] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("caches" in window)) return;
    let cancelled = false;

    async function check() {
      try {
        const cache = await caches.open(SWR_API_CACHE);
        const match = await cache.match(buildUrl(path));
        const cachedAt = match?.headers.get("x-sw-cached-at");
        if (cancelled || !cachedAt) return;
        const age = Date.now() - Number(cachedAt);
        setAgeMs(Number.isFinite(age) && age > STALE_AFTER_MS ? age : null);
      } catch {
        // Cache Storage can throw in some private-browsing modes -- the
        // affordance is purely cosmetic, so fail silently.
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [path]);

  return ageMs;
}
