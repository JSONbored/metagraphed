import { describe, expect, it } from "vitest";
import {
  ECONOMICS_ARTIFACT_PATH,
  ECONOMICS_MAX_LIMIT,
  ECONOMICS_PARAMS,
  ECONOMICS_PATH,
  ECONOMICS_SEARCH_KEYS,
  ECONOMICS_SORT_FIELDS,
  ECONOMICS_SORT_FIELD_COUNT,
  ECONOMICS_SURFACES,
  ECONOMICS_SURFACE_COUNT,
  ECONOMICS_TRENDS_DEFAULT_WINDOW,
  ECONOMICS_TRENDS_METRICS,
  ECONOMICS_TRENDS_PATH,
  ECONOMICS_TRENDS_WINDOWS,
  buildEconomicsCurlExample,
  buildEconomicsTrendsCurlExample,
} from "./economics-docs";

describe("economics docs reference (#3509)", () => {
  it("keeps Worker-aligned paths and limits", () => {
    expect(ECONOMICS_PATH).toBe("/api/v1/economics");
    expect(ECONOMICS_TRENDS_PATH).toBe("/api/v1/economics/trends");
    expect(ECONOMICS_ARTIFACT_PATH).toBe("/metagraph/economics.json");
    expect(ECONOMICS_MAX_LIMIT).toBe(1000);
  });

  it("documents both surfaces exactly once", () => {
    expect(ECONOMICS_SURFACES).toHaveLength(ECONOMICS_SURFACE_COUNT);
    const paths = ECONOMICS_SURFACES.map((s) => s.path);
    expect(paths).toEqual([ECONOMICS_PATH, ECONOMICS_TRENDS_PATH]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const s of ECONOMICS_SURFACES) expect(s.method).toBe("GET");
  });

  it("mirrors the collection's sort fields without duplicates", () => {
    expect(ECONOMICS_SORT_FIELDS).toHaveLength(ECONOMICS_SORT_FIELD_COUNT);
    expect(new Set(ECONOMICS_SORT_FIELDS).size).toBe(ECONOMICS_SORT_FIELDS.length);
    // Sorted, so the rendered list is stable and scannable.
    expect([...ECONOMICS_SORT_FIELDS]).toEqual([...ECONOMICS_SORT_FIELDS].sort());
    for (const f of ["emission_share", "alpha_price_tao", "total_stake_tao", "netuid"]) {
      expect(ECONOMICS_SORT_FIELDS).toContain(f);
    }
  });

  it("documents the filter/search/list params", () => {
    expect(ECONOMICS_PARAMS.map((p) => p.param)).toEqual([
      "q",
      "netuid",
      "registration_allowed",
      "sort",
      "order",
      "limit",
      "cursor",
      "fields",
      "format",
    ]);
    expect([...ECONOMICS_SEARCH_KEYS]).toEqual(["name", "slug"]);
    expect(ECONOMICS_PARAMS.find((p) => p.param === "q")?.detail).toContain("name and slug");
    expect(ECONOMICS_PARAMS.find((p) => p.param === "limit")?.value).toBe(
      `1..${ECONOMICS_MAX_LIMIT}`,
    );
    // The combined `field:desc` token is explicitly unsupported — say so.
    expect(ECONOMICS_PARAMS.find((p) => p.param === "sort")?.detail).toContain("NOT supported");
  });

  it("documents the trends windows and per-day metrics", () => {
    expect([...ECONOMICS_TRENDS_WINDOWS]).toEqual(["7d", "30d", "90d", "1y", "all"]);
    expect(ECONOMICS_TRENDS_WINDOWS).toContain(ECONOMICS_TRENDS_DEFAULT_WINDOW);
    expect(ECONOMICS_TRENDS_DEFAULT_WINDOW).toBe("30d");
    expect(ECONOMICS_TRENDS_METRICS.length).toBeGreaterThan(0);
  });

  it("builds curl examples against the real routes", () => {
    const list = buildEconomicsCurlExample("https://api.metagraph.sh/");
    expect(list).toContain("https://api.metagraph.sh/api/v1/economics?");
    expect(list).toContain("order=desc");
    expect(list).not.toContain("//api/v1");

    const trends = buildEconomicsTrendsCurlExample("https://api.metagraph.sh", "90d");
    expect(trends).toContain("/api/v1/economics/trends?window=90d");
    expect(buildEconomicsTrendsCurlExample("https://api.metagraph.sh")).toContain("window=30d");
  });
});
