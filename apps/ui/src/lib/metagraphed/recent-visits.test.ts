import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRecentVisits,
  loadRecentVisits,
  pushRecentVisit,
  visitFromPath,
} from "./recent-visits";

function mockLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    dispatchEvent: vi.fn(),
  });
  return store;
}

describe("loadRecentVisits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty list during SSR", () => {
    expect(loadRecentVisits()).toEqual([]);
  });

  it("filters malformed entries and caps at twelve items", () => {
    mockLocalStorage();
    const visits = Array.from({ length: 14 }, (_, i) => ({
      kind: "subnet" as const,
      id: String(i),
      href: `/subnets/${i}`,
      ts: i,
    }));
    window.localStorage.setItem("mg.recent.visits.v1", JSON.stringify(visits));

    expect(loadRecentVisits()).toHaveLength(12);
    expect(loadRecentVisits()[0]).toEqual({
      kind: "subnet",
      id: "0",
      href: "/subnets/0",
      ts: 0,
    });
  });
});

describe("pushRecentVisit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepends the latest visit and dedupes by kind and id", () => {
    mockLocalStorage();
    pushRecentVisit({ kind: "subnet", id: "7", href: "/subnets/7", label: "SN7" });
    pushRecentVisit({ kind: "provider", id: "taostats", href: "/providers/taostats" });
    pushRecentVisit({ kind: "subnet", id: "7", href: "/subnets/7", label: "SN7 again" });

    const visits = loadRecentVisits();
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      kind: "subnet",
      id: "7",
      href: "/subnets/7",
      label: "SN7 again",
    });
    expect(visits[1]).toMatchObject({ kind: "provider", id: "taostats" });
  });

  it("ignores visits without an id", () => {
    mockLocalStorage();
    pushRecentVisit({ kind: "page", id: "", href: "/status" });
    expect(loadRecentVisits()).toEqual([]);
  });
});

describe("clearRecentVisits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes persisted visits", () => {
    mockLocalStorage();
    pushRecentVisit({ kind: "subnet", id: "1", href: "/subnets/1" });
    clearRecentVisits();
    expect(loadRecentVisits()).toEqual([]);
  });
});

describe("visitFromPath", () => {
  it("parses subnet entity paths", () => {
    expect(visitFromPath("/subnets/7")).toEqual({
      kind: "subnet",
      id: "7",
      href: "/subnets/7",
    });
    expect(visitFromPath("/subnets/sn-32?tab=evidence")).toEqual({
      kind: "subnet",
      id: "sn-32",
      href: "/subnets/sn-32",
    });
  });

  it("parses provider entity paths", () => {
    expect(visitFromPath("/providers/taostats")).toEqual({
      kind: "provider",
      id: "taostats",
      href: "/providers/taostats",
    });
  });

  it("returns null for non-entity routes", () => {
    expect(visitFromPath("/")).toBeNull();
    expect(visitFromPath("/health")).toBeNull();
    expect(visitFromPath("/accounts/5GrwvaEF")).toBeNull();
  });
});
