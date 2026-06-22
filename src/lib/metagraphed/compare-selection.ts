import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Tiny localStorage-backed selection store for subnet comparison.
 * Holds up to MAX netuids and notifies subscribers across components.
 */
const KEY = "metagraphed:compare";
const MAX = 4;

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedRaw: string | null = null;
let cachedValue: number[] = [];

function parseRaw(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => Number.isFinite(n)).slice(0, MAX);
  } catch {
    return [];
  }
}

function readSnapshot(): number[] {
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

function writeRaw(next: number[]) {
  if (typeof window === "undefined") return;
  const clean = next.filter((n): n is number => Number.isFinite(n)).slice(0, MAX);
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

function subscribe(l: Listener) {
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

const EMPTY: number[] = [];

export function useCompareSelection() {
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
    has: (netuid: number) => value.includes(netuid),
    toggle: (netuid: number) => {
      const cur = readSnapshot();
      if (cur.includes(netuid)) writeRaw(cur.filter((n) => n !== netuid));
      else if (cur.length < MAX) writeRaw([...cur, netuid]);
    },
    remove: (netuid: number) => writeRaw(readSnapshot().filter((n) => n !== netuid)),
    clear: () => writeRaw([]),
  };
}
