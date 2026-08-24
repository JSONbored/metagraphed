import { describe, expect, it } from "vitest";
import type { EmissionSplitPoint, SubnetEconomics } from "@/lib/metagraphed/types";
import {
  activityKindRail,
  categoryTotals,
  changeOver,
  closePoints,
  emissionColumns,
  emissionNeighbours,
  emissionRank,
  emissionTotals,
  domainPeers,
  surfaceRail,
  topValidator,
  trailing,
  uptimeBySurface,
  volumeOver,
  windowDays,
  withoutSubnetPrefix,
} from "./subnet-detail-logic";

const econ = (netuid: number, emission_share: number | undefined): SubnetEconomics => ({
  netuid,
  emission_share,
});

describe("windowDays", () => {
  it("maps every window to its day count", () => {
    expect([windowDays("7d"), windowDays("30d"), windowDays("90d")]).toEqual([7, 30, 90]);
  });
});

describe("emissionRank", () => {
  it("ranks by share, highest first", () => {
    const rows = [econ(1, 0.1), econ(2, 0.3), econ(3, 0.2)];
    expect(emissionRank(rows, 2)).toBe(1);
    expect(emissionRank(rows, 3)).toBe(2);
    expect(emissionRank(rows, 1)).toBe(3);
  });

  it("ranks a subnet with no share LAST rather than dropping it", () => {
    // The whole point: a subnet earning nothing is still on the list, and
    // excluding it would silently promote everyone below it by one.
    const rows = [econ(1, 0.1), econ(2, undefined), econ(3, 0.2)];
    expect(emissionRank(rows, 2)).toBe(3);
    expect(emissionRank(rows, 1)).toBe(2);
  });

  it("ties share the same rank", () => {
    expect(emissionRank([econ(1, 0.2), econ(2, 0.2)], 2)).toBe(1);
  });

  it("returns null for an unknown netuid and an empty list", () => {
    expect(emissionRank([econ(1, 0.2)], 99)).toBeNull();
    expect(emissionRank([], 1)).toBeNull();
  });
});

describe("changeOver", () => {
  it("measures first to last across the finite values", () => {
    expect(changeOver([10, null, 15])).toBeCloseTo(0.5);
  });

  it("refuses to divide by a zero baseline", () => {
    expect(changeOver([0, 5])).toBeNull();
    expect(changeOver([])).toBeNull();
  });
});

describe("closePoints", () => {
  const candles = [
    { bucket_start: 300, close: 3 },
    { bucket_start: 100, close: 1 },
    { bucket_start: 200, close: 2 },
  ];

  it("puts the newest-first API order back into time order", () => {
    expect(closePoints(candles, 10).map((p) => p.v)).toEqual([1, 2, 3]);
  });

  it("keeps the LAST n days, not the first", () => {
    expect(closePoints(candles, 2).map((p) => p.v)).toEqual([2, 3]);
  });

  it("drops candles with no close", () => {
    expect(closePoints([...candles, { bucket_start: 400 }], 10)).toHaveLength(3);
  });
});

describe("volumeOver", () => {
  it("sums the window and returns null when there is nothing to sum", () => {
    const candles = [
      { bucket_start: 1, volume_tao: 2 },
      { bucket_start: 2, volume_tao: 3 },
    ];
    expect(volumeOver(candles, 10)).toBe(5);
    expect(volumeOver(candles, 1)).toBe(3);
    expect(volumeOver([], 10)).toBeNull();
  });
});

describe("trailing", () => {
  it("sorts by day and keeps the tail", () => {
    const points = [{ snapshot_date: "2026-01-03" }, { snapshot_date: "2026-01-01" }];
    expect(trailing(points, 1)).toEqual([{ snapshot_date: "2026-01-03" }]);
  });
});

describe("emissionColumns", () => {
  const point = (over: Partial<EmissionSplitPoint>): EmissionSplitPoint => ({
    snapshot_date: "2026-08-01",
    owner_alpha: 1,
    validator_alpha: 6,
    miner_alpha: 3,
    burned_alpha: 0,
    ...over,
  });

  it("builds one column per day with four segments and a real total", () => {
    const [column] = emissionColumns([point({})]);
    expect(column?.total).toBe(10);
    expect(column?.segments.map((s) => s.key)).toEqual(["owner", "validators", "miners", "burned"]);
    expect(column?.axisLabel).toBe("08-01");
  });

  it("drops a day that measured nothing rather than drawing an empty column", () => {
    // An all-zero column reads as "this subnet paid nobody" -- a different
    // claim from "we have no reading for that day".
    expect(
      emissionColumns([
        point({ owner_alpha: 0, validator_alpha: 0, miner_alpha: 0, burned_alpha: 0 }),
      ]),
    ).toEqual([]);
  });

  it("treats a missing class as zero within a day that did measure", () => {
    const [column] = emissionColumns([point({ burned_alpha: null })]);
    expect(column?.segments.find((s) => s.key === "burned")?.value).toBe(0);
    expect(column?.total).toBe(10);
  });

  it("totals across days and shares them to one", () => {
    const totals = emissionTotals(
      emissionColumns([point({}), point({ snapshot_date: "2026-08-02" })]),
    );
    expect(totals[0]).toMatchObject({ key: "validators", value: 12 });
    expect(totals.reduce((acc, t) => acc + t.share, 0)).toBeCloseTo(1);
  });
});

