import { describe, it, expect } from "vitest";
import {
  MEGA_PANELS,
  loadFilters,
  loadPersistedOpen,
  loadRecent,
  persistFilter,
  persistOpen,
  pushRecentView,
} from "./nav-mega-menu-data";

// These guard the shared catalogue/state module that both the (statically
// imported) trigger shell and the lazily-loaded panel body depend on, so the
// code-split can't silently drop or desync a panel.

describe("MEGA_PANELS catalogue", () => {
  it("exposes the expected primary panels in order", () => {
    // Schemas + Gaps were demoted to footer-only navigation; they remain
    // routes but no longer carry a top-level mega-panel.
    expect(MEGA_PANELS.map((p) => p.key)).toEqual([
      "subnets",
      "blocks",
      "surfaces",
      "endpoints",
      "providers",
      "health",
    ]);
  });

  it("has unique keys and self-consistent route/api fields", () => {
    const keys = new Set<string>();
    for (const p of MEGA_PANELS) {
      expect(keys.has(p.key)).toBe(false);
      keys.add(p.key);
      expect(p.to.startsWith("/")).toBe(true);
      expect(p.apiPath.startsWith("/api/v1/")).toBe(true);
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.icon).toBe("object");
    }
  });

  it("only carries subnet/provider live-preview panels that the body can render", () => {
    // The lazy body renders hover-card previews only for these two kinds;
    // every browse/filter link must still point at a real route.
    for (const p of MEGA_PANELS) {
      for (const l of [...p.browse, ...p.filters]) {
        expect(l.to.startsWith("/")).toBe(true);
        expect(l.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("every curation filter link targets a real curation level", () => {
    // The only curation values subnets.index.tsx actually matches are the
    // levels enumerated in chips.tsx `curationLabel`. A link with any other
    // value (e.g. the former "verified") matches zero rows and silently
    // renders the full unfiltered list instead of filtering.
    const VALID_CURATION_LEVELS = new Set([
      "native",
      "candidate-discovered",
      "community-seeded",
      "machine-verified",
      "maintainer-reviewed",
      "adapter-backed",
    ]);
    for (const p of MEGA_PANELS) {
      for (const l of [...p.browse, ...p.filters]) {
        const curation = l.search?.curation;
        if (curation !== undefined) {
          expect(VALID_CURATION_LEVELS.has(curation)).toBe(true);
        }
      }
    }
  });
});

describe("storage helpers (SSR/node-safe)", () => {
  // In the node test environment `window` is undefined, so every helper must
  // degrade to a safe default and never throw — the same path SSR exercises.
  it("returns empty defaults and no-ops when window is absent", () => {
    expect(typeof window).toBe("undefined");
    expect(loadRecent()).toEqual([]);
    expect(loadFilters()).toEqual({});
    expect(loadPersistedOpen()).toBeNull();
    expect(() => persistOpen("subnets")).not.toThrow();
    expect(() => persistFilter("subnets", "x")).not.toThrow();
    expect(() => pushRecentView({ kind: "subnet", to: "/subnets/7", label: "SN7" })).not.toThrow();
  });
});
