import { describe, it, expect, vi, afterEach } from "vitest";

const KEY = "metagraphed:compare-validators";

const HK_A = "5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX";
const HK_B = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const HK_C = "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw";
const HK_D = "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL";
const HK_E = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

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

// validators-compare-selection caches raw/value + listeners at module scope, so a fresh module per
// case is the only way to observe first-read/cache behaviour deterministically. Stub `window`
// before importing.
async function freshStore(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./validators-compare-selection");
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
    expect(parseRaw(JSON.stringify({ a: HK_A }))).toEqual([]);
  });

  it("keeps only non-empty strings and caps at 4", async () => {
    const { parseRaw } = await freshStore(makeWindow());
    expect(parseRaw(JSON.stringify([HK_A, 7, null, HK_B, "", HK_C]))).toEqual([HK_A, HK_B, HK_C]);
    expect(parseRaw(JSON.stringify([HK_A, HK_B, HK_C, HK_D, HK_E]))).toEqual([
      HK_A,
      HK_B,
      HK_C,
      HK_D,
    ]);
  });
});

describe("readSnapshot", () => {
  it("returns [] during SSR (no window)", async () => {
    const { readSnapshot } = await freshStore(); // no window stubbed
    expect(readSnapshot()).toEqual([]);
  });

  it("reads + parses the persisted selection", async () => {
    const { readSnapshot } = await freshStore(makeWindow({ [KEY]: JSON.stringify([HK_A, HK_B]) }));
    expect(readSnapshot()).toEqual([HK_A, HK_B]);
  });

  it("serves an unchanged snapshot from cache (same reference)", async () => {
    const { readSnapshot } = await freshStore(makeWindow({ [KEY]: JSON.stringify([HK_A, HK_B]) }));
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
    expect(() => writeRaw([HK_A, HK_B])).not.toThrow();
    expect(readSnapshot()).toEqual([]);
  });

  it("cleans (non-empty strings only), caps at 4, and persists", async () => {
    const win = makeWindow();
    const { writeRaw, readSnapshot } = await freshStore(win);
    writeRaw([HK_A, "", HK_B, HK_C, HK_D, HK_E]);
    expect(win.store.get(KEY)).toBe(JSON.stringify([HK_A, HK_B, HK_C, HK_D]));
    expect(readSnapshot()).toEqual([HK_A, HK_B, HK_C, HK_D]);
  });

  it("notifies registered subscribers", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    const calls: number[] = [];
    subscribe(() => calls.push(1));
    writeRaw([HK_A]);
    expect(calls).toEqual([1]);
  });
});

describe("subscribe", () => {
  it("stops notifying after the returned unsubscribe runs", async () => {
    const { writeRaw, subscribe } = await freshStore(makeWindow());
    let count = 0;
    const off = subscribe(() => (count += 1));
    writeRaw([HK_A]);
    off();
    writeRaw([HK_B]);
    expect(count).toBe(1);
  });

  it("re-notifies on a cross-tab 'storage' event for this key, and ignores other keys", async () => {
    const win = makeWindow({ [KEY]: JSON.stringify([HK_A]) });
    const { subscribe, readSnapshot } = await freshStore(win);
    let count = 0;
    subscribe(() => (count += 1));
    readSnapshot(); // prime the cache

    const other = new Event("storage") as Event & { key: string };
    other.key = "some-other-key";
    win.dispatchEvent(other);
    expect(count).toBe(0); // unrelated key: ignored

    win.store.set(KEY, JSON.stringify([HK_A, HK_B]));
    const ours = new Event("storage") as Event & { key: string };
    ours.key = KEY;
    win.dispatchEvent(ours);
    expect(count).toBe(1); // our key: listener fired
    expect(readSnapshot()).toEqual([HK_A, HK_B]); // cache was invalidated + re-read
  });

  it("returns a no-op unsubscribe during SSR without throwing", async () => {
    const { subscribe } = await freshStore(); // no window
    const off = subscribe(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
