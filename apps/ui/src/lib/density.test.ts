import { afterEach, describe, expect, it, vi } from "vitest";

import { readChoice } from "./density";

describe("readChoice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns comfortable during SSR when window is absent", () => {
    expect(readChoice()).toBe("comfortable");
  });

  it("returns comfortable when localStorage is empty", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });
    expect(readChoice()).toBe("comfortable");
  });

  it("restores a persisted compact choice", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => "compact") },
    });
    expect(readChoice()).toBe("compact");
  });

  it("falls back to comfortable for unknown stored values", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => "spacious") },
    });
    expect(readChoice()).toBe("comfortable");
  });

  it("degrades to comfortable when localStorage.getItem throws (#6027)", () => {
    // Safari private browsing / storage blocked by policy or an extension makes
    // getItem throw; readChoice must not throw during the initial render.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("localStorage is not available");
        }),
      },
    });
    expect(() => readChoice()).not.toThrow();
    expect(readChoice()).toBe("comfortable");
  });
});
