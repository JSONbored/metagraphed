import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeLatencyHistory, type LatencyPoint } from "./use-latency-history";

const STORAGE_KEY = "mg:endpoint-latency-history:v1";
const MIN_INTERVAL_MS = 60_000;
const RETENTION_MS = 1000 * 60 * 60 * 24 * 30;

// Minimal browser `window` with a Map-backed localStorage, matching
// wallet.test.ts's makeWindow.
function makeWindow(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const win = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  };
  return { win, store };
}

// use-latency-history.ts caches (cachedRaw/cachedStore) at module scope, so
// resetModules + a fresh dynamic import is the only way to observe a clean
// cache per test -- same pattern as wallet.test.ts's freshWallet.
async function freshLatencyHistory(win?: ReturnType<typeof makeWindow>["win"]) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./use-latency-history");
}

function readStoredSeries(store: Map<string, string>, id: string): LatencyPoint[] {
  const raw = store.get(STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Record<string, LatencyPoint[]>;
  return parsed[id] ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordLatencyObservations (dedup, retention, endpoint cap)", () => {
  it("dedups: a second observation for the same id inside the 1-minute window is dropped", async () => {
    const { win, store } = makeWindow();
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 100 }]);
    mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 200 }]);
    expect(readStoredSeries(store, "ep-a")).toHaveLength(1);
    expect(readStoredSeries(store, "ep-a")[0]!.v).toBe(100);
  });

  it("prunes points older than the 30-day retention window on the next write", async () => {
    const { win, store } = makeWindow();
    const staleT = Date.now() - RETENTION_MS - 1_000;
    store.set(STORAGE_KEY, JSON.stringify({ "ep-a": [{ t: staleT, v: 999 }] }));
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 50 }]);
    const series = readStoredSeries(store, "ep-a");
    expect(series).toHaveLength(1);
    expect(series[0]!.v).toBe(50);
  });

  it("caps a single endpoint's series to the most recent 48 points", async () => {
    const { win, store } = makeWindow();
    const mod = await freshLatencyHistory(win);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 50; i++) {
        mod.recordLatencyObservations([{ id: "ep-a", latency_ms: i }]);
        vi.advanceTimersByTime(MIN_INTERVAL_MS + 1_000);
      }
    } finally {
      vi.useRealTimers();
    }
    const series = readStoredSeries(store, "ep-a");
    expect(series).toHaveLength(48);
    // The oldest two observations (v=0, v=1) must have been dropped, keeping
    // only the most recent 48 (v=2..49).
    expect(series[0]!.v).toBe(2);
    expect(series.at(-1)!.v).toBe(49);
  });

  it("caps the store to the 500 most recently observed endpoints, dropping the stalest", async () => {
    const seeded: Record<string, LatencyPoint[]> = {};
    for (let i = 1; i <= 500; i++) {
      seeded[`ep-${i}`] = [{ t: i, v: i }];
    }
    const { win, store } = makeWindow({ [STORAGE_KEY]: JSON.stringify(seeded) });
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([{ id: "ep-new", latency_ms: 42 }]);

    const raw = store.get(STORAGE_KEY)!;
    const parsed = JSON.parse(raw) as Record<string, LatencyPoint[]>;
    const keys = Object.keys(parsed);
    expect(keys).toHaveLength(500);
    expect(keys).toContain("ep-new");
    // ep-1 had the oldest timestamp (t=1) of the seeded set, so it's the one
    // evicted to make room for the new observation.
    expect(keys).not.toContain("ep-1");
    expect(keys).toContain("ep-2");
  });

  it("ignores observations with a missing id or a non-finite latency", async () => {
    const { win, store } = makeWindow();
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([
      { id: "", latency_ms: 100 },
      { id: "ep-a", latency_ms: null },
      { id: "ep-b", latency_ms: undefined },
      { id: "ep-c", latency_ms: Number.NaN },
    ]);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  it("is a no-op when window is undefined (SSR)", async () => {
    const mod = await freshLatencyHistory();
    expect(() => mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 10 }])).not.toThrow();
  });
});

describe("getSnapshot (useSyncExternalStore infinite-render regression)", () => {
  it("returns a referentially stable snapshot across calls when nothing changed", async () => {
    const { win } = makeWindow();
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 10 }]);
    const first = mod.getSnapshot();
    const second = mod.getSnapshot();
    // Prior to caching the raw string, getSnapshot() did a fresh JSON.parse()
    // on every call, which useSyncExternalStore treats as "changed" on every
    // render and sends React into an infinite update loop.
    expect(second).toBe(first);
  });

  it("returns a new snapshot only after the underlying store actually changes", async () => {
    const { win } = makeWindow();
    const mod = await freshLatencyHistory(win);
    mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 10 }]);
    const before = mod.getSnapshot();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(MIN_INTERVAL_MS + 1_000);
      mod.recordLatencyObservations([{ id: "ep-a", latency_ms: 20 }]);
    } finally {
      vi.useRealTimers();
    }
    const after = mod.getSnapshot();
    expect(after).not.toBe(before);
    expect(after["ep-a"]).toHaveLength(2);
  });

  it("returns the empty store and never throws when window is undefined (SSR)", async () => {
    const mod = await freshLatencyHistory();
    expect(mod.getSnapshot()).toEqual({});
  });
});

describe("mergeLatencyHistory (server + local merge, minute-bucket dedup)", () => {
  it("returns the local series untouched when there are no server samples", () => {
    const local: LatencyPoint[] = [{ t: 1_000, v: 5 }];
    expect(mergeLatencyHistory(local, undefined)).toBe(local);
    expect(mergeLatencyHistory(local, [])).toBe(local);
  });

  it("dedups server + local points that fall in the same minute bucket", () => {
    const local: LatencyPoint[] = [{ t: 1_000, v: 5 }];
    const server: LatencyPoint[] = [{ t: 2_000, v: 7 }];
    const merged = mergeLatencyHistory(local, server);
    // Both timestamps land in minute bucket 0 -- the merge sorts by time
    // ascending before dedup, so the earlier (local) point survives and the
    // later (server) point in the same bucket is dropped.
    expect(merged).toEqual([{ t: 1_000, v: 5 }]);
  });

  it("keeps points from different minute buckets, sorted ascending by time", () => {
    const local: LatencyPoint[] = [{ t: MIN_INTERVAL_MS * 5, v: 5 }];
    const server: LatencyPoint[] = [{ t: 0, v: 1 }];
    const merged = mergeLatencyHistory(local, server);
    expect(merged).toEqual([
      { t: 0, v: 1 },
      { t: MIN_INTERVAL_MS * 5, v: 5 },
    ]);
  });

  it("caps the merged result to the most recent 48 points", () => {
    const local: LatencyPoint[] = Array.from({ length: 30 }, (_, i) => ({
      t: i * MIN_INTERVAL_MS,
      v: i,
    }));
    const server: LatencyPoint[] = Array.from({ length: 30 }, (_, i) => ({
      t: (30 + i) * MIN_INTERVAL_MS,
      v: 30 + i,
    }));
    const merged = mergeLatencyHistory(local, server);
    expect(merged).toHaveLength(48);
    expect(merged[0]!.v).toBe(12);
    expect(merged.at(-1)!.v).toBe(59);
  });
});
