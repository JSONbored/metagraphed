import { describe, it, expect, vi, afterEach } from "vitest";

// A minimal browser `window` for the CSR paths, matching config.test.ts's makeWindow:
// an EventTarget (so add/remove/dispatch work) plus a Map-backed localStorage.
function makeWindow(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const win = new EventTarget() as EventTarget & {
    localStorage: Storage;
    store: Map<string, string>;
  };
  win.store = store;
  win.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  return win;
}

const ADDR_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ADDR_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

// wallet.ts caches at module scope, so resetModules + a re-import is the only way to
// observe first-read behavior deterministically — same pattern as config.test.ts's
// freshConfig. Stub `window` BEFORE importing so any import-time read sees it.
async function freshWallet(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./wallet");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getConnectedWallet / setConnectedWallet (CSR: caching, persistence, broadcast)", () => {
  it("reads a persisted wallet on first call, then serves it from cache", async () => {
    const win = makeWindow({
      "metagraphed:wallet": JSON.stringify({ address: ADDR_A, source: "polkadot-js" }),
    });
    const wallet = await freshWallet(win);
    expect(wallet.getConnectedWallet()).toEqual({ address: ADDR_A, source: "polkadot-js" });
    // Mutating storage after the first (caching) read must NOT change the served value.
    win.store.set("metagraphed:wallet", JSON.stringify({ address: ADDR_B, source: "talisman" }));
    expect(wallet.getConnectedWallet()).toEqual({ address: ADDR_A, source: "polkadot-js" });
  });

  it("defaults to null when nothing is persisted", async () => {
    const wallet = await freshWallet(makeWindow());
    expect(wallet.getConnectedWallet()).toBeNull();
  });

  it("ignores malformed JSON, falling back to null", async () => {
    const wallet = await freshWallet(makeWindow({ "metagraphed:wallet": "{not json" }));
    expect(wallet.getConnectedWallet()).toBeNull();
  });

  it("ignores a persisted value with an invalid ss58 address, falling back to null", async () => {
    const wallet = await freshWallet(
      makeWindow({
        "metagraphed:wallet": JSON.stringify({ address: "not-an-address", source: "talisman" }),
      }),
    );
    expect(wallet.getConnectedWallet()).toBeNull();
  });

  it("ignores a persisted value with an empty/missing source, falling back to null", async () => {
    const wallet = await freshWallet(
      makeWindow({
        "metagraphed:wallet": JSON.stringify({ address: ADDR_A, source: "" }),
      }),
    );
    expect(wallet.getConnectedWallet()).toBeNull();
    const wallet2 = await freshWallet(
      makeWindow({ "metagraphed:wallet": JSON.stringify({ address: ADDR_A }) }),
    );
    expect(wallet2.getConnectedWallet()).toBeNull();
  });

  it("setConnectedWallet persists a valid wallet, updates the cache, and broadcasts it", async () => {
    const win = makeWindow();
    const wallet = await freshWallet(win);
    const seen: Array<{ address: string; source: string } | null> = [];
    const off = wallet.onConnectedWalletChange((next) => seen.push(next));
    wallet.setConnectedWallet({ address: ADDR_A, source: "subwallet-js" });
    expect(wallet.getConnectedWallet()).toEqual({ address: ADDR_A, source: "subwallet-js" });
    expect(win.store.get("metagraphed:wallet")).toBe(
      JSON.stringify({ address: ADDR_A, source: "subwallet-js" }),
    );
    expect(seen).toEqual([{ address: ADDR_A, source: "subwallet-js" }]);
    // After unsubscribing, further changes are not delivered.
    off();
    wallet.setConnectedWallet({ address: ADDR_B, source: "talisman" });
    expect(seen).toEqual([{ address: ADDR_A, source: "subwallet-js" }]);
  });

  it("setConnectedWallet(null) disconnects: removes the persisted key and broadcasts null", async () => {
    const win = makeWindow({
      "metagraphed:wallet": JSON.stringify({ address: ADDR_A, source: "polkadot-js" }),
    });
    const wallet = await freshWallet(win);
    const seen: Array<{ address: string; source: string } | null> = [];
    wallet.onConnectedWalletChange((next) => seen.push(next));
    wallet.setConnectedWallet(null);
    expect(wallet.getConnectedWallet()).toBeNull();
    expect(win.store.has("metagraphed:wallet")).toBe(false);
    expect(seen).toEqual([null]);
  });

  it("setConnectedWallet with an invalid wallet falls back to disconnected (null)", async () => {
    const wallet = await freshWallet(makeWindow());
    // @ts-expect-error deliberately malformed input
    wallet.setConnectedWallet({ address: "bogus" });
    expect(wallet.getConnectedWallet()).toBeNull();
  });
});

describe("SSR safety (no window)", () => {
  it("defaults to null and returns a no-op unsubscriber when window is undefined", async () => {
    const wallet = await freshWallet(); // no window stubbed
    expect(wallet.getConnectedWallet()).toBeNull();
    expect(typeof wallet.onConnectedWalletChange(() => {})).toBe("function");
    // The setter must not throw without a window.
    expect(() =>
      wallet.setConnectedWallet({ address: ADDR_A, source: "polkadot-js" }),
    ).not.toThrow();
  });
});
