import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Tiny localStorage-backed selection store for validator comparison (#6998) —
 * the hotkey (SS58 string) counterpart of compare-selection.ts, same store
 * shape and the same cross-component notification contract.
 * Holds up to MAX hotkeys and notifies subscribers across components.
 */
const KEY = "metagraphed:compare-validators";
const MAX = 4;

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedRaw: string | null = null;
let cachedValue: string[] = [];

// parseRaw / readSnapshot / writeRaw / subscribe are the store primitives the hook composes; they
// are exported for unit testing (same contract as compare-selection.ts, #3414). The public
// component API stays `useValidatorsCompareSelection`.
export function parseRaw(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, MAX);
  } catch {
    return [];
  }
}

export function readSnapshot(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    cachedValue = parseRaw(raw);
    return cachedValue;
  } catch {
    if (cachedRaw === null) return cachedValue;
    cachedRaw = null;
    cachedValue = [];
    return cachedValue;
  }
}

export function writeRaw(next: string[]) {
  if (typeof window === "undefined") return;
  const clean = next
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .slice(0, MAX);
  const raw = JSON.stringify(clean);
  try {
    window.localStorage.setItem(KEY, raw);
  } catch {
    /* ignore quota errors */
  }
  cachedRaw = raw;
  cachedValue = clean;
  for (const l of listeners) l();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) {
        cachedRaw = null;
        cachedValue = [];
        l();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => listeners.delete(l);
}

const EMPTY: string[] = [];

export function useValidatorsCompareSelection() {
  // Avoid SSR/CSR snapshot mismatch — start empty on the server, hydrate on mount.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const value = useSyncExternalStore(
    subscribe,
    () => (hydrated ? readSnapshot() : EMPTY),
    () => EMPTY,
  );

  return {
    selected: value,
    max: MAX,
    has: (hotkey: string) => value.includes(hotkey),
    toggle: (hotkey: string) => {
      const cur = readSnapshot();
      if (cur.includes(hotkey)) writeRaw(cur.filter((h) => h !== hotkey));
      else if (cur.length < MAX) writeRaw([...cur, hotkey]);
    },
    remove: (hotkey: string) => writeRaw(readSnapshot().filter((h) => h !== hotkey)),
    clear: () => writeRaw([]),
  };
}
