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

  it("only links to real curation levels in subnet filters", () => {
    // /subnets filters on the curation levels enumerated in chips.tsx's
    // `curationLabel`. A mega-menu link carrying a value outside this set
    // (e.g. the old "verified") matches zero rows and silently renders the
    // full unfiltered list instead of a curated one.
    const CURATION_LEVELS = new Set([
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
          expect(CURATION_LEVELS.has(curation)).toBe(true);
        }
      }
    }
  });

  it("only links to route-consumed filter params/values on /endpoints", () => {
    // /endpoints (routes/endpoints.tsx) reads category / health / eligibility;
    // its facet chips enumerate the allowed values. A mega-menu link carrying a
    // param the route never reads (the old kind / archive / pool / incidents /
    // stale) matches zero rows and silently renders the unfiltered list. Pin
    // every /endpoints filter link to a param+value the route actually accepts.
    const SCHEMA_KEYS = new Set([
      "q",
      "category",
      "provider",
      "health",
      "netuid",
      "region",
      "eligibility",
      "callable",
      "sort",
      "order",
      "page",
      "pageSize",
      "view",
    ]);
    const FACET_VALUES: Record<string, Set<string>> = {
      category: new Set(["all", "rpc", "wss", "api", "sse", "data", "other"]),
      health: new Set(["ok", "warn", "down", "unknown"]),
      eligibility: new Set(["proxy-enabled", "pool-member", "archive-capable", "unassigned"]),
    };
    const endpoints = MEGA_PANELS.find((p) => p.key === "endpoints");
    expect(endpoints).toBeDefined();
    for (const l of [...endpoints!.browse, ...endpoints!.filters]) {
      for (const [param, value] of Object.entries(l.search ?? {})) {
        expect(SCHEMA_KEYS.has(param)).toBe(true);
        const allowed = FACET_VALUES[param];
        if (allowed) expect(allowed.has(value)).toBe(true);
      }
    }
  });
  it("surfaces both /status and /health under the Health mega-panel", () => {
    // #5345: /status was footer-only while the mega-menu deep-linked only into
    // /health?view=… — surface both so users can reach public status and the
    // ops drill-down from the same panel without guessing which page is which.
    const health = MEGA_PANELS.find((p) => p.key === "health");
    expect(health).toBeDefined();
    const browseTos = new Set(health!.browse.map((l) => l.to));
    expect(browseTos.has("/status")).toBe(true);
    expect(browseTos.has("/health")).toBe(true);
    expect(health!.browse[0]?.to).toBe("/status");
    expect(health!.browse[0]?.label).toMatch(/public status/i);
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
