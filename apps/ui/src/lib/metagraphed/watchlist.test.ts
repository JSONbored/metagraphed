import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportWatchlists, importWatchlists, WATCHLIST_SCHEMA_VERSION } from "./watchlist";

vi.mock("@/lib/analytics", () => ({ captureEvent: vi.fn() }));

const KEY = (kind: string) => `metagraphed:watchlist:${kind}`;

// This suite runs in the config's plain-node environment (no jsdom, by
// design -- see vitest.config.ts). The store only needs localStorage and
// addEventListener/dispatchEvent, so stub exactly those rather than pulling
// a DOM implementation in for four methods.
const store = new Map<string, string>();
const listeners = new Set<(e: { key: string | null }) => void>();
const originalWindow = (globalThis as { window?: unknown }).window;

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
  addEventListener: (_t: string, fn: (e: { key: string | null }) => void) => listeners.add(fn),
  removeEventListener: (_t: string, fn: (e: { key: string | null }) => void) =>
    listeners.delete(fn),
  dispatchEvent: (e: { key: string | null }) => {
    for (const fn of listeners) fn(e);
    return true;
  },
};
// The store constructs a real StorageEvent; node has no such global.
(globalThis as unknown as { StorageEvent: unknown }).StorageEvent = class {
  key: string | null;
  constructor(_type: string, init?: { key?: string }) {
    this.key = init?.key ?? null;
  }
};

/** The stubbed window, typed loosely -- this suite only touches four methods. */
function win() {
  return (
    globalThis as unknown as {
      window: {
        localStorage: Storage;
        addEventListener: (t: string, fn: (e: { key: string | null }) => void) => void;
        removeEventListener: (t: string, fn: (e: { key: string | null }) => void) => void;
      };
    }
  ).window;
}

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

beforeEach(() => {
  store.clear();
  listeners.clear();
});

describe("watchlist storage schema (#8256)", () => {
  it("round-trips an export through an import", () => {
    win().localStorage.setItem(
      KEY("subnet"),
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION, ids: ["64", "8"] }),
    );
    win().localStorage.setItem(
      KEY("validator"),
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION, ids: ["5ABC"] }),
    );

    const file = JSON.stringify(exportWatchlists());
    store.clear();
    importWatchlists(file);

    expect(exportWatchlists().watchlists).toEqual({
      subnet: ["64", "8"],
      validator: ["5ABC"],
      account: [],
    });
  });

  it("reads the unversioned v1 bare array, so upgrading doesn't drop anyone's stars", () => {
    // v1 wrote `["64","8"]` with no envelope. Those entries predate the version
    // field entirely and must keep working.
    win().localStorage.setItem(KEY("subnet"), JSON.stringify(["64", "8"]));
    expect(exportWatchlists().watchlists.subnet).toEqual(["64", "8"]);
  });

  it("ignores a file from a future schema version rather than guessing at it", () => {
    win().localStorage.setItem(
      KEY("subnet"),
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION + 1, ids: ["64"] }),
    );
    expect(exportWatchlists().watchlists.subnet).toEqual([]);
  });

  it("survives corrupt JSON instead of throwing into the render", () => {
    win().localStorage.setItem(KEY("subnet"), "{not json");
    expect(exportWatchlists().watchlists.subnet).toEqual([]);
  });

  it("merges on import — importing never deletes stars already on this device", () => {
    win().localStorage.setItem(
      KEY("subnet"),
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION, ids: ["64"] }),
    );
    const added = importWatchlists(
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION, watchlists: { subnet: ["8", "64"] } }),
    );
    // "64" was already there, so only "8" is new.
    expect(added.subnet).toBe(1);
    expect(new Set(exportWatchlists().watchlists.subnet)).toEqual(new Set(["64", "8"]));
  });

  it("rejects a file that isn't a watchlist export, with a message worth showing", () => {
    expect(() => importWatchlists(JSON.stringify({ hello: "world" }))).toThrow(
      /Not a Metagraphed watchlist file/,
    );
  });

  it("notifies this tab on import — storage events don't fire in the writing tab", () => {
    const seen: string[] = [];
    const onStorage = (e: { key: string | null }) => seen.push(e.key ?? "");
    win().addEventListener("storage", onStorage);
    importWatchlists(
      JSON.stringify({ version: WATCHLIST_SCHEMA_VERSION, watchlists: { subnet: ["64"] } }),
    );
    win().removeEventListener("storage", onStorage);
    expect(seen).toContain(KEY("subnet"));
  });
});
