import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Tiny localStorage-backed selection store for validator comparison. Mirrors the
 * subnet `compare-selection` store but keyed by hotkey (a string) instead of a
 * numeric netuid. Holds up to MAX hotkeys and notifies subscribers across
 * components so the compare dock survives navigation.
 */
const KEY = "metagraphed:validator-compare";
const MAX = 4;

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedRaw: string | null = null;
let cachedValue: string[] = [];

// parseRaw / readSnapshot / writeRaw / subscribe are the store primitives the hook composes; they
// are exported for unit testing. The public component API stays `useValidatorCompare`.
export function parseRaw(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
      if (out.length >= MAX) break;
    }
    return out;
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
  const clean: string[] = [];
  for (const v of next) {
    if (typeof v === "string" && v.length > 0 && !clean.includes(v)) clean.push(v);
    if (clean.length >= MAX) break;
  }
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

export function useValidatorCompare() {
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
