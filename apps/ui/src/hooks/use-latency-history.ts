import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * Client-side rolling latency-history collector.
 *
 * The backend endpoints artifact only carries the *latest* probe latency for
 * most rows (probe_history is sparsely populated). Rather than block on a
 * new server-side history API, we snapshot each observed latency in
 * localStorage as the user visits the page. Over time this builds a real
 * multi-point sparkline per endpoint using genuinely observed data — no
 * synthetic values, no server round-trip.
 *
 * Series is capped per endpoint and pruned to a rolling window.
 */

const STORAGE_KEY = "mg:endpoint-latency-history:v1";
const MAX_POINTS = 48; // ~48 samples per endpoint
const MAX_ENDPOINTS = 500;
const MIN_INTERVAL_MS = 60_000; // dedup: don't record more than once per minute
const RETENTION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface LatencyPoint {
  t: number; // epoch ms
  v: number; // latency ms
}

type Store = Record<string, LatencyPoint[]>;

const EMPTY_STORE: Store = {};

function readStore(): Store {
  if (typeof window === "undefined") return EMPTY_STORE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed != null ? (parsed as Store) : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value when nothing changed -- a fresh JSON.parse() on every call (as
// readStore() above does) looks like a change on every render and sends
// React into an infinite "getSnapshot result should be cached" render loop
// (observed as "Maximum update depth exceeded" crashing EndpointDetailDrawer).
// Cache the last-seen raw string alongside its parsed object so unchanged
// reads return the exact same reference.
let cachedRaw: string | null = null;
let cachedStore: Store = EMPTY_STORE;

function writeStore(next: Store): void {
  cachedStore = next;
  cachedRaw = JSON.stringify(next);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, cachedRaw);
    } catch {
      /* quota / private-mode: drop */
    }
  }
  for (const l of listeners) l();
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Store {
  if (typeof window === "undefined") return EMPTY_STORE;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_STORE;
  }
  if (raw === cachedRaw) return cachedStore;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : EMPTY_STORE;
    cachedStore = typeof parsed === "object" && parsed != null ? (parsed as Store) : EMPTY_STORE;
  } catch {
    cachedStore = EMPTY_STORE;
  }
  return cachedStore;
}
function getServerSnapshot(): Store {
  return EMPTY_STORE;
}

/**
 * Record one observation for a set of endpoints. Called from a `useEffect`
 * inside the list so writes happen only client-side.
 */
export function recordLatencyObservations(
  observations: Array<{ id: string; latency_ms: number | null | undefined }>,
): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const store = readStore();
  let changed = false;

  for (const { id, latency_ms } of observations) {
    if (!id || latency_ms == null || !Number.isFinite(latency_ms)) continue;
    const series = store[id] ?? [];
    const last = series[series.length - 1];
    if (last && now - last.t < MIN_INTERVAL_MS) continue;
    const next: LatencyPoint[] = [...series, { t: now, v: Math.round(latency_ms) }]
      .filter((p) => now - p.t < RETENTION_MS)
      .slice(-MAX_POINTS);
    store[id] = next;
    changed = true;
  }

  // Prune to MAX_ENDPOINTS by most-recent-observation.
  const keys = Object.keys(store);
  if (keys.length > MAX_ENDPOINTS) {
    const ranked = keys
      .map((k) => ({ k, t: store[k]?.at(-1)?.t ?? 0 }))
      .sort((a, b) => b.t - a.t)
      .slice(0, MAX_ENDPOINTS);
    const pruned: Store = {};
    for (const { k } of ranked) pruned[k] = store[k];
    writeStore(pruned);
    return;
  }

  if (changed) writeStore(store);
}

/** Subscribe to the store so components re-render as new points arrive. */
function useHistoryStore(): Store {
  const hydrated = useHydrated();
  const store = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return hydrated ? store : {};
}

/**
 * Return the collected latency series for one endpoint, merged with any
 * server-provided probe_history samples that carry timestamps.
 */
export function useLatencyHistory(
  endpointId: string,
  serverSamples?: LatencyPoint[],
): LatencyPoint[] {
  const store = useHistoryStore();
  return useMemo(() => {
    const local = store[endpointId] ?? [];
    if (!serverSamples || serverSamples.length === 0) return local;
    const merged = [...serverSamples, ...local].sort((a, b) => a.t - b.t);
    // Dedup by minute bucket.
    const seen = new Set<number>();
    const out: LatencyPoint[] = [];
    for (const p of merged) {
      const bucket = Math.floor(p.t / MIN_INTERVAL_MS);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      out.push(p);
    }
    return out.slice(-MAX_POINTS);
  }, [store, endpointId, serverSamples]);
}

/**
 * Convenience hook: fires an observation-recording effect against a stable
 * `observations` list (memoize at call site).
 */
export function useRecordLatencyObservations(
  observations: Array<{ id: string; latency_ms: number | null | undefined }>,
): void {
  useEffect(() => {
    recordLatencyObservations(observations);
  }, [observations]);
}
