import { afterEach, describe, expect, it, vi } from "vitest";

import { readStoredValueUnit } from "./value-unit";

const STORAGE_KEY = "mg:value-unit";

describe("readStoredValueUnit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns both during SSR when window is absent (first-load default)", () => {
    expect(readStoredValueUnit()).toBe("both");
  });

  it("returns both when localStorage is empty", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });
    expect(readStoredValueUnit()).toBe("both");
  });

  it("restores a valid stored preference", () => {
    for (const unit of ["tao", "usd", "both"] as const) {
      vi.stubGlobal("window", {
        localStorage: { getItem: vi.fn((k: string) => (k === STORAGE_KEY ? unit : null)) },
      });
      expect(readStoredValueUnit()).toBe(unit);
    }
  });

  it("falls back to both for invalid/corrupt stored values", () => {
    for (const raw of ["spacious", "TAO", "{bad", ""]) {
      vi.stubGlobal("window", {
        localStorage: { getItem: vi.fn(() => raw) },
      });
      expect(readStoredValueUnit()).toBe("both");
    }
  });

  it("degrades to both when localStorage.getItem throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("localStorage is not available");
        }),
      },
    });
    expect(() => readStoredValueUnit()).not.toThrow();
    expect(readStoredValueUnit()).toBe("both");
  });
});
