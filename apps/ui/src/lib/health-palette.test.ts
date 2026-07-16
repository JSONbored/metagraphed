import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cssFor, HEALTH_PALETTES, readId, useHealthPalette } from "./health-palette";

function HealthPaletteProbe() {
  const { paletteId } = useHealthPalette();
  return React.createElement("output", null, paletteId);
}

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

  it("falls back to the default palette when localStorage.getItem throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("storage blocked");
        }),
      },
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
});

describe("useHealthPalette", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the default palette when localStorage.getItem throws during initial render", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("storage blocked");
        }),
      },
    });

    expect(() => renderToString(React.createElement(HealthPaletteProbe))).not.toThrow();
    expect(renderToString(React.createElement(HealthPaletteProbe))).toContain("traffic-light");
  });
});
