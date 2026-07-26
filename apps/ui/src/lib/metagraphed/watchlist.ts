import { useCallback, useEffect, useState } from "react";
import { captureEvent } from "@/lib/analytics";

// #8248: shared localStorage-backed watchlist store. /subnets is the first
// consumer; the store is keyed by an entity `kind` (not just "subnet") so
// /validators and /accounts can adopt the same primitive later without a
// second implementation -- one star icon, one storage convention, one
// cross-tab sync mechanism, reused everywhere a list page wants "pin this row".
export type WatchlistKind = "subnet" | "validator" | "account";

export const WATCHLIST_KINDS: readonly WatchlistKind[] = ["subnet", "validator", "account"];

const STORAGE_PREFIX = "metagraphed:watchlist:";

// #8256: bumped when the on-disk shape changes. v1 was a bare `string[]`,
// written before there was a version to record; `readWatchlist` still accepts
// it so nobody's existing stars vanish on upgrade.
export const WATCHLIST_SCHEMA_VERSION = 2;

interface WatchlistFile {
  version: number;
  ids: string[];
}

function storageKey(kind: WatchlistKind): string {
  return `${STORAGE_PREFIX}${kind}`;
}

/**
 * Accepts both the v1 bare array and the v2 `{ version, ids }` envelope.
 * Anything else -- corrupt JSON, a future version we can't interpret, a
 * non-array `ids` -- reads as empty rather than throwing, because a broken
 * watchlist must never take a page down with it.
 */
function parseWatchlist(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
    if (parsed && typeof parsed === "object") {
      const { version, ids } = parsed as Partial<WatchlistFile>;
      if (
        typeof version === "number" &&
        version <= WATCHLIST_SCHEMA_VERSION &&
        Array.isArray(ids)
      ) {
        return new Set(ids.map(String));
      }
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function readWatchlist(kind: WatchlistKind): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return parseWatchlist(window.localStorage.getItem(storageKey(kind)));
  } catch {
    return new Set();
  }
}

function writeWatchlist(kind: WatchlistKind, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const file: WatchlistFile = { version: WATCHLIST_SCHEMA_VERSION, ids: [...ids] };
    window.localStorage.setItem(storageKey(kind), JSON.stringify(file));
  } catch {
    // Storage can be full or disabled (private browsing) -- the watchlist is
    // a convenience, not a data-loss risk, so fail silently.
  }
}

/** Every kind's ids in one envelope — what the export button downloads. */
export interface WatchlistExport {
  version: number;
  exported_at: string;
  watchlists: Record<WatchlistKind, string[]>;
}

export function exportWatchlists(): WatchlistExport {
  return {
    version: WATCHLIST_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    watchlists: {
      subnet: [...readWatchlist("subnet")],
      validator: [...readWatchlist("validator")],
      account: [...readWatchlist("account")],
    },
  };
}

/**
 * Merges an exported file into the current stars rather than replacing them —
 * importing on a device that already has stars should never silently delete
 * work. Returns the per-kind count of ids that were newly added, so the caller
 * can say what actually happened instead of a bare "imported".
 *
 * Throws on a file this can't interpret; the caller surfaces that to the user.
 */
export function importWatchlists(raw: string): Record<WatchlistKind, number> {
  const parsed: unknown = JSON.parse(raw);
  const watchlists = (parsed as Partial<WatchlistExport> | null)?.watchlists;
  if (!watchlists || typeof watchlists !== "object") {
    throw new Error("Not a Metagraphed watchlist file — expected a `watchlists` object.");
  }
  const added = { subnet: 0, validator: 0, account: 0 } as Record<WatchlistKind, number>;
  for (const kind of WATCHLIST_KINDS) {
    const incoming = watchlists[kind];
    if (!Array.isArray(incoming)) continue;
    const current = readWatchlist(kind);
    const before = current.size;
    for (const id of incoming) current.add(String(id));
    added[kind] = current.size - before;
    if (added[kind] > 0) writeWatchlist(kind, current);
  }
  // Storage events don't fire in the tab that wrote them, so nudge this tab's
  // own hooks the same way a cross-tab write would.
  if (typeof window !== "undefined") {
    for (const kind of WATCHLIST_KINDS) {
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey(kind) }));
    }
  }
  return added;
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
    // without a reload. importWatchlists dispatches the same event locally.
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
        const adding = !next.has(key);
        if (adding) next.add(key);
        else next.delete(key);
        writeWatchlist(kind, next);
        // #8256: the entity id is deliberately NOT sent. Which subnets someone
        // watches is a behavioural fingerprint; the counts answer "is anyone
        // using this" without building one.
        captureEvent(adding ? "star_added" : "star_removed", {
          kind,
          watched_count: next.size,
        });
        return next;
      });
    },
    [kind],
  );

  return { ids, isWatched, toggle, count: ids.size };
}
