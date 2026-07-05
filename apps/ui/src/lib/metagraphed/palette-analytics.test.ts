import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAnalytics,
  resetAnalytics,
  trackAction,
  trackOpen,
  trackQuery,
  trackScope,
  trackSelection,
  trim,
} from "./palette-analytics";

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
  });
  return store;
}

describe("trim", () => {
  it("keeps only the highest-count entries up to max", () => {
    expect(trim({ low: 1, mid: 3, high: 5, top: 7 }, 2)).toEqual({ top: 7, high: 5 });
  });
});

describe("palette analytics tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns empty analytics during SSR", () => {
    expect(getAnalytics()).toEqual({
      opens: 0,
      selections: 0,
      topQueries: {},
      zeroResultQueries: {},
      scopeUsage: {},
      actionUsage: {},
    });
  });

  it("tracks opens with a timestamp", () => {
    mockLocalStorage();
    trackOpen();
    trackOpen();
    expect(getAnalytics()).toMatchObject({
      opens: 2,
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("tracks normalized queries and zero-result searches", () => {
    mockLocalStorage();
    trackQuery("  RPC  ", 3);
    trackQuery("rpc", 0);

    expect(getAnalytics()).toMatchObject({
      topQueries: { rpc: 2 },
      zeroResultQueries: { rpc: 1 },
    });
  });

  it("ignores blank queries", () => {
    mockLocalStorage();
    trackQuery("   ", 1);
    expect(getAnalytics().topQueries).toEqual({});
  });

  it("tracks scope, selection, and action usage", () => {
    mockLocalStorage();
    trackScope("subnets");
    trackSelection("subnet");
    trackAction("jump");

    expect(getAnalytics()).toMatchObject({
      scopeUsage: { subnets: 1 },
      selections: 1,
      actionUsage: { "select:subnet": 1, jump: 1 },
    });
  });

  it("trims topQueries after fifty distinct searches", () => {
    mockLocalStorage();
    for (let i = 0; i < 55; i++) {
      trackQuery(`query-${i}`, 1);
    }
    expect(Object.keys(getAnalytics().topQueries)).toHaveLength(50);
  });

  it("clears persisted analytics", () => {
    mockLocalStorage();
    trackOpen();
    resetAnalytics();
    expect(getAnalytics()).toMatchObject({ opens: 0, selections: 0 });
  });
});
