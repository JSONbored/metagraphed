import { describe, it, expect, vi, afterEach } from "vitest";
import {
  loadRecent,
  pushRecent,
  clearRecent,
  loadPaletteState,
  savePaletteState,
  SUGGESTED_QUERIES,
} from "./search-history";

const RECENT_KEY = "mg.search.recent";
const STATE_KEY = "mg.search.state.v1";

// A Map-backed localStorage on a stub `window`. search-history reads `window` fresh on every call
// (no module-level cache), so a per-test stub is enough — no vi.resetModules needed. Node's default
// (no window) covers the SSR paths.
function stubWindow(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recent queries (loadRecent / pushRecent / clearRecent)", () => {
  it("pushRecent prepends most-recent-first and loadRecent reads it back", () => {
    stubWindow();
    pushRecent("bittensor");
    pushRecent("rpc");
    expect(loadRecent()).toEqual(["rpc", "bittensor"]);
  });

  it("trims and ignores empty / whitespace-only queries", () => {
    const store = stubWindow();
    pushRecent("  spaced  ");
    pushRecent("   ");
    pushRecent("");
    expect(loadRecent()).toEqual(["spaced"]);
    expect(store.has(RECENT_KEY)).toBe(true);
  });

  it("de-duplicates case-insensitively, moving an existing entry to the front", () => {
    stubWindow();
    pushRecent("Alpha");
    pushRecent("beta");
    pushRecent("ALPHA");
    expect(loadRecent()).toEqual(["ALPHA", "beta"]);
  });

  it("caps the list at 5 (drops the oldest)", () => {
    stubWindow();
    for (const q of ["a", "b", "c", "d", "e", "f"]) pushRecent(q);
    expect(loadRecent()).toEqual(["f", "e", "d", "c", "b"]);
  });

  it("loadRecent filters non-strings and caps a longer persisted array", () => {
    stubWindow({
      [RECENT_KEY]: JSON.stringify(["a", 1, null, "b", "c", "d", "e", "f"]),
    });
    expect(loadRecent()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("loadRecent tolerates malformed / non-array storage, returning []", () => {
    stubWindow({ [RECENT_KEY]: "{not json" });
    expect(loadRecent()).toEqual([]);
    stubWindow({ [RECENT_KEY]: JSON.stringify({ not: "an array" }) });
    expect(loadRecent()).toEqual([]);
  });

  it("clearRecent removes the persisted list", () => {
    const store = stubWindow({ [RECENT_KEY]: JSON.stringify(["a", "b"]) });
    clearRecent();
    expect(store.has(RECENT_KEY)).toBe(false);
    expect(loadRecent()).toEqual([]);
  });
});

describe("palette state (loadPaletteState / savePaletteState)", () => {
  it("round-trips a full state", () => {
    stubWindow();
    savePaletteState({ q: "rpc", scope: "endpoints" });
    expect(loadPaletteState()).toEqual({ q: "rpc", scope: "endpoints" });
  });

  it("defaults missing fields (q -> '', scope -> 'all')", () => {
    stubWindow({ [STATE_KEY]: JSON.stringify({ q: "only-q" }) });
    expect(loadPaletteState()).toEqual({ q: "only-q", scope: "all" });
    stubWindow({ [STATE_KEY]: JSON.stringify({ scope: "subnets" }) });
    expect(loadPaletteState()).toEqual({ q: "", scope: "subnets" });
  });

  it("returns null when nothing is persisted or the value is malformed", () => {
    stubWindow();
    expect(loadPaletteState()).toBeNull();
    stubWindow({ [STATE_KEY]: "{broken" });
    expect(loadPaletteState()).toBeNull();
  });
});

describe("SSR safety (no window)", () => {
  it("reads default to empty/null and writes are no-ops without throwing", () => {
    // No window stubbed → node's `window` is undefined.
    expect(loadRecent()).toEqual([]);
    expect(loadPaletteState()).toBeNull();
    expect(() => pushRecent("x")).not.toThrow();
    expect(() => clearRecent()).not.toThrow();
    expect(() => savePaletteState({ q: "x", scope: "all" })).not.toThrow();
  });
});

describe("SUGGESTED_QUERIES", () => {
  it("is a non-empty list of trimmed strings", () => {
    expect(SUGGESTED_QUERIES.length).toBeGreaterThan(0);
    for (const q of SUGGESTED_QUERIES) {
      expect(typeof q).toBe("string");
      expect(q).toBe(q.trim());
      expect(q.length).toBeGreaterThan(0);
    }
  });
});
