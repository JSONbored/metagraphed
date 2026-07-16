import { afterEach, describe, expect, it, vi } from "vitest";

import { cssFor, HEALTH_PALETTES, readId } from "./health-palette";

describe("cssFor", () => {
  it("maps each palette to light :root and dark .dark health variables", () => {
    for (const palette of HEALTH_PALETTES) {
      const css = cssFor(palette);
      expect(css).toBe(
        `:root{--health-ok:${palette.light.ok};--health-warn:${palette.light.warn};--health-down:${palette.light.down};--health-unknown:${palette.light.unknown};}` +
          `.dark{--health-ok:${palette.dark.ok};--health-warn:${palette.dark.warn};--health-down:${palette.dark.down};--health-unknown:${palette.dark.unknown};}`,
      );
    }
  });
});

describe("readId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the default palette during SSR when window is absent", () => {
    expect(readId()).toBe("traffic-light");
  });

  it("returns the default palette when localStorage is empty", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => null) },
    });
    expect(readId()).toBe("traffic-light");
  });

  it("restores a valid persisted palette id", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => "colorblind-safe") },
    });
    expect(readId()).toBe("colorblind-safe");
  });

  it("falls back to the default palette for unknown stored values", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn(() => "not-a-real-palette") },
    });
    expect(readId()).toBe("traffic-light");
  });

  it("resolves every registered palette id from storage", () => {
    for (const palette of HEALTH_PALETTES) {
      vi.stubGlobal("window", {
        localStorage: { getItem: vi.fn(() => palette.id) },
      });
      expect(readId()).toBe(palette.id);
      vi.unstubAllGlobals();
    }
  });

  it("degrades to the default when localStorage.getItem throws (#6027)", () => {
    // Safari private browsing / storage blocked by policy or an extension makes
    // getItem throw; readId must not throw during the initial render.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("localStorage is not available");
        }),
      },
    });
    expect(() => readId()).not.toThrow();
    expect(readId()).toBe("traffic-light");
  });
});
