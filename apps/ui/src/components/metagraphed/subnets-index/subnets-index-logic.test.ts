import { describe, expect, it } from "vitest";
import { directoryHealthFilter } from "@/lib/metagraphed/subnet-health-filter";
import type {
  Subnet,
  SubnetEconomics,
  SubnetLifecycleEntry,
  SubnetMover,
} from "@/lib/metagraphed/types";
import {
  churnByDay,
  churnWindow,
  directoryRows,
  apiSpecStatus,
  filterDirectory,
  fmtAlpha,
  fmtPct,
  specSubnets,
  MOVERS_LIMIT,
  MOVERS_SORT,
  rankSubnets,
  resolveWindow,
  windowsFor,
  type DirectoryRow,
} from "./subnets-index-logic";

it("keeps legacy health links aligned with normalized directory rows", () => {
  const rows = [
    { netuid: 0, health: "warn" },
    { netuid: 19, health: "down" },
  ] as DirectoryRow[];
  expect(
    filterDirectory(rows, { health: directoryHealthFilter("degraded") }).map((r) => r.netuid),
  ).toEqual([0]);
  expect(
    filterDirectory(rows, { health: directoryHealthFilter("failed") }).map((r) => r.netuid),
  ).toEqual([19]);
  expect(directoryHealthFilter("unknown")).toBe("unknown");
  expect(directoryHealthFilter("future-state")).toBe("future-state");
  expect(directoryHealthFilter(null)).toBe("");
});

const mover = (over: Partial<SubnetMover> & { netuid: number }): SubnetMover => ({
  stake_start_alpha: 0,
  stake_end_alpha: 0,
  stake_delta_alpha: 0,
  stake_pct_change: null,
  stake_share_pct: null,
  emission_start_alpha: 0,
  emission_end_alpha: 0,
  emission_delta_alpha: 0,
  emission_pct_change: null,
  emission_share_pct: null,
  validators_start: 0,
  validators_end: 0,
  validators_delta: 0,
  neurons_start: 0,
  neurons_end: 0,
  neurons_delta: 0,
  ...over,
});

const name = (netuid: number) => `SN${netuid}`;
const noDomain = () => undefined;

describe("windowsFor / resolveWindow", () => {
  it("offers every window to the movers-backed metrics", () => {
    expect(windowsFor("stake").map((o) => o.value)).toEqual(["7d", "30d", "90d"]);
  });

  it("offers price only the two windows economics publishes a change for", () => {
    // A control offering a window the metric cannot serve is a control that
    // silently does nothing.
    expect(windowsFor("price").map((o) => o.value)).toEqual(["7d", "30d"]);
  });

  it("clamps a window the metric cannot serve to one it can", () => {
    expect(resolveWindow("price", "90d")).toBe("30d");
    expect(resolveWindow("price", "7d")).toBe("7d");
    expect(resolveWindow("stake", "90d")).toBe("90d");
  });
});

