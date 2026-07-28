import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADDRESS_LABELS_SCHEMA_VERSION,
  MAX_LABELS,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  exportAddressLabels,
  importAddressLabels,
} from "./address-labels";

const KEY = "metagraphed:address-labels";

// Same plain-node stub as watchlist.test.ts — the store only needs
// localStorage and addEventListener/dispatchEvent.
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
(globalThis as unknown as { StorageEvent: unknown }).StorageEvent = class {
  key: string | null;
  constructor(_type: string, init?: { key?: string }) {
    this.key = init?.key ?? null;
  }
};

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

const SS58_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const SS58_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("address-labels storage schema (#8484)", () => {
  it("round-trips an export through an import", () => {
    win().localStorage.setItem(
      KEY,
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: { [SS58_A]: { name: "Main coldkey", updated_at: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    const file = JSON.stringify(exportAddressLabels());
    store.clear();
    importAddressLabels(file);
    expect(exportAddressLabels().labels[SS58_A]?.name).toBe("Main coldkey");
  });

  it("ignores a file from a future schema version rather than guessing at it", () => {
    win().localStorage.setItem(
      KEY,
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION + 1,
        labels: { [SS58_A]: { name: "Main", updated_at: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    expect(exportAddressLabels().labels).toEqual({});
  });

  it("survives corrupt JSON instead of throwing into the render", () => {
    win().localStorage.setItem(KEY, "{not json");
    expect(exportAddressLabels().labels).toEqual({});
  });

  it("drops an entry with no usable name rather than storing a blank label", () => {
    win().localStorage.setItem(
      KEY,
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: { [SS58_A]: { name: "   ", updated_at: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    expect(exportAddressLabels().labels).toEqual({});
  });

  it("clamps an oversized name and note on read", () => {
    win().localStorage.setItem(
      KEY,
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: {
          [SS58_A]: {
            name: "x".repeat(MAX_NAME_LENGTH + 20),
            note: "y".repeat(MAX_NOTE_LENGTH + 20),
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const entry = exportAddressLabels().labels[SS58_A];
    expect(entry?.name.length).toBe(MAX_NAME_LENGTH);
    expect(entry?.note?.length).toBe(MAX_NOTE_LENGTH);
  });

  it("merges on import — importing never overwrites a label already on this device", () => {
    win().localStorage.setItem(
      KEY,
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: { [SS58_A]: { name: "Local name", updated_at: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    const added = importAddressLabels(
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: {
          [SS58_A]: { name: "Imported name", updated_at: "2026-01-02T00:00:00.000Z" },
          [SS58_B]: { name: "New one", updated_at: "2026-01-02T00:00:00.000Z" },
        },
      }),
    );
    expect(added).toBe(1);
    const labels = exportAddressLabels().labels;
    expect(labels[SS58_A]?.name).toBe("Local name");
    expect(labels[SS58_B]?.name).toBe("New one");
  });

  it("rejects a file that isn't an address-labels export, with a message worth showing", () => {
    expect(() => importAddressLabels(JSON.stringify({ hello: "world" }))).toThrow(
      /Not a Metagraphed address-labels file/,
    );
  });

  it("stops importing once the local store would exceed MAX_LABELS", () => {
    const existing: Record<string, { name: string; updated_at: string }> = {};
    for (let i = 0; i < MAX_LABELS - 1; i++) {
      existing[`addr-${i}`] = { name: `Label ${i}`, updated_at: "2026-01-01T00:00:00.000Z" };
    }
    win().localStorage.setItem(
      KEY,
      JSON.stringify({ version: ADDRESS_LABELS_SCHEMA_VERSION, labels: existing }),
    );
    const added = importAddressLabels(
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: {
          "new-1": { name: "One", updated_at: "2026-01-01T00:00:00.000Z" },
          "new-2": { name: "Two", updated_at: "2026-01-01T00:00:00.000Z" },
        },
      }),
    );
    expect(added).toBe(1);
    expect(Object.keys(exportAddressLabels().labels)).toHaveLength(MAX_LABELS);
  });

  it("notifies this tab on import — storage events don't fire in the writing tab", () => {
    const seen: string[] = [];
    const onStorage = (e: { key: string | null }) => seen.push(e.key ?? "");
    win().addEventListener("storage", onStorage);
    importAddressLabels(
      JSON.stringify({
        version: ADDRESS_LABELS_SCHEMA_VERSION,
        labels: { [SS58_A]: { name: "Main", updated_at: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    win().removeEventListener("storage", onStorage);
    expect(seen).toContain(KEY);
  });
});
