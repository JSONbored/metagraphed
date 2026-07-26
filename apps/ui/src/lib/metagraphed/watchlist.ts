import { useCallback, useEffect, useState } from "react";

// #8248: shared localStorage-backed watchlist store. /subnets is the first
// consumer; the store is keyed by an entity `kind` (not just "subnet") so
// /validators and /accounts can adopt the same primitive later without a
// second implementation -- one star icon, one storage convention, one
// cross-tab sync mechanism, reused everywhere a list page wants "pin this row".
export type WatchlistKind = "subnet" | "validator" | "account";

const STORAGE_PREFIX = "metagraphed:watchlist:";

function storageKey(kind: WatchlistKind): string {
  return `${STORAGE_PREFIX}${kind}`;
}

function readWatchlist(kind: WatchlistKind): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(kind));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeWatchlist(kind: WatchlistKind, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(kind), JSON.stringify([...ids]));
  } catch {
    // Storage can be full or disabled (private browsing) -- the watchlist is
    // a convenience, not a data-loss risk, so fail silently.
  }
}

/**
 * `ids` starts empty on every render (server and the first client render
 * alike) and is populated from localStorage in an effect -- an effect never
 * runs during SSR, so this can never produce a hydration mismatch the way
 * reading localStorage in the initializer would.
 */
export function useWatchlist(kind: WatchlistKind) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setIds(readWatchlist(kind));
    // Cross-tab sync: another tab toggling the same kind should reflect here
    // without a reload.
    function onStorage(e: StorageEvent) {
      if (e.key === storageKey(kind)) setIds(readWatchlist(kind));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [kind]);

  const isWatched = useCallback((id: string | number) => ids.has(String(id)), [ids]);

  const toggle = useCallback(
    (id: string | number) => {
      const key = String(id);
      setIds((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        writeWatchlist(kind, next);
        return next;
      });
    },
    [kind],
  );

  return { ids, isWatched, toggle, count: ids.size };
}