describe("rankSubnets", () => {
  const movers = [
    mover({ netuid: 1, stake_pct_change: 10, emission_pct_change: -2 }),
    mover({ netuid: 2, stake_pct_change: -5, emission_pct_change: 10 }),
  ];
  const econ: SubnetEconomics[] = [
    { netuid: 1, emission_share: 0.01, total_stake_alpha: 100, validator_count: 4 },
    { netuid: 2, emission_share: 0.03, total_stake_alpha: 300, validator_count: 9 },
    { netuid: 3, emission_share: 0.02, total_stake_alpha: 200, validator_count: 7 },
  ];

  it("ranks by the LEVEL, which economics carries for every subnet", () => {
    expect(
      rankSubnets("emission", "30d", movers, econ, name, noDomain).map((r) => r.netuid),
    ).toEqual([2, 3, 1]);
    expect(
      rankSubnets("validators", "30d", movers, econ, name, noDomain).map((r) => r.netuid),
    ).toEqual([2, 3, 1]);
  });

  it("takes the delta from movers and converts its percentage to a fraction", () => {
    const ranked = rankSubnets("emission", "30d", movers, econ, name, noDomain);
    expect(ranked.find((r) => r.netuid === 1)?.delta).toBeCloseTo(-0.02);
    expect(ranked.find((r) => r.netuid === 2)?.delta).toBeCloseTo(0.1);
  });

  it("keeps a subnet the movers slice omitted, with no delta", () => {
    // `/subnets/movers` serves at most 100 rows of 129 and ranks by CHANGE, so
    // ranking off it would quietly exclude a large subnet that did not move.
    const ranked = rankSubnets("emission", "30d", movers, econ, name, noDomain);
    expect(ranked.map((r) => r.netuid)).toContain(3);
    expect(ranked.find((r) => r.netuid === 3)?.delta).toBeUndefined();
  });

  it("calls a validator set that grew from nothing new", () => {
    const grown = [
      mover({ netuid: 1, validators_start: 0, validators_end: 4, validators_delta: 4 }),
    ];
    expect(rankSubnets("validators", "7d", grown, econ, name, noDomain)[0]?.delta).toBeUndefined();
    expect(
      rankSubnets("validators", "7d", grown, econ, name, noDomain).find((r) => r.netuid === 1)
        ?.delta,
    ).toBe("new");
  });

  it("ranks price by its CHANGE, since one subnet's alpha price is not another's", () => {
    // The change fields are PERCENTAGES on the wire (live range -100 … +334).
    const priced: SubnetEconomics[] = [
      { netuid: 1, alpha_price_tao: 0.5, alpha_price_change_7d: 2 },
      { netuid: 2, alpha_price_tao: 0.001, alpha_price_change_7d: 40 },
    ];
    const ranked = rankSubnets("price", "7d", [], priced, name, noDomain);
    expect(ranked.map((r) => r.netuid)).toEqual([2, 1]);
    expect(ranked[0]?.value).toBe("0.0010τ");
  });

  it("reads the 1-month field for the 30d window, as a fraction", () => {
    const priced: SubnetEconomics[] = [
      { netuid: 1, alpha_price_tao: 1, alpha_price_change_7d: 90, alpha_price_change_1m: 10 },
    ];
    // 10 on the wire is +10%, which every renderer here wants as 0.1. Getting
    // this wrong rendered a -2.3% median move as -230% (#11613).
    expect(rankSubnets("price", "30d", [], priced, name, noDomain)[0]?.delta).toBeCloseTo(0.1);
    expect(rankSubnets("price", "7d", [], priced, name, noDomain)[0]?.delta).toBeCloseTo(0.9);
  });

  it("drops a row the metric cannot value rather than sorting it in as zero", () => {
    const partial: SubnetEconomics[] = [
      { netuid: 1, alpha_price_tao: 1, alpha_price_change_7d: 10 },
      { netuid: 2, alpha_price_tao: 1 },
      { netuid: 3, alpha_price_change_7d: 50 },
    ];
    expect(rankSubnets("price", "7d", [], partial, name, noDomain).map((r) => r.netuid)).toEqual([
      1,
    ]);
    expect(rankSubnets("emission", "7d", [], partial, name, noDomain)).toEqual([]);
  });

  it("does not invent a stake ranking from incomparable quantities or a capped movers slice", () => {
    const assets: SubnetEconomics[] = [
      { netuid: 0, total_stake_alpha: 1_000_000, alpha_price_tao: 1 },
      { netuid: 1, total_stake_alpha: 10, alpha_price_tao: 100 },
      { netuid: 2, total_stake_alpha: 100, alpha_price_tao: 0.01 },
      { netuid: 3, total_stake_alpha: 1_000 },
    ];
    expect(rankSubnets("stake", "30d", movers, assets, name, noDomain)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(rankSubnets("emission", "30d", movers, econ, name, noDomain, 2)).toHaveLength(2);
  });

  it("maps every non-price metric onto a sort the endpoint accepts", () => {
    // The endpoint rejects anything else with a 400, and rejects a limit
    // above 100 -- both measured live 2026-08-23.
    expect(Object.values(MOVERS_SORT).sort()).toEqual(["emission", "stake", "validators"]);
    expect(MOVERS_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe("churnByDay / churnWindow", () => {
  const entries: SubnetLifecycleEntry[] = [
    {
      netuid: 1,
      event: "registered",
      block_number: 1,
      observed_at: "2026-08-10T01:00:00Z",
      predates_capture: false,
    },
    {
      netuid: 2,
      event: "registered",
      block_number: 2,
      observed_at: "2026-08-10T09:00:00Z",
      predates_capture: false,
    },
    {
      netuid: 3,
      event: "deregistered",
      block_number: 3,
      observed_at: "2026-08-11T01:00:00Z",
      predates_capture: false,
    },
    {
      netuid: 4,
      event: "something-else",
      block_number: 4,
      observed_at: "2026-08-12T01:00:00Z",
      predates_capture: false,
    },
    { netuid: 5, event: "registered", block_number: 5, observed_at: null, predates_capture: false },
  ];

  it("buckets by day with both series present on every column", () => {
    const columns = churnByDay(entries);
    expect(columns.map((c) => c.key)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(columns[0]?.segments).toEqual([
      { key: "registered", label: "Registered", value: 2 },
      { key: "deregistered", label: "Deregistered", value: 0 },
    ]);
    expect(columns[0]?.axisLabel).toBe("08-10");
  });

  it("ignores an event that is neither a registration nor a deregistration", () => {
    expect(churnByDay(entries).some((c) => c.key === "2026-08-12")).toBe(false);
  });

  it("ignores an entry with no timestamp rather than bucketing it as today", () => {
    expect(churnByDay(entries).reduce((acc, c) => acc + c.total, 0)).toBe(3);
  });

  it("reports the captured window, and nothing when there is no capture", () => {
    expect(churnWindow(entries)).toEqual(["2026-08-10", "2026-08-12"]);
    expect(churnWindow([])).toBeNull();
  });
});

describe("directoryRows", () => {
  const subnets = [
    { netuid: 1, name: "Apex" },
    { netuid: 2, name: "Beta" },
  ] as Subnet[];
  const econ: SubnetEconomics[] = [
    { netuid: 1, emission_share: 0.5, alpha_price_tao: 2, total_stake_alpha: 10 },
  ];

  it("left-joins: a subnet economics has not priced still gets a row", () => {
    const rows = directoryRows(subnets, econ, () => undefined);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.alpha_price_tao).toBeUndefined();
    expect(rows[0]).not.toHaveProperty("total_stake_alpha");
  });

  it("keeps the Root row while withholding its ambiguous legacy stake aggregate", () => {
    const rows = directoryRows(
      [{ netuid: 0, name: "Root" }] as Subnet[],
      [{ netuid: 0, total_stake_alpha: 6_420_000, alpha_price_tao: 1 }],
      () => undefined,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("total_stake_alpha");
    expect(rows[0]?.name).toBe("Root");
  });

  it("does not publish weighted stake as native holdings for any subnet or partial snapshot", () => {
    const assets: SubnetEconomics[] = [
      { netuid: 1, total_stake_alpha: 10, alpha_price_tao: 100 },
      { netuid: 2, total_stake_alpha: 100, alpha_price_tao: 0.01 },
      { netuid: 3, total_stake_alpha: 0 },
      { netuid: 4, total_stake_alpha: 9_007_199_254_740_991 },
      { netuid: 5 },
    ];
    const rows = directoryRows(
      assets.map(({ netuid }) => ({ netuid }) as Subnet),
      assets,
      () => undefined,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).not.toHaveProperty("total_stake_alpha");
    expect(rows.map((row) => row.alpha_price_tao)).toEqual([
      100,
      0.01,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("normalises the price change from a percentage to a fraction at the join", () => {
    const rows = directoryRows(
      subnets,
      [{ netuid: 1, alpha_price_change_7d: -2.3 }],
      () => undefined,
    );
    expect(rows[0]?.alpha_price_change_7d).toBeCloseTo(-0.023);
  });

  it("carries the domain in from the taxonomy", () => {
    const rows = directoryRows(subnets, econ, (n) => (n === 1 ? "inference" : undefined));
    expect(rows[0]?.domain).toBe("inference");
    expect(rows[1]?.domain).toBeUndefined();
  });
});

describe("filterDirectory", () => {
  const rows = directoryRows(
    [
      { netuid: 1, name: "Apex", health: "ok" },
      { netuid: 2, name: "Beta", health: "down" },
      { netuid: 34, name: "BitMind", health: "ok" },
    ] as Subnet[],
    [],
    (n) => (n === 1 ? "inference" : "agents"),
  );

  it("ANDs every filter", () => {
    expect(filterDirectory(rows, { domain: "agents", health: "ok" }).map((r) => r.netuid)).toEqual([
      34,
    ]);
  });

  it("matches the query against name and netuid", () => {
    expect(filterDirectory(rows, { q: "bit" }).map((r) => r.netuid)).toEqual([34]);
    expect(filterDirectory(rows, { q: "34" }).map((r) => r.netuid)).toEqual([34]);
  });

  it("passes everything through when nothing is filtered", () => {
    expect(filterDirectory(rows, {})).toHaveLength(3);
  });

  it("takes the API filter from the catalog set, which is the only source that knows", () => {
    // The registry list row carries a surface COUNT and no interface kinds, so
    // deriving this from the row returned false for all 129 subnets.
    expect(
      filterDirectory(rows, { api: true, withApi: new Set([1, 34]) }).map((r) => r.netuid),
    ).toEqual([1, 34]);
  });

  it("matches nothing when the API filter is on and the catalog is missing", () => {
    // Better than matching everything: an unanswerable filter must narrow to
    // nothing visibly, not silently pass the whole list through.
    expect(filterDirectory(rows, { api: true })).toEqual([]);
  });
});

describe("specSubnets", () => {
  it("selects only the netuids publishing a machine-readable contract", () => {
    const set = specSubnets({
      1: { service_kinds: ["openapi", "docs"] },
      2: { service_kinds: ["dashboard"] },
      3: { service_kinds: null },
      4: {},
    });
    expect([...set]).toEqual([1]);
  });

  it("is empty for an empty catalog, not everything", () => {
    expect(specSubnets({}).size).toBe(0);
  });
});

describe("formatters", () => {
  it("compacts alpha at each magnitude and refuses a non-number", () => {
    expect(fmtAlpha(2_691_628)).toBe("2.69M");
    expect(fmtAlpha(2_500)).toBe("2.5k");
    expect(fmtAlpha(2.5)).toBe("2.50");
    expect(fmtAlpha(null)).toBe("—");
    expect(fmtAlpha(Number.NaN)).toBe("—");
  });

  it("renders a fraction as a percentage and a dash for nothing", () => {
    expect(fmtPct(0.00821)).toBe("0.82%");
    expect(fmtPct(0.5, 1)).toBe("50.0%");
    expect(fmtPct(undefined)).toBe("—");
  });
});

describe("API specification evidence", () => {
  it("distinguishes an explicit absence from missing or blocked coverage", () => {
    expect(apiSpecStatus({ service_kinds: ["openapi"] })).toBe("yes");
    expect(apiSpecStatus({ service_kinds: ["dashboard"] })).toBe("no");
    expect(apiSpecStatus({ service_kinds: [] })).toBe("no");
    expect(apiSpecStatus({ service_count: 0 })).toBe("no");
    expect(apiSpecStatus({ service_count: 2 })).toBe("unknown");
    expect(apiSpecStatus({ service_kinds: null })).toBe("unknown");
    expect(apiSpecStatus()).toBe("unknown");
  });
});
