import { describe, expect, it } from "vitest";
import {
  emissionPipelineCounts,
  emissionRowState,
  filterEmissionSubnets,
  gateDirection,
  ineligibleReasonLabel,
  isEmissionSortKey,
  measuredFields,
  networkTaoSplit,
  sortEmissionSubnets,
  taoChannelMix,
} from "./emission-pipeline";
import type { EmissionPipeline, EmissionPipelineSubnet } from "./types";

function subnet(overrides: Partial<EmissionPipelineSubnet> = {}): EmissionPipelineSubnet {
  return {
    netuid: 1,
    ineligible_reason: null,
    emission_share: 0.01,
    miner_burned: 0,
    weighted_share: 0.01,
    gated_share: 0.01,
    emission_enabled: true,
    final_share: 0.01,
    gate_delta: 0,
    distance_to_bar: 1,
    tao_in_emission: 0.001,
    excess_tao: 0.002,
    tao_total: 0.003,
    liquidity_fraction: 0.33,
    alpha_in_emission: 0.1,
    alpha_out_emission: 1,
    ...overrides,
  };
}

function pipeline(overrides: Partial<EmissionPipeline> = {}): EmissionPipeline {
  return {
    schema_version: 1,
    chain_state: {
      block: 8_754_718,
      block_hash: "0xabc",
      emission_bar_quantile: 0.75,
      emission_gate_bar: 0.009,
      emission_gate_exponent: null,
      total_issuance_tao: 11_188_981,
    },
    block_emission_tao: 0.5,
    block_emission_halvings: 1,
    subnets: [],
    aggregate: {
      eligible_count: 127,
      disabled_count: 44,
      tao_in_emission: 0.1641,
      excess_tao: 0.3359,
      tao_total: 0.5,
      liquidity_fraction: 0.3282,
      total_final_share: 1,
    },
    verification: {
      verified: true,
      checks: [],
      subnet_share_tolerance: 0.0002,
      aggregate_tolerance_rao: "1000",
    },
    field_sources: {},
    ...overrides,
  };
}

describe("emissionRowState", () => {
  it("treats enabled-and-eligible as eligible", () => {
    expect(emissionRowState(subnet())).toBe("eligible");
  });

  it("treats a switched-off subnet as disabled", () => {
    expect(emissionRowState(subnet({ emission_enabled: false }))).toBe("disabled");
  });

  // Root is the case that makes the two axes provably independent: it is
  // emission_enabled AND outside the pipeline. Reporting it as "eligible"
  // would put a subnet with a null final share in the ranked set.
  it("treats root as ineligible even though it is emission-enabled", () => {
    const root = subnet({
      netuid: 0,
      ineligible_reason: "root",
      emission_enabled: true,
      final_share: null,
    });
    expect(emissionRowState(root)).toBe("ineligible");
  });

  it("treats a subnet that is both disabled and ineligible as ineligible", () => {
    const both = subnet({
      netuid: 86,
      ineligible_reason: "never_emitted",
      emission_enabled: false,
      final_share: null,
    });
    expect(emissionRowState(both)).toBe("ineligible");
  });
});

describe("ineligibleReasonLabel", () => {
  it("spells out the reasons the chain actually uses", () => {
    expect(ineligibleReasonLabel("root")).toMatch(/Root/);
    expect(ineligibleReasonLabel("never_emitted")).toBe("Never emitted");
  });

  it("falls back to the raw code so an unknown reason is still visible", () => {
    expect(ineligibleReasonLabel("some_new_reason")).toBe("some_new_reason");
  });
});

describe("gateDirection", () => {
  it("reports the direction of the pipeline's effect", () => {
    expect(gateDirection(subnet({ gate_delta: 0.025 }))).toBe("gained");
    expect(gateDirection(subnet({ gate_delta: -0.003 }))).toBe("lost");
    expect(gateDirection(subnet({ gate_delta: 0 }))).toBe("unchanged");
  });

  it("reports unknown rather than unchanged when there is no delta", () => {
    expect(gateDirection(subnet({ gate_delta: null }))).toBe("unknown");
  });

  // Floating-point dust must not be dressed up as a directional finding.
  it("treats sub-epsilon dust as unchanged", () => {
    expect(gateDirection(subnet({ gate_delta: 1e-15 }))).toBe("unchanged");
    expect(gateDirection(subnet({ gate_delta: -1e-15 }))).toBe("unchanged");
  });
});

