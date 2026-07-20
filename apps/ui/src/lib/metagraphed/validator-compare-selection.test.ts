import { describe, it, expect, vi, afterEach } from "vitest";

const KEY = "metagraphed:compare-validators";
const A = "5A".padEnd(48, "a");
const B = "5B".padEnd(48, "b");
const C = "5C".padEnd(48, "c");
const D = "5D".padEnd(48, "d");
const E = "5E".padEnd(48, "e");

// An EventTarget-based fake `window` (so subscribe's storage-event wiring works)
// plus a Map-backed localStorage. Mirrors compare-selection.test.ts.
function makeWindow(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const win = new EventTarget() as EventTarget & {
    localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    store: Map<string, string>;
  };
  win.store = store;
  win.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return win;
}

// The store caches raw/value + listeners at module scope, so a fresh module per
// case is the only way to observe cache behaviour deterministically.
async function freshStore(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./validator-compare-selection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRaw", () => {
  it("returns [] for null/empty/non-array/malformed input", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(null)).toEqual([]);
    expect(parseRaw("")).toEqual([]);
    expect(parseRaw("{}")).toEqual([]);
    expect(parseRaw("not json")).toEqual([]);
  });

  it("keeps only non-empty string hotkeys and caps at 4", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(JSON.stringify([A, 7, "", "  ", B, null]))).toEqual([A, B]);
    expect(parseRaw(JSON.stringify([A, B, C, D, E]))).toEqual([A, B, C, D]);
  });
});

describe("readSnapshot / writeRaw", () => {
  it("round-trips through localStorage and caps at 4", async () => {
    const win = makeWindow();
    const { readSnapshot, writeRaw } = await freshStore(win);
    writeRaw([A, B]);
    expect(readSnapshot()).toEqual([A, B]);
    writeRaw([A, B, C, D, E]);
    expect(readSnapshot()).toEqual([A, B, C, D]);
    expect(JSON.parse(win.store.get(KEY)!)).toEqual([A, B, C, D]);
  });

  it("drops non-string entries on write", async () => {
    const { readSnapshot, writeRaw } = await freshStore(makeWindow());
    // @ts-expect-error exercising defensive runtime filtering
    writeRaw([A, 5, "", B]);
    expect(readSnapshot()).toEqual([A, B]);
  });
});

describe("subscribe", () => {
  it("notifies listeners on writeRaw and stops after unsubscribe", async () => {
    const { subscribe, writeRaw } = await freshStore(makeWindow());
    let hits = 0;
    const unsubscribe = subscribe(() => {
      hits += 1;
    });
    writeRaw([A]);
    writeRaw([A, B]);
    expect(hits).toBe(2);
    unsubscribe();
    writeRaw([A, B, C]);
    expect(hits).toBe(2);
  });

  it("readSnapshot reflects an externally-seeded value and empties on clear", async () => {
    const { readSnapshot, writeRaw } = await freshStore(
      makeWindow({ [KEY]: JSON.stringify([A, B, C]) }),
    );
    expect(readSnapshot()).toEqual([A, B, C]);
    writeRaw([]);
    expect(readSnapshot()).toEqual([]);
  });
});
