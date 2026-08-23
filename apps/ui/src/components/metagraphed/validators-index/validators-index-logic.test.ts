import { describe, expect, it } from "vitest";
import type { GlobalValidator } from "@/lib/metagraphed/types";
import {
  concentration,
  filterOperators,
  fmtStake,
  median,
  operatorRows,
  shortKey,
  takeLabel,
} from "./validators-index-logic";

const validator = (over: Partial<GlobalValidator> & { hotkey: string }): GlobalValidator =>
  ({
    featured: false,
    coldkey: null,
    coldkey_identity: null,
    coldkey_count: 1,
    subnet_count: 1,
    uid_count: 1,
    take: null,
    total_stake_tao: 0,
    root_stake_tao: 0,
    alpha_stake_tao: 0,
    total_emission_tao: 0,
    nominator_count: null,
    apy_estimate: null,
    apy_estimate_eligible_subnet_count: 0,
    avg_validator_trust: null,
    max_validator_trust: null,
    stake_dominance: null,
    latest_captured_at: null,
    latest_block_number: null,
    subnets: [],
    ...over,
  }) as GlobalValidator;

const named = (name: string) =>
  ({
    has_identity: true,
    name,
    url: null,
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
    captured_at: null,
  }) as GlobalValidator["coldkey_identity"];

describe("operatorRows", () => {
  const rows = [
    validator({ hotkey: "5A", coldkey_identity: named("Yuma"), total_stake_tao: 100, take: 0.18 }),
    validator({ hotkey: "5B", coldkey_identity: named("Yuma"), total_stake_tao: 900, take: 0.09 }),
    validator({ hotkey: "5C", total_stake_tao: 500 }),
    validator({ hotkey: "5D", total_stake_tao: 50 }),
  ];

  it("sums an operator's keys and ranks operators by the sum", () => {
    const operators = operatorRows(rows);
    expect(operators.map((o) => o.key)).toEqual(["Yuma", "5C", "5D"]);
    expect(operators[0]).toMatchObject({ keyCount: 2, totalStakeTao: 1000, named: true });
  });

  it("anchors an operator on its LARGEST key, which is the one to link", () => {
    expect(operatorRows(rows)[0]?.primaryHotkey).toBe("5B");
  });

  it("keeps an anonymous key as its own operator of one", () => {
    // Two keys sharing nothing but their anonymity are not the same team, and
    // merging them would invent an operator that does not exist.
    const operators = operatorRows(rows);
    expect(operators.filter((o) => !o.named).map((o) => o.keyCount)).toEqual([1, 1]);
    expect(operators.find((o) => o.key === "5C")?.name).toBe("5C");
  });

  it("weights APY by stake, so a dust key cannot move the headline", () => {
    const weighted = operatorRows([
      validator({
        hotkey: "5A",
        coldkey_identity: named("Yuma"),
        total_stake_tao: 999,
        apy_estimate: 0.1,
      }),
      validator({
        hotkey: "5B",
        coldkey_identity: named("Yuma"),
        total_stake_tao: 1,
        apy_estimate: 10,
      }),
    ]);
    expect(weighted[0]?.apyEstimate).toBeCloseTo(0.1099, 3);
  });

  it("has no APY at all when no key estimated one", () => {
    expect(operatorRows([validator({ hotkey: "5A" })])[0]?.apyEstimate).toBeNull();
  });

  it("counts distinct subnets across keys, not the sum of per-key counts", () => {
    const overlapping = operatorRows([
      validator({
        hotkey: "5A",
        coldkey_identity: named("Yuma"),
        subnets: [{ netuid: 1 }, { netuid: 2 }] as GlobalValidator["subnets"],
      }),
      validator({
        hotkey: "5B",
        coldkey_identity: named("Yuma"),
        subnets: [{ netuid: 2 }, { netuid: 3 }] as GlobalValidator["subnets"],
      }),
    ]);
    expect(overlapping[0]?.subnetCount).toBe(3);
  });

  it("sums nominators only when at least one key reports them", () => {
    expect(operatorRows([validator({ hotkey: "5A" })])[0]?.nominators).toBeNull();
    expect(operatorRows([validator({ hotkey: "5A", nominator_count: 4 })])[0]?.nominators).toBe(4);
  });
});

describe("takeLabel", () => {
  it("states one value when the keys agree and a range when they do not", () => {
    expect(takeLabel(0.18, 0.18)).toBe("18.0%");
    expect(takeLabel(0.09, 0.18)).toBe("9.0%–18.0%");
    expect(takeLabel(null, null)).toBe("—");
  });
});

describe("median", () => {
  it("takes the middle, averages an even set, and refuses an empty one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    // Null, not 0: zero is a reading, and "no readings" is not.
    expect(median([])).toBeNull();
    expect(median([null, undefined, Number.NaN])).toBeNull();
  });
});

describe("concentration", () => {
  const operators = operatorRows(
    [1, 2, 3, 4].map((n) => validator({ hotkey: `5${n}`, total_stake_tao: n * 10 })),
  );

  it("collapses everything past the head into one residual", () => {
    const { segments } = concentration(operators, 2);
    expect(segments.map((s) => s.key)).toEqual(["54", "53", "rest"]);
    expect(segments[2]).toMatchObject({ label: "2 more operators", value: 30 });
  });

  it("totals the LISTED stake, which is not the network's", () => {
    expect(concentration(operators, 2).listedTotal).toBe(100);
  });

  it("emits no residual when the head is everything", () => {
    expect(concentration(operators, 10).segments.some((s) => s.key === "rest")).toBe(false);
  });
});

describe("filterOperators", () => {
  const operators = operatorRows([
    validator({
      hotkey: "5AAAAAAAAAAAAAAA",
      coldkey_identity: named("Yuma"),
      total_stake_tao: 5000,
    }),
    validator({ hotkey: "5BBBBBBBBBBBBBBB", total_stake_tao: 100 }),
  ]);

  it("ANDs the filters", () => {
    expect(filterOperators(operators, { minStake: 1000, namedOnly: true })).toHaveLength(1);
    expect(filterOperators(operators, { minStake: 10_000, namedOnly: true })).toHaveLength(0);
  });

  it("searches the operator name, its primary hotkey and every child key", () => {
    expect(filterOperators(operators, { q: "yuma" }).map((o) => o.key)).toEqual(["Yuma"]);
    expect(filterOperators(operators, { q: "5bbb" }).map((o) => o.key)).toEqual([
      "5BBBBBBBBBBBBBBB",
    ]);
  });

  it("passes everything through when nothing is filtered", () => {
    expect(filterOperators(operators, {})).toHaveLength(2);
  });
});

describe("presentation helpers", () => {
  it("compacts stake and truncates only long keys", () => {
    expect(fmtStake(1_914_956)).toBe("1.91M τ");
    expect(fmtStake(null)).toBe("—");
    expect(shortKey("5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9")).toBe("5GsbTg…pZX9");
    expect(shortKey("5Gsb")).toBe("5Gsb");
  });
});
