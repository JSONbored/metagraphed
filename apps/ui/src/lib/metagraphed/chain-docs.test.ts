import { describe, expect, it } from "vitest";
import {
  CHAIN_ACTIVITY_PATH,
  CHAIN_ANALYTICS_ROUTES,
  CHAIN_ANALYTICS_ROUTE_COUNT,
  CHAIN_CALLS_PATH,
  CHAIN_DOCS_CALLS_GROUP_BY,
  CHAIN_DOCS_CALL_MODULE_MAX_LENGTH,
  CHAIN_DOCS_DEFAULT_LIMIT,
  CHAIN_DOCS_DEFAULT_WINDOW,
  CHAIN_DOCS_FEES_DEFAULT_LIMIT,
  CHAIN_DOCS_MAX_LIMIT,
  CHAIN_DOCS_SIGNERS_SORTS,
  CHAIN_DOCS_WINDOWS,
  CHAIN_FEES_PATH,
  CHAIN_SIGNERS_PATH,
  buildChainBehaviourRows,
  buildChainCsvCurlExample,
  buildChainCurlExample,
  chainAnalyticsUrl,
  formatChainLimitRange,
} from "./chain-docs";

describe("chain analytics docs reference", () => {
  it("keeps Worker-aligned window, enum, and limit constants", () => {
    expect([...CHAIN_DOCS_WINDOWS]).toEqual(["7d", "30d"]);
    expect(CHAIN_DOCS_DEFAULT_WINDOW).toBe("7d");
    expect([...CHAIN_DOCS_SIGNERS_SORTS]).toEqual(["tx_count", "total_fee_tao"]);
    expect([...CHAIN_DOCS_CALLS_GROUP_BY]).toEqual(["module", "module_function"]);
    expect(CHAIN_DOCS_MAX_LIMIT).toBe(100);
    expect(CHAIN_DOCS_DEFAULT_LIMIT).toBe(50);
    expect(CHAIN_DOCS_FEES_DEFAULT_LIMIT).toBe(25);
    expect(CHAIN_DOCS_CALL_MODULE_MAX_LENGTH).toBe(100);
  });

  it("documents the four routed paths without duplicates", () => {
    expect(CHAIN_ANALYTICS_ROUTES).toHaveLength(CHAIN_ANALYTICS_ROUTE_COUNT);
    const paths = CHAIN_ANALYTICS_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([
      CHAIN_ACTIVITY_PATH,
      CHAIN_CALLS_PATH,
      CHAIN_SIGNERS_PATH,
      CHAIN_FEES_PATH,
    ]);
    for (const route of CHAIN_ANALYTICS_ROUTES) {
      expect(route.method).toBe("GET");
      expect(route.path.startsWith("/api/v1/chain/")).toBe(true);
      expect(route.params.length).toBeGreaterThan(0);
      expect(route.responseFields).toContain("observed_at");
      expect(route.csvColumns.length).toBeGreaterThan(0);
    }
  });

  it("gives every route a window param and only the routes that page a limit param", () => {
    const named = (path: string) => {
      const route = CHAIN_ANALYTICS_ROUTES.find((r) => r.path === path);
      return route ? route.params.map((p) => p.name) : [];
    };
    for (const route of CHAIN_ANALYTICS_ROUTES) {
      expect(route.params.map((p) => p.name)).toContain("window");
    }
    // activity aggregates a fixed per-day series -- it takes no limit/call_module scope.
    expect(named(CHAIN_ACTIVITY_PATH)).toEqual(["window", "format"]);
    expect(named(CHAIN_CALLS_PATH)).toContain("group_by");
    expect(named(CHAIN_SIGNERS_PATH)).toContain("sort");
    expect(named(CHAIN_FEES_PATH)).not.toContain("sort");
    for (const path of [CHAIN_CALLS_PATH, CHAIN_SIGNERS_PATH, CHAIN_FEES_PATH]) {
      expect(named(path)).toContain("limit");
      expect(named(path)).toContain("call_module");
    }
  });

  it("formats a limit range and guards non-finite input", () => {
    expect(formatChainLimitRange(50, 100)).toBe("50 default · 100 max");
    expect(formatChainLimitRange(25, 100)).toBe("25 default · 100 max");
    expect(formatChainLimitRange(Number.NaN, 100)).toBe("—");
  });

  it("builds a behaviour table covering window, limits, validation, and caching", () => {
    const rows = buildChainBehaviourRows();
    expect(rows.map((r) => r.label)).toEqual([
      "Window",
      "Result limit",
      "Unknown params",
      "Cold store",
      "Caching",
      "Source tier",
    ]);
    expect(rows[0]?.value).toContain("7d");
    expect(rows[1]?.value).toBe("50 default · 100 max");
  });

  it("builds request URLs and curl examples against the resolved window", () => {
    expect(chainAnalyticsUrl("https://api.metagraph.sh", CHAIN_ACTIVITY_PATH)).toBe(
      "https://api.metagraph.sh/api/v1/chain/activity",
    );
    expect(
      chainAnalyticsUrl("https://api.metagraph.sh/", CHAIN_CALLS_PATH, { window: "30d" }),
    ).toBe("https://api.metagraph.sh/api/v1/chain/calls?window=30d");

    const curl = buildChainCurlExample("https://api.metagraph.sh");
    expect(curl).toContain("https://api.metagraph.sh/api/v1/chain/activity?window=7d");

    const csvCurl = buildChainCsvCurlExample("https://api.metagraph.sh");
    expect(csvCurl).toContain("/api/v1/chain/fees?window=30d&format=csv");
  });
});
