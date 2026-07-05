import { describe, it, expect, vi, afterEach } from "vitest";

const KEY = "metagraphed:compare";

// An EventTarget-based fake `window` (so subscribe's add/remove/dispatch of the "storage" event work)
// plus a Map-backed localStorage. Node provides EventTarget globally.
function makeWindow(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const win = new EventTarget() as EventTarget & {
    localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    store: Map<string, string>;
    throwOnRead?: boolean;
  };
  win.store = store;
  win.localStorage = {
    getItem: (k: string) => {
      if (win.throwOnRead) throw new Error("blocked");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return win;
}

// compare-selection caches raw/value + listeners at module scope, so a fresh module per case is the
// only way to observe first-read/cache behaviour deterministically. Stub `window` before importing.
async function freshStore(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./compare-selection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRaw", () => {
  it("returns [] for null/empty/non-array/malformed input", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(null)).toEqual([]);
    expect(parseRaw("")).toEqual([]);
    expect(parseRaw("{not json")).toEqual([]);
    expect(parseRaw(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("keeps only finite numbers and caps at 4", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(JSON.stringify([1, "x", null, 2, Number.NaN, 3.5]))).toEqual([1, 2, 3.5]);
    expect(parseRaw(JSON.stringify([1, 2, 3, 4, 5, 6]))).toEqual([1, 2, 3, 4]);
  });
});

describe("readSnapshot", () => {
  it("returns [] during SSR (no window)", async () => {
    const { readSnapshot } = await freshStore(); // no window stubbed
    expect(readSnapshot()).toEqual([]);
  });

  it("reads + parses the persisted selection", async () => {
    const { readSnapshot } = await freshStore(makeWindow({ [KEY]: JSON.stringify([7, 12]) }));
    expect(readSnapshot()).toEqual([7, 12]);
  });

  it("serves an unchanged snapshot from cache (same reference)", async () => {
    const { readSnapshot } = await freshStore(makeWindow({ [KEY]: JSON.stringify([1, 2]) }));
    const a = readSnapshot();
    const b = readSnapshot();
    expect(a).toBe(b); // second read short-circuits on the identical raw string
  });

  it("degrades to [] when localStorage access throws", async () => {
    const win = makeWindow();
    win.throwOnRead = true;
    const { readSnapshot } = await freshStore(win);
    expect(readSnapshot()).toEqual([]);
  });
});

describe("writeRaw", () => {
  it("is a no-op during SSR (no window)", async () => {
    const { writeRaw, readSnapshot } = await freshStore(); // no window
    expect(() => writeRaw([1, 2])).not.toThrow();
    expect(readSnapshot()).toEqual([]);
  });

  it("cleans (finite-only), caps at 4, and persists", async () => {
    const win = makeWindow();
    const { writeRaw, readSnapshot } = await freshStore(win);
    writeRaw([1, Number.NaN, 2, Number.POSITIVE_INFINITY, 3, 4, 5]);
    expect(win.store.get(KEY)).toBe(JSON.stringify([1, 2, 3, 4]));
    expect(readSnapshot()).toEqual([1, 2, 3, 4]);
  });

  it("notifies registered subscribers", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    const calls: number[] = [];
    subscribe(() => calls.push(1));
    writeRaw([9]);
    expect(calls).toEqual([1]);
  });
});

describe("subscribe", () => {
  it("stops notifying after the returned unsubscribe runs", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    let count = 0;
    const off = subscribe(() => (count += 1));
    writeRaw([1]);
    off();
    writeRaw([2]);
    expect(count).toBe(1);
  });

  it("re-notifies on a cross-tab 'storage' event for this key, and ignores other keys", async () => {
    const win = makeWindow({ [KEY]: JSON.stringify([1]) });
    const { subscribe, readSnapshot } = await freshStore(win);
    let count = 0;
    subscribe(() => (count += 1));
    readSnapshot(); // prime the cache

    const other = new Event("storage") as Event & { key: string };
    other.key = "some-other-key";
    win.dispatchEvent(other);
    expect(count).toBe(0); // unrelated key: ignored

    win.store.set(KEY, JSON.stringify([1, 2]));
    const ours = new Event("storage") as Event & { key: string };
    ours.key = KEY;
    win.dispatchEvent(ours);
    expect(count).toBe(1); // our key: listener fired
    expect(readSnapshot()).toEqual([1, 2]); // cache was invalidated + re-read
  });

  it("returns a no-op unsubscribe during SSR without throwing", async () => {
    const { subscribe } = await freshStore(); // no window
    const off = subscribe(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