describe("emissionPipelineCounts", () => {
  // The disagreement this function exists for. aggregate.disabled_count is 44
  // at block 8,754,718 while 45 rows carry emission_enabled: false, because
  // one of them is also ineligible and the aggregate classifies it there. The
  // row-derived count must match what a reader can count in the table.
  it("counts states from the rows, so the table cannot contradict the headline", () => {
    const rows = [
      subnet({ netuid: 0, ineligible_reason: "root", emission_enabled: true }),
      subnet({ netuid: 86, ineligible_reason: "never_emitted", emission_enabled: false }),
      subnet({ netuid: 1, emission_enabled: false }),
      subnet({ netuid: 2, emission_enabled: true }),
    ];
    const counts = emissionPipelineCounts(rows);
    expect(counts.total).toBe(4);
    expect(counts.eligible).toBe(1);
    expect(counts.disabled).toBe(1);
    expect(counts.ineligible).toBe(2);
  });

  it("separates a gate-zeroed subnet from a switched-off one", () => {
    const rows = [
      subnet({ netuid: 1, emission_enabled: true, gated_share: 0 }),
      subnet({ netuid: 2, emission_enabled: false, gated_share: 0 }),
    ];
    const counts = emissionPipelineCounts(rows);
    expect(counts.gatedToZero).toBe(1);
    expect(counts.disabled).toBe(1);
  });

  it("tallies gate direction across the set", () => {
    const rows = [
      subnet({ netuid: 1, gate_delta: 0.01 }),
      subnet({ netuid: 2, gate_delta: -0.01 }),
      subnet({ netuid: 3, gate_delta: -0.02 }),
      subnet({ netuid: 4, gate_delta: null }),
    ];
    const counts = emissionPipelineCounts(rows);
    expect(counts.gained).toBe(1);
    expect(counts.lost).toBe(2);
  });

  it("handles an empty payload without inventing rows", () => {
    expect(emissionPipelineCounts([])).toMatchObject({
      total: 0,
      eligible: 0,
      disabled: 0,
      ineligible: 0,
    });
  });
});

describe("taoChannelMix", () => {
  it("names the channel a subnet's TAO arrives through", () => {
    expect(taoChannelMix(subnet({ tao_in_emission: 0.1, excess_tao: 0.2 }))).toBe("both");
    expect(taoChannelMix(subnet({ tao_in_emission: 0.1, excess_tao: 0 }))).toBe("pool-only");
    expect(taoChannelMix(subnet({ tao_in_emission: 0, excess_tao: 0 }))).toBe("none");
  });

  // The presentation rule from the issue: this is a subnet RECEIVING TAO, and
  // must never render as "receiving nothing" just because the pool channel is
  // zero. No subnet was in this state at the block this was built against, so
  // the test is the only thing keeping the branch honest.
  it("reports chain-buys-only as a receiving state, not an empty one", () => {
    expect(taoChannelMix(subnet({ tao_in_emission: 0, excess_tao: 0.002 }))).toBe(
      "chain-buys-only",
    );
  });

  it("treats missing channels as zero rather than throwing", () => {
    expect(taoChannelMix(subnet({ tao_in_emission: null, excess_tao: null }))).toBe("none");
  });
});

describe("sortEmissionSubnets", () => {
  it("sorts by the requested key in both directions", () => {
    const rows = [
      subnet({ netuid: 1, final_share: 0.01 }),
      subnet({ netuid: 2, final_share: 0.1 }),
      subnet({ netuid: 3, final_share: 0.05 }),
    ];
    expect(sortEmissionSubnets(rows, "final_share", "desc").map((s) => s.netuid)).toEqual([
      2, 3, 1,
    ]);
    expect(sortEmissionSubnets(rows, "final_share", "asc").map((s) => s.netuid)).toEqual([1, 3, 2]);
  });

  // A null final_share means "not in the pipeline", not "smallest". Floating
  // root to the top of an ascending sort would put a non-answer where the
  // reader is looking for the smallest real value.
  it("sorts nulls last in BOTH directions", () => {
    const rows = [
      subnet({ netuid: 0, final_share: null }),
      subnet({ netuid: 1, final_share: 0.01 }),
      subnet({ netuid: 2, final_share: 0.1 }),
    ];
    expect(sortEmissionSubnets(rows, "final_share", "asc").map((s) => s.netuid)).toEqual([1, 2, 0]);
    expect(sortEmissionSubnets(rows, "final_share", "desc").map((s) => s.netuid)).toEqual([
      2, 1, 0,
    ]);
  });

  it("breaks ties on netuid so the order is stable", () => {
    const rows = [
      subnet({ netuid: 9, final_share: 0.01 }),
      subnet({ netuid: 3, final_share: 0.01 }),
      subnet({ netuid: 5, final_share: 0.01 }),
    ];
    expect(sortEmissionSubnets(rows, "final_share", "desc").map((s) => s.netuid)).toEqual([
      3, 5, 9,
    ]);
  });

  it("does not mutate the input array", () => {
    const rows = [subnet({ netuid: 2, final_share: 0.1 }), subnet({ netuid: 1, final_share: 0.2 })];
    sortEmissionSubnets(rows, "final_share", "desc");
    expect(rows.map((s) => s.netuid)).toEqual([2, 1]);
  });

  it("orders all-null rows by netuid", () => {
    const rows = [subnet({ netuid: 7, gate_delta: null }), subnet({ netuid: 2, gate_delta: null })];
    expect(sortEmissionSubnets(rows, "gate_delta", "desc").map((s) => s.netuid)).toEqual([2, 7]);
  });
});