describe("topValidator", () => {
  it("picks the largest stake and survives rows with none", () => {
    const best = topValidator([
      { uid: 1, stake_tao: 5 },
      { uid: 2 },
      { uid: 3, stake_tao: 9 },
    ] as never);
    expect(best?.uid).toBe(3);
    expect(topValidator([])).toBeNull();
  });
});

describe("surfaceRail / uptimeBySurface", () => {
  const surfaces = [
    { id: "a", name: "A", kind: "docs", url: "https://a.example", public_safe: true },
    { id: "b", name: "B", kind: "openapi", url: "https://b.example", public_safe: true },
    { id: "c", name: "C", kind: "sse", url: "https://c.example", public_safe: false },
    { id: "d", name: "D", kind: "sdk" },
  ] as never;

  it("converts probe ratios to percentages", () => {
    expect(uptimeBySurface([{ surface_id: "a", uptime_ratio: 0.5 }]).get("a")).toBe(50);
  });

  it("ignores a surface with no reading rather than recording zero", () => {
    expect(uptimeBySurface([{ surface_id: "a", uptime_ratio: null }]).size).toBe(0);
  });

  it("keeps an unprobed surface with a null value, ranked below the measured", () => {
    const rail = surfaceRail(surfaces, uptimeBySurface([{ surface_id: "a", uptime_ratio: 0.9 }]));
    expect(rail.map((row) => row.key)).toEqual(["a", "b"]);
    expect(rail[0]?.value).toBe(90);
    expect(rail[1]?.value).toBeNull();
  });

  it("never rails a surface that is not public-safe or has no URL", () => {
    const keys = surfaceRail(surfaces, new Map()).map((row) => row.key);
    expect(keys).not.toContain("c");
    expect(keys).not.toContain("d");
  });
});

describe("peers", () => {
  const rows = [econ(1, 0.5), econ(2, 0.4), econ(3, 0.3), econ(4, 0.2), econ(5, 0.1)];

  it("orders a domain's members by emission", () => {
    expect(domainPeers(rows, [3, 1], 10).map((r) => r.netuid)).toEqual([1, 3]);
  });

  it("centres the neighbour window on the subnet", () => {
    expect(emissionNeighbours(rows, 3, 3).map((r) => r.netuid)).toEqual([2, 3, 4]);
  });

  it("clamps the neighbour window at both ends of the ranking", () => {
    expect(emissionNeighbours(rows, 1, 3).map((r) => r.netuid)).toEqual([1, 2, 3]);
    expect(emissionNeighbours(rows, 5, 3).map((r) => r.netuid)).toEqual([3, 4, 5]);
  });

  it("falls back to the head of the ranking for an unknown netuid", () => {
    expect(emissionNeighbours(rows, 99, 2).map((r) => r.netuid)).toEqual([1, 2]);
  });
});

describe("activityKindRail", () => {
  const kinds = [
    { event_kind: "WeightsSet", category: "consensus", event_count: 10, hotkey_count: 3 },
    { event_kind: "TimelockedWeightsCommitted", category: "consensus", event_count: 30 },
    { event_kind: "StakeAdded", category: "stake", event_count: 5, coldkey_count: 9 },
    { event_kind: "Nothing", category: "stake", event_count: 0 },
  ];

  it("rails the kinds busiest first", () => {
    expect(activityKindRail(kinds).map((k) => k.key)).toEqual([
      "TimelockedWeightsCommitted",
      "WeightsSet",
      "StakeAdded",
    ]);
  });

  it("drops a kind that never fired rather than railing it at zero", () => {
    // An empty rail row claims the kind is possible here and idle, which is a
    // stronger statement than "it did not appear in this window".
    expect(activityKindRail(kinds).map((k) => k.key)).not.toContain("Nothing");
  });

  it("carries the actor counts into the tooltip", () => {
    const [, weights] = activityKindRail(kinds);
    expect(weights?.detail).toEqual([
      { key: "category", label: "Category", value: "consensus" },
      { key: "hotkeys", label: "Hotkeys", value: "3" },
      { key: "coldkeys", label: "Coldkeys", value: "0" },
    ]);
  });
});

describe("categoryTotals", () => {
  it("shares the categories to one, busiest first", () => {
    const totals = categoryTotals([
      { category: "stake", event_count: 25 },
      { category: "consensus", event_count: 75 },
      { category: "registration", event_count: 0 },
    ]);
    expect(totals.map((t) => t.key)).toEqual(["consensus", "stake"]);
    expect(totals[0]?.share).toBeCloseTo(0.75);
  });

  it("shares nothing when nothing happened", () => {
    expect(categoryTotals([])).toEqual([]);
  });
});

describe("withoutSubnetPrefix", () => {
  it("drops the subnet's own name from the front of a surface name", () => {
    expect(withoutSubnetPrefix("BlockMachine blocks API", "blockmachine")).toBe("blocks API");
  });

  it("eats the separator the prefix leaves behind", () => {
    expect(withoutSubnetPrefix("Apex: docs", "Apex")).toBe("docs");
    expect(withoutSubnetPrefix("Apex - docs", "Apex")).toBe("docs");
  });

  it("keeps the label when stripping would leave nothing", () => {
    expect(withoutSubnetPrefix("blockmachine", "blockmachine")).toBe("blockmachine");
  });

  it("leaves a label that does not start with the name, and needs a name to act", () => {
    expect(withoutSubnetPrefix("Grafana dashboard", "Apex")).toBe("Grafana dashboard");
    expect(withoutSubnetPrefix("Apex docs")).toBe("Apex docs");
  });
});
