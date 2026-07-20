import { describe, it, expect, vi, afterEach } from "vitest";

const KEY = "metagraphed:compare-validators";

// An EventTarget-based fake `window` (so subscribe's add/remove/dispatch of the
// "storage" event work) plus a Map-backed localStorage. Mirrors compare-selection.test.ts.
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

// Module-scope cache/listeners → a fresh module per case is the only way to observe
// first-read/cache behaviour deterministically. Stub `window` before importing.
async function freshStore(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./validator-compare-selection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const HK = (n: number) => `5Hotkey${n}`;

describe("parseRaw", () => {
  it("returns [] for null/empty/non-array/malformed input", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(null)).toEqual([]);
    expect(parseRaw("")).toEqual([]);
    expect(parseRaw("{not json")).toEqual([]);
    expect(parseRaw(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("keeps only non-empty strings and caps at 4", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(JSON.stringify([HK(1), 5, "", null, HK(2)]))).toEqual([HK(1), HK(2)]);
    expect(parseRaw(JSON.stringify([HK(1), HK(2), HK(3), HK(4), HK(5)]))).toEqual([
      HK(1),
      HK(2),
      HK(3),
      HK(4),
    ]);
  });
});

describe("readSnapshot", () => {
  it("returns [] during SSR (no window)", async () => {
    const { readSnapshot } = await freshStore();
    expect(readSnapshot()).toEqual([]);
  });

  it("reads + parses the persisted selection", async () => {
    const { readSnapshot } = await freshStore(
      makeWindow({ [KEY]: JSON.stringify([HK(7), HK(12)]) }),
    );
    expect(readSnapshot()).toEqual([HK(7), HK(12)]);
  });

  it("serves an unchanged snapshot from cache (same reference)", async () => {
    const { readSnapshot } = await freshStore(
      makeWindow({ [KEY]: JSON.stringify([HK(1), HK(2)]) }),
    );
    expect(readSnapshot()).toBe(readSnapshot());
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
    const { writeRaw, readSnapshot } = await freshStore();
    expect(() => writeRaw([HK(1)])).not.toThrow();
    expect(readSnapshot()).toEqual([]);
  });

  it("cleans (non-empty-string-only), caps at 4, and persists", async () => {
    const win = makeWindow();
    const { writeRaw, readSnapshot } = await freshStore(win);
    writeRaw([HK(1), "", HK(2), HK(3), HK(4), HK(5)]);
    expect(win.store.get(KEY)).toBe(JSON.stringify([HK(1), HK(2), HK(3), HK(4)]));
    expect(readSnapshot()).toEqual([HK(1), HK(2), HK(3), HK(4)]);
  });

  it("notifies registered subscribers", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    const calls: number[] = [];
    subscribe(() => calls.push(1));
    writeRaw([HK(9)]);
    expect(calls).toEqual([1]);
  });
});

describe("subscribe", () => {
  it("stops notifying after the returned unsubscribe runs", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    let count = 0;
    const off = subscribe(() => (count += 1));
    writeRaw([HK(1)]);
    off();
    writeRaw([HK(2)]);
    expect(count).toBe(1);
  });

  it("re-notifies on a cross-tab 'storage' event for this key, and ignores other keys", async () => {
    const win = makeWindow({ [KEY]: JSON.stringify([HK(1)]) });
    const { subscribe, readSnapshot } = await freshStore(win);
    let count = 0;
    subscribe(() => (count += 1));
    readSnapshot();

    const other = new Event("storage") as Event & { key: string };
    other.key = "some-other-key";
    win.dispatchEvent(other);
    expect(count).toBe(0);

    win.store.set(KEY, JSON.stringify([HK(1), HK(2)]));
    const ours = new Event("storage") as Event & { key: string };
    ours.key = KEY;
    win.dispatchEvent(ours);
    expect(count).toBe(1);
    expect(readSnapshot()).toEqual([HK(1), HK(2)]);
  });

  it("returns a no-op unsubscribe during SSR without throwing", async () => {
    const { subscribe } = await freshStore();
    const off = subscribe(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
