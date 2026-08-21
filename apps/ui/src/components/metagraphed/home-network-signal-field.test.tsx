import { describe, expect, it } from "vitest";
import { buildHomeNetworkSignalRows, formatHomePriceShare } from "./home-network-signal-field";

describe("buildHomeNetworkSignalRows", () => {
  it("joins registry names and probe health without changing the economic rank", () => {
    const rows = buildHomeNetworkSignalRows({
      economics: [
        { netuid: 21, name: "economic fallback", emission_share: 0.071 },
        { netuid: 18, emission_share: 0.12 },
      ],
      subnets: [
        { netuid: 21, name: "Registry name", derived_categories: ["agents"] },
        { netuid: 18, name: "Second", derived_categories: ["inference"] },
      ],
      healthByNetuid: {
        21: { health: "down" },
        18: { health: "ok" },
      },
    });

    expect(rows).toEqual([
      {
        netuid: 18,
        name: "Second",
        priceShare: 0.12,
        health: "ok",
        category: "inference",
        categoryLabel: "Inference",
        seriesTone: "chart-2",
        categoryTags: ["inference"],
      },
      {
        netuid: 21,
        name: "Registry name",
        priceShare: 0.071,
        health: "down",
        category: "agents",
        categoryLabel: "Agents",
        seriesTone: "chart-1",
        categoryTags: ["agents"],
      },
    ]);
  });

  it("does not fabricate bars for root, absent, zero, or invalid price-share readings", () => {
    const rows = buildHomeNetworkSignalRows({
      economics: [
        { netuid: 0, emission_share: 0.9 },
        { netuid: 1 },
        { netuid: 2, emission_share: 0 },
        { netuid: 3, emission_share: -0.1 },
        { netuid: 4, emission_share: Number.NaN },
        { netuid: 5, emission_share: 1.01 },
        { netuid: 6, emission_share: 0.0042 },
      ],
      subnets: [],
      healthByNetuid: {},
    });

    expect(rows).toEqual([
      {
        netuid: 6,
        name: "Subnet 6",
        priceShare: 0.0042,
        health: "unknown",
        category: "otherSystems",
        categoryLabel: "Other systems",
        seriesTone: "chart-11",
        categoryTags: [],
      },
    ]);
  });

  it("keeps one deterministic row per subnet and honors the visual limit", () => {
    const rows = buildHomeNetworkSignalRows({
      economics: [
        { netuid: 3, emission_share: 0.04 },
        { netuid: 3, emission_share: 0.09 },
        { netuid: 2, emission_share: 0.09 },
        { netuid: 1, emission_share: 0.08 },
      ],
      subnets: [],
      healthByNetuid: {},
      limit: 2,
    });

    expect(rows.map((row) => [row.netuid, row.priceShare, row.seriesTone])).toEqual([
      [2, 0.09, "chart-11"],
      [3, 0.09, "chart-11"],
    ]);
  });

  it("uses a visible category key instead of arbitrary identity colors", () => {
    const rows = buildHomeNetworkSignalRows({
      economics: [
        { netuid: 2, emission_share: 0.09 },
        { netuid: 64, emission_share: 0.08 },
      ],
      subnets: [
        { netuid: 2, derived_categories: ["inference"] },
        { netuid: 64, derived_categories: ["inference"] },
      ],
      healthByNetuid: {},
    });

    expect(rows.map((row) => row.seriesTone)).toEqual(["chart-2", "chart-2"]);
  });

  it("uses one visible registry-family label per prism color and does not trust tag order", () => {
    const rows = buildHomeNetworkSignalRows({
      economics: [
        { netuid: 1, emission_share: 0.09 },
        { netuid: 2, emission_share: 0.08 },
        { netuid: 3, emission_share: 0.07 },
        { netuid: 4, emission_share: 0.06 },
      ],
      subnets: [
        { netuid: 1, derived_categories: ["security"] },
        { netuid: 2, derived_categories: ["data"] },
        { netuid: 3, derived_categories: ["media", "agents"] },
        { netuid: 4, derived_categories: ["robotics"] },
      ],
      healthByNetuid: {},
    });

    expect(rows.map((row) => [row.category, row.categoryLabel, row.seriesTone])).toEqual([
      ["dataSecurity", "Data & security", "chart-6"],
      ["dataSecurity", "Data & security", "chart-6"],
      ["agents", "Agents", "chart-1"],
      ["otherSystems", "Other systems", "chart-11"],
    ]);
    expect(rows[2]?.categoryTags).toEqual(["agents", "media"]);

    const visibleKey = new Map<string, string>();
    for (const row of rows) {
      const previous = visibleKey.get(row.seriesTone);
      expect(previous === undefined || previous === row.categoryLabel).toBe(true);
      visibleKey.set(row.seriesTone, row.categoryLabel);
    }
  });
});

describe("formatHomePriceShare", () => {
  it("keeps small price-share differences legible without pretending absent data is zero", () => {
    expect(formatHomePriceShare(0.051502)).toBe("5.15%");
    expect(formatHomePriceShare(0.125)).toBe("12.5%");
  });
});
