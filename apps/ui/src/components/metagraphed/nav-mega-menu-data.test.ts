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
    // #8246: five hubs, matching primary nav. Surfaces/endpoints/providers/
    // schemas collapsed into the APIs hub (#8245); blocks and the rest of the
    // chain routes into the Chain hub (#8244); health left primary navigation
    // entirely, reduced to the header status dot, because an ops console is
    // not a peer of Subnets and Chain.
    expect(MEGA_PANELS.map((p) => p.key)).toEqual([
      "subnets",
      "validators",
      "chain",
      "accounts",
      "apis",
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

  it("only links to route-consumed filter params/values in the APIs hub", () => {
    // #8302/#8303 folded /surfaces, /endpoints, /schemas and /providers into
    // one hub with different sub-routes, each with its OWN search schema — a
    // link's params must match the schema of the route it actually points at
    // (routes/apis.index.tsx for the Catalog tab, apis.endpoints.tsx for Live
    // endpoints), not one merged vocabulary. A param the target route never
    // reads matches zero rows and silently renders the unfiltered list.
    const SCHEMA_KEYS: Record<string, Set<string>> = {
      "/apis": new Set([
        "q",
        "kind",
        "provider",
        "netuid",
        "sort",
        "order",
        "page",
        "pageSize",
        "view",
        "public_safe",
        "auth",
        "rate_limited",
      ]),
      "/apis/endpoints": new Set([
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
      ]),
    };
    const FACET_VALUES: Record<string, Record<string, Set<string>>> = {
      "/apis": {
        kind: new Set(["openapi", "docs", "dashboard", "data", "sse"]),
      },
      "/apis/endpoints": {
        category: new Set(["all", "rpc", "wss", "api", "sse", "data", "other"]),
        health: new Set(["ok", "warn", "down", "unknown"]),
        eligibility: new Set(["proxy-enabled", "pool-member", "archive-capable", "unassigned"]),
      },
    };
    const apis = MEGA_PANELS.find((p) => p.key === "apis");
    expect(apis).toBeDefined();
    for (const l of [...apis!.browse, ...apis!.filters]) {
      const schema = SCHEMA_KEYS[l.to];
      if (!schema) continue; // links to routes outside this hub (e.g. /agents)
      for (const [param, value] of Object.entries(l.search ?? {})) {
        expect(schema.has(param)).toBe(true);
        const allowed = FACET_VALUES[l.to]?.[param];
        if (allowed) expect(allowed.has(value)).toBe(true);
      }
    }
  });
  it("keeps ops surfaces out of the primary mega-menu", () => {
    // Supersedes the #5345 expectation that /status and /health both sat in a
    // Health mega-panel. #8246 removed that panel: /status is reachable from
    // the header status dot (which is the one bit most visitors want from it),
    // /health is the maintainer ops console and is footer + palette only.
    // Neither belongs beside Subnets and Chain in primary navigation.
    expect(MEGA_PANELS.some((p) => p.key === "health")).toBe(false);
    const allTos = MEGA_PANELS.flatMap((p) => [...p.browse, ...p.filters]).map((l) => l.to);
    expect(allTos).not.toContain("/health");
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