describe("isEmissionSortKey", () => {
  it("accepts a served key and rejects anything else", () => {
    expect(isEmissionSortKey("final_share")).toBe(true);
    expect(isEmissionSortKey("liquidity_fraction")).toBe(true);
    expect(isEmissionSortKey("emission_enabled")).toBe(false);
    expect(isEmissionSortKey(undefined)).toBe(false);
  });
});

describe("filterEmissionSubnets", () => {
  const rows = [
    subnet({ netuid: 1, emission_enabled: true }),
    subnet({ netuid: 12, emission_enabled: false }),
    subnet({ netuid: 21, ineligible_reason: "root" }),
  ];

  it("filters by state", () => {
    expect(filterEmissionSubnets(rows, "disabled", "").map((s) => s.netuid)).toEqual([12]);
    expect(filterEmissionSubnets(rows, "ineligible", "").map((s) => s.netuid)).toEqual([21]);
    expect(filterEmissionSubnets(rows, "all", "")).toHaveLength(3);
  });

  it("matches a netuid substring, so typing 1 finds 1, 12 and 21", () => {
    expect(filterEmissionSubnets(rows, "all", "1").map((s) => s.netuid)).toEqual([1, 12, 21]);
    expect(filterEmissionSubnets(rows, "all", "12").map((s) => s.netuid)).toEqual([12]);
  });

  it("ignores surrounding whitespace and an empty query", () => {
    expect(filterEmissionSubnets(rows, "all", "   ")).toHaveLength(3);
    expect(filterEmissionSubnets(rows, "all", " 12 ").map((s) => s.netuid)).toEqual([12]);
  });

  it("combines state and query", () => {
    expect(filterEmissionSubnets(rows, "eligible", "1").map((s) => s.netuid)).toEqual([1]);
  });
});

describe("networkTaoSplit", () => {
  it("prefers the served liquidity fraction", () => {
    const split = networkTaoSplit(pipeline());
    expect(split.poolFraction).toBeCloseTo(0.3282, 4);
    expect(split.buysFraction).toBeCloseTo(0.6718, 4);
  });

  it("recomputes from the two channels when the fraction is absent", () => {
    const split = networkTaoSplit(
      pipeline({
        aggregate: {
          eligible_count: null,
          disabled_count: null,
          tao_in_emission: 1,
          excess_tao: 3,
          tao_total: 4,
          liquidity_fraction: null,
          total_final_share: null,
        },
      }),
    );
    expect(split.poolFraction).toBe(0.25);
    expect(split.buysFraction).toBe(0.75);
  });

  it("reports nothing rather than 0/0 when neither source is usable", () => {
    const empty = {
      eligible_count: null,
      disabled_count: null,
      tao_in_emission: null,
      excess_tao: null,
      tao_total: null,
      liquidity_fraction: null,
      total_final_share: null,
    };
    expect(networkTaoSplit(pipeline({ aggregate: empty }))).toEqual({
      poolFraction: null,
      buysFraction: null,
    });
    expect(
      networkTaoSplit(pipeline({ aggregate: { ...empty, tao_in_emission: 0, excess_tao: 0 } })),
    ).toEqual({ poolFraction: null, buysFraction: null });
  });
});

describe("measuredFields", () => {
  it("lists only the fields read from chain storage, sorted", () => {
    const p = pipeline({
      field_sources: {
        emission_share: { kind: "measured", storage: "SubtensorModule.SubnetMovingPrice" },
        final_share: { kind: "reconstructed", storage: null },
        excess_tao: { kind: "measured", storage: "SubtensorModule.SubnetExcessTao" },
      },
    });
    expect(measuredFields(p)).toEqual(["emission_share", "excess_tao"]);
  });

  it("returns nothing when the response carries no provenance", () => {
    expect(measuredFields(pipeline())).toEqual([]);
  });
});
