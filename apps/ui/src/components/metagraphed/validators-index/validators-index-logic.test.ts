import { describe, expect, it } from "vitest";
import type { GlobalValidator } from "@/lib/metagraphed/types";
import {
  concentration,
  filterOperators,
  fmtStake,
  hotkeyColor,
  hotkeyComposition,
  median,
  operatorRows,
  shortKey,
  takeLabel,
} from "./validators-index-logic";
import {
  deserializeOperatorRows,
  serializeOperatorRows,
  type SerializedOperatorRow,
} from "@/lib/metagraphed/validator-operators";

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
    validator({
      hotkey: "5A",
      coldkey: "owner-a",
      coldkey_identity: named("Yuma"),
      total_stake_tao: 100,
      take: 0.18,
    }),
    validator({
      hotkey: "5B",
      coldkey: "owner-a",
      coldkey_identity: named("Yuma"),
      total_stake_tao: 900,
      take: 0.09,
    }),
    validator({ hotkey: "5C", total_stake_tao: 500 }),
    validator({ hotkey: "5D", total_stake_tao: 50 }),
  ];

  it("sums an operator's keys and ranks operators by the sum", () => {
    const operators = operatorRows(rows);
    expect(operators.map((o) => o.key)).toEqual(["coldkey:owner-a", "hotkey:5C", "hotkey:5D"]);
    expect(operators[0]).toMatchObject({ keyCount: 2, totalStakeTao: 1000, named: true });
  });

  it("anchors an operator on its LARGEST key, which is the one to link", () => {
    expect(operatorRows(rows)[0]?.primaryHotkey).toBe("5B");
  });

  it("retains only the child-key fields the expanded directory renders", () => {
    expect(operatorRows(rows)[0]?.keys[0]).toEqual({
      hotkey: "5B",
      totalStakeTao: 900,
      take: 0.09,
    });
  });

  it("round-trips the field-name-free SSR tuple without losing directory data", () => {
    const operators = operatorRows(rows);
    const serialized = serializeOperatorRows(operators);
    expect(Array.isArray(serialized[0])).toBe(true);
    expect(deserializeOperatorRows(serialized)).toEqual(operators);
  });

  it("keeps equal-name owners separate through grouping and SSR serialization", () => {
    const operators = operatorRows([
      validator({ hotkey: "first", coldkey: "owner-a", coldkey_identity: named("Shared Name") }),
      validator({ hotkey: "second", coldkey: "owner-b", coldkey_identity: named("Shared Name") }),
      validator({ hotkey: "third", coldkey_identity: named("Shared Name") }),
      validator({ hotkey: "fourth", coldkey_identity: named("Shared Name") }),
    ]);
    const restored = deserializeOperatorRows(serializeOperatorRows(operators));
    expect(restored).toEqual(operators);
    expect(restored).toHaveLength(4);
    expect(new Set(restored.map((row) => row.key)).size).toBe(4);
    expect(restored.every((row) => row.name === "Shared Name")).toBe(true);
  });

  it("keeps owner identity stable through names and primary-key changes", () => {
    const before = operatorRows([
      validator({
        hotkey: "first",
        coldkey: "owner",
        coldkey_identity: named("Old Name"),
        total_stake_tao: 2,
      }),
      validator({ hotkey: "second", coldkey: "owner", total_stake_tao: 1 }),
    ])[0]!;
    const after = operatorRows([
      validator({ hotkey: "first", coldkey: "owner", total_stake_tao: 1 }),
      validator({
        hotkey: "second",
        coldkey: "owner",
        coldkey_identity: named("New Name"),
        total_stake_tao: 2,
      }),
    ])[0]!;
    expect(after.key).toBe(before.key);
    expect(after.name).toBe("New Name");
    expect(after.primaryHotkey).toBe("second");
    expect(deserializeOperatorRows(serializeOperatorRows([after]))[0]).toEqual(after);
  });

  it("keeps ambiguous and missing ownership separate and orders ties deterministically", () => {
    const rows = [
      validator({ hotkey: "second", coldkey: "owner" }),
      validator({ hotkey: "first", coldkey: "owner" }),
      validator({ hotkey: "ambiguous", coldkey: "owner", coldkey_count: 2 }),
      validator({ hotkey: "unknown", coldkey: "owner", coldkey_count: undefined }),
    ];
    const forward = operatorRows(rows);
    expect(operatorRows([...rows].reverse())).toEqual(forward);
    expect(forward.map((row) => row.key)).toEqual([
      "hotkey:ambiguous",
      "coldkey:owner",
      "hotkey:unknown",
    ]);
    expect(forward[1]!.keys.map((row) => row.hotkey)).toEqual(["first", "second"]);
  });

  it("reads older SSR tuples without treating their labels as row identity", () => {
    const tuples: SerializedOperatorRow[] = [
      ["Shared Name", [], "first", "owner-a", 1, 0, 0, 1, 1, null, null],
      ["Shared Name", [], "second", "owner-b", 1, 0, 4, 1, 1, null, null],
    ];
    const rows = deserializeOperatorRows(tuples);
    expect(rows.map((row) => row.key)).toEqual(["hotkey:first", "hotkey:second"]);
    expect(rows.map((row) => row.name)).toEqual(["Shared Name", "Shared Name"]);
    expect(rows.map((row) => row.nominators)).toEqual([0, 4]);
  });

  it.each([
    [3, 3],
    [3, null],
    [null, 3],
    [0, 0],
  ])("does not sum member nominator counts %s and %s", (first, second) => {
    const rows = operatorRows([
      validator({ hotkey: "first", coldkey: "owner", nominator_count: first }),
      validator({ hotkey: "second", coldkey: "owner", nominator_count: second }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nominators).toBeNull();
    const legacy = serializeOperatorRows(rows)[0]!;
    legacy[6] = 6;
    expect(deserializeOperatorRows([legacy])[0]!.nominators).toBeNull();
  });

  it("keeps opaque future IDs while compacting IDs derived from existing addresses", () => {
    const rows = operatorRows([
      validator({ hotkey: "known", coldkey: "owner" }),
      validator({ hotkey: "unknown" }),
    ]);
    const compact = serializeOperatorRows(rows);
    expect(compact[0]?.[11]).toBe(1);
    expect(compact[1]).toHaveLength(11);
    rows[0]!.key = "operator:future-id";
    expect(deserializeOperatorRows(serializeOperatorRows(rows))).toEqual(rows);
  });

  it("compacts display precision and reconstructs take ranges from child keys", () => {
    const operators = operatorRows([
      validator({
        hotkey: "5A",
        coldkey: "owner-a",
        coldkey_identity: named("Yuma"),
        total_stake_tao: 100.123456789,
        total_emission_tao: 1.23456789,
        take: 0.123456789,
        apy_estimate: 0.987654321,
      }),
      validator({
        hotkey: "5B",
        coldkey: "owner-a",
        coldkey_identity: named("Yuma"),
        total_stake_tao: 10.987654321,
        total_emission_tao: 0.123456789,
        take: 0.012345678,
        apy_estimate: 0.123456789,
      }),
      validator({
        hotkey: "5C",
        total_stake_tao: 5.555555555,
        take: 0.177777777,
      }),
    ]);
    const serialized = serializeOperatorRows(operators);

    expect(serialized.map((row) => row.length)).toEqual([12, 11]);
    expect(serialized[0]?.[11]).toBe(1);
    expect(serialized[0]?.[1]).toEqual([
      ["5A", 100.12346, 0.123457],
      ["5B", 10.98765, 0.012346],
    ]);
    expect(serialized[0]?.[9]).toBeNull();
    expect(serialized[1]?.[1]).toEqual([]);
    expect(serialized[1]?.[9]).toBe(0.177778);

    const restored = deserializeOperatorRows(serialized);
    expect(restored[0]).toMatchObject({
      totalStakeTao: 111.11111,
      totalEmissionTao: 1.35802,
      takeMin: 0.012346,
      takeMax: 0.123457,
    });
    expect(restored[1]).toMatchObject({
      keys: [{ hotkey: "5C", totalStakeTao: 5.55556, take: 0.177778 }],
      takeMin: 0.177778,
      takeMax: 0.177778,
    });
  });

  it("keeps an anonymous key as its own operator of one", () => {
    // Two keys sharing nothing but their anonymity are not the same team, and
    // merging them would invent an operator that does not exist.
    const operators = operatorRows(rows);
    expect(operators.filter((o) => !o.named).map((o) => o.keyCount)).toEqual([1, 1]);
    expect(operators.find((o) => o.key === "hotkey:5C")?.name).toBe("5C");
  });

  it("weights APY by stake, so a dust key cannot move the headline", () => {
    const weighted = operatorRows([
      validator({
        hotkey: "5A",
        coldkey: "owner-a",
        coldkey_identity: named("Yuma"),
        total_stake_tao: 999,
        apy_estimate: 0.1,
      }),
      validator({
        hotkey: "5B",
        coldkey: "owner-a",
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

  // This used to assert that the count DEDUPED netuids across an operator's
  // keys -- and it passed, on rows built with a populated `subnets` array. The
  // page asks for `subnets: false` (#11315), so every row it actually receives
  // has `subnets: []`, and the column read 0 for all 604 operators from the day
  // that landed. The test proved the function worked on data the app never
  // gives it (#11695).
  it("counts memberships off the scalar that survives the projection", () => {
    const rows = operatorRows([
      validator({
        hotkey: "5A",
        coldkey: "owner-a",
        coldkey_identity: named("Yuma"),
        subnet_count: 2,
        subnets: [],
      }),
      validator({
        hotkey: "5B",
        coldkey: "owner-a",
        coldkey_identity: named("Yuma"),
        subnet_count: 3,
        subnets: [],
      }),
    ]);
    expect(rows[0]?.memberships).toBe(5);
  });

  it("still counts when the per-subnet array has been projected away", () => {
    // The exact shape `/validators` receives: no `subnets`, a real
    // `subnet_count`. A zero here is the defect returning.
    expect(
      operatorRows([validator({ hotkey: "5A", subnet_count: 7, subnets: [] })])[0]?.memberships,
    ).toBe(7);
  });

  it("preserves available singleton nominator counts", () => {
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
    expect(segments.map((s) => s.key)).toEqual(["hotkey:54", "hotkey:53", "rest"]);
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
      coldkey: "owner-a",
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
    expect(filterOperators(operators, { q: "yuma" }).map((o) => o.key)).toEqual([
      "coldkey:owner-a",
    ]);
    expect(filterOperators(operators, { q: "5bbb" }).map((o) => o.key)).toEqual([
      "hotkey:5BBBBBBBBBBBBBBB",
    ]);
  });

  it("passes everything through when nothing is filtered", () => {
    expect(filterOperators(operators, {})).toHaveLength(2);
  });
});

describe("hotkeyComposition", () => {
  const keys = [
    { hotkey: "5A", totalStakeTao: 10, take: null },
    { hotkey: "5B", totalStakeTao: 70, take: null },
    { hotkey: "5C", totalStakeTao: 15, take: null },
    { hotkey: "5D", totalStakeTao: 5, take: null },
  ];

  it("preserves the total and positions the real tail after the largest keys", () => {
    const segments = hotkeyComposition(keys, 2);
    expect(
      segments.map(({ key, value, share, offset }) => ({ key, value, share, offset })),
    ).toEqual([
      { key: "5B", value: 70, share: 0.7, offset: 0 },
      { key: "5C", value: 15, share: 0.15, offset: 0.7 },
      { key: "rest", value: 15, share: 0.15, offset: 0.85 },
    ]);
    expect(segments.at(-1)?.label).toBe("2 more hotkeys");
    expect(segments.reduce((total, segment) => total + segment.share, 0)).toBeCloseTo(1);
    expect(keys.map((key) => key.hotkey)).toEqual(["5A", "5B", "5C", "5D"]);
  });

  it("keeps key colors stable when the stake ranking changes", () => {
    const original = hotkeyComposition(keys);
    const reordered = hotkeyComposition(
      keys.map((key) => ({ ...key, totalStakeTao: key.hotkey === "5A" ? 100 : key.totalStakeTao })),
    );
    for (const segment of original) {
      expect(reordered.find((key) => key.key === segment.key)?.color).toBe(segment.color);
      expect(segment.color).toBe(hotkeyColor(segment.key));
      expect(segment.color).toMatch(/^var\(--chart-\d+\)$/);
    }
  });

  it("does not turn missing, zero or negative stake into colored holdings", () => {
    const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((totalStakeTao, index) => ({
      hotkey: `invalid-${index}`,
      totalStakeTao,
      take: null,
    }));
    expect(hotkeyComposition(invalid)).toEqual([]);
    expect(hotkeyComposition([...invalid, keys[0]!])).toMatchObject([
      { key: "5A", value: 10, share: 1, offset: 0 },
    ]);
  });
});

describe("presentation helpers", () => {
  it("compacts stake and truncates only long keys", () => {
    expect(fmtStake(1_914_956)).toBe("1.91Mτ");
    expect(fmtStake(null)).toBe("—");
    expect(shortKey("5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9")).toBe("5GsbTg…pZX9");
    expect(shortKey("5Gsb")).toBe("5Gsb");
  });
});
