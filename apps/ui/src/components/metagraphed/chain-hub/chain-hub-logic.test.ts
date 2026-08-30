import { describe, expect, it } from "vitest";
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type {
  ChainCallEntry,
  ChainFeeDay,
  ChainStakeFlowSubnet,
  Extrinsic,
  RuntimeTransition,
} from "@/lib/metagraphed/types";
import {
  callSegments,
  feePoints,
  summarizeFeeWindow,
  pipelineRails,
  pipelineTally,
  flowRails,
  fmtCount,
  fmtShare,
  fmtTao,
  governanceKinds,
  governanceRows,
  lastCompleteDay,
} from "./chain-hub-logic";

const nameOf = (netuid: number) => `SN${netuid}`;

describe("formatters", () => {
  it("compacts counts, formats TAO and shares, and refuses a non-number", () => {
    expect(fmtCount(1_020_430)).toBe("1.02M");
    expect(fmtCount(7_200)).toBe("7.2k");
    expect(fmtTao(7.231114583, 4)).toBe("7.2311τ");
    expect(fmtShare(0.3464)).toBe("34.6%");
    expect(fmtCount(null)).toBe("—");
    expect(fmtTao(undefined)).toBe("—");
    expect(fmtShare(Number.NaN)).toBe("—");
  });
});

describe("callSegments", () => {
  const calls = [1, 2, 3, 4].map(
    (n) =>
      ({ call_module: `M${n}`, call_function: null, count: n * 10, share: null }) as ChainCallEntry,
  );

  it("ranks by count and rolls the tail into one residual", () => {
    const segments = callSegments(calls, 2);
    expect(segments.map((s) => s.key)).toEqual(["M4", "M3", RESIDUAL_KEY]);
    expect(segments[2]).toMatchObject({ label: "2 more modules", value: 30 });
  });

  it("emits no residual when the head is everything", () => {
    expect(callSegments(calls, 10).some((s) => s.key === RESIDUAL_KEY)).toBe(false);
  });

  it("drops a module with no calls, and survives an empty read", () => {
    expect(
      callSegments([
        { call_module: "Idle", call_function: null, count: 0, share: null },
      ] as ChainCallEntry[]),
    ).toEqual([]);
    expect(callSegments([])).toEqual([]);
  });
});

describe("feePoints", () => {
  const days = [
    { day: "2026-08-23", total_fee_tao: 7 },
    { day: "2026-08-21", total_fee_tao: 5 },
    { day: "2026-08-22", total_fee_tao: null },
  ] as unknown as ChainFeeDay[];

  it("sorts into time order and drops a day with no reading", () => {
    expect(feePoints(days).map((p) => p.v)).toEqual([5, 7]);
  });
});

describe("summarizeFeeWindow", () => {
  it("weights the window average by signed extrinsics", () => {
    const days = [
      {
        total_fee_tao: 100,
        total_tip_tao: 2,
        signed_extrinsic_count: 100,
        avg_fee_tao: 1,
      },
      {
        total_fee_tao: 9,
        total_tip_tao: 1,
        signed_extrinsic_count: 1,
        avg_fee_tao: 9,
      },
    ] as unknown as ChainFeeDay[];

    expect(summarizeFeeWindow(days)).toEqual({
      totalFeeTao: 109,
      totalTipTao: 3,
      averageFeeTao: 109 / 101,
      dayCount: 2,
    });
  });

  it("does not turn an unavailable window or absent denominator into a zero average", () => {
    expect(summarizeFeeWindow([])).toBeNull();
    expect(
      summarizeFeeWindow([
        {
          total_fee_tao: 0,
          total_tip_tao: 0,
          signed_extrinsic_count: 0,
        } as unknown as ChainFeeDay,
      ])?.averageFeeTao,
    ).toBeNull();
  });
});

describe("flowRails", () => {
  const subnets = [
    { netuid: 1, total_staked_tao: 10, total_unstaked_tao: 1 },
    { netuid: 2, total_staked_tao: 0, total_unstaked_tao: 50 },
    { netuid: 3, total_staked_tao: 0, total_unstaked_tao: 0 },
  ] as ChainStakeFlowSubnet[];
  const fmt = (value: number) => `${value} t`;

  it("keeps both directions on every row", () => {
    // A subnet that only saw exits still shows the track that says so; a
    // net-only view renders it as a small negative indistinguishable from a
    // quiet subnet.
    expect(flowRails(subnets, nameOf, fmt).find((rail) => rail.key === "sn-2")).toMatchObject({
      value: 0,
      secondary: 50,
    });
  });

  it("cuts by gross movement but orders by the leading value", () => {
    // Gross decides who makes the cut -- an exits-only subnet belongs in
    // "where stake moved" -- and the inflow column decides the order, because
    // a ranked rail whose first column is not monotonic reads as broken.
    expect(flowRails(subnets, nameOf, fmt).map((rail) => rail.key)).toEqual(["sn-1", "sn-2"]);
    expect(flowRails(subnets, nameOf, fmt, 1).map((rail) => rail.key)).toEqual(["sn-2"]);
  });

  it("names the row rather than leaving it to an axis label", () => {
    // The whole point of the rail: the stacked columns this replaced put a
    // rotated "SN2" over one bar in fourteen and named none of the rest.
    expect(flowRails(subnets, nameOf, fmt)[0]?.label).toBe(nameOf(1));
    expect(flowRails(subnets, nameOf, fmt)[0]?.href).toBe("/subnets/1");
  });

  it("carries in, out and net for the tooltip", () => {
    expect(flowRails(subnets, nameOf, fmt)[0]?.detail).toEqual([
      { key: "in", label: "Staked in", value: "10 t" },
      { key: "out", label: "Unstaked out", value: "1 t" },
      { key: "net", label: "Net", value: "9 t" },
    ]);
  });

  it("drops a subnet nothing moved on and honours the ceiling", () => {
    expect(flowRails(subnets, nameOf, fmt).some((rail) => rail.key === "sn-3")).toBe(false);
    expect(flowRails(subnets, nameOf, fmt, 1)).toHaveLength(1);
  });

  it("does not leak the sort key into the rail", () => {
    expect(flowRails(subnets, nameOf, fmt)[0]).not.toHaveProperty("total");
  });
});

describe("lastCompleteDay", () => {
  it("skips the day in progress", () => {
    const days = [{ day: "2026-08-21" }, { day: "2026-08-23" }, { day: "2026-08-22" }];
    expect(lastCompleteDay(days)?.day).toBe("2026-08-22");
  });

  it("falls back to the only day it has, and survives none", () => {
    expect(lastCompleteDay([{ day: "2026-08-23" }])?.day).toBe("2026-08-23");
    expect(lastCompleteDay([])).toBeNull();
  });
});

describe("governanceRows", () => {
  const runtime = [
    { spec_version: 448, block_number: 900, observed_at: "2026-08-01T00:00:00Z" },
  ] as RuntimeTransition[];
  const sudo = [
    {
      block_number: 950,
      extrinsic_index: 1,
      extrinsic_hash: "0x1",
      signer: "5A",
      call_module: "Sudo",
      call_function: "sudo",
      observed_at: "2026-08-02T00:00:00Z",
    },
  ] as Extrinsic[];
  const config = [
    {
      block_number: 800,
      extrinsic_index: 2,
      extrinsic_hash: "0x2",
      signer: "5B",
      call_module: "AdminUtils",
      call_function: "sudo_set_weights_set_rate_limit",
      observed_at: "2026-07-30T00:00:00Z",
    },
  ] as Extrinsic[];

  it("merges three streams into one, newest block first", () => {
    // Three routes and three tables answered one question, and a reader had
    // to know which of the three a change would have landed in.
    const rows = governanceRows(runtime, sudo, config);
    expect(rows.map((r) => r.block)).toEqual([950, 900, 800]);
    expect(rows.map((r) => r.kind)).toEqual(["sudo", "runtime upgrade", "config change"]);
  });

  it("names the change rather than repeating its kind", () => {
    const rows = governanceRows(runtime, sudo, config);
    expect(rows.find((r) => r.block === 900)?.summary).toBe("spec 448");
    expect(rows.find((r) => r.block === 800)?.summary).toBe(
      "AdminUtils.sudo_set_weights_set_rate_limit",
    );
  });

  it("offers exactly the kinds present, sorted", () => {
    expect(governanceKinds(governanceRows(runtime, sudo, config))).toEqual([
      "config change",
      "runtime upgrade",
      "sudo",
    ]);
    expect(governanceKinds([])).toEqual([]);
  });

  it("survives every stream being empty", () => {
    expect(governanceRows([], [], [])).toEqual([]);
  });
});

// A five-row stand-in covering every route through the pipeline: two paid,
// one never eligible, one eligible with emission switched off, one eligible
// and enabled whose weighting zeroed it before the gate ran.
const pipeline = [
  {
    netuid: 4,
    emission_share: 0.2,
    weighted_share: 0.22,
    gated_share: 0.24,
    final_share: 0.25,
    gate_delta: 0.05,
    emission_enabled: true,
    ineligible_reason: null,
  },
  {
    netuid: 9,
    emission_share: 0.1,
    weighted_share: 0.09,
    gated_share: 0.08,
    final_share: 0.075,
    gate_delta: -0.025,
    emission_enabled: true,
    ineligible_reason: null,
  },
  {
    netuid: 0,
    emission_share: null,
    weighted_share: null,
    gated_share: null,
    final_share: null,
    gate_delta: null,
    emission_enabled: false,
    ineligible_reason: "root",
  },
  {
    netuid: 11,
    emission_share: 0.05,
    weighted_share: 0.05,
    gated_share: 0.05,
    final_share: 0,
    gate_delta: 0,
    emission_enabled: false,
    ineligible_reason: null,
  },
  {
    netuid: 14,
    emission_share: 0.007,
    weighted_share: 0,
    gated_share: 0,
    final_share: 0,
    gate_delta: 0,
    emission_enabled: true,
    ineligible_reason: null,
  },
];

const pipelineName = (netuid: number) => `SN${netuid}`;

describe("pipelineRails", () => {
  it("ranks by the share a subnet is PAID, not the one it publishes", () => {
    // netuid 11 publishes 0.05 and is paid nothing; a rank on emission_share
    // would seat it third. Ranking on final_share drops it out entirely.
    const rails = pipelineRails(pipeline, pipelineName);
    expect(rails.map((r) => r.key)).toEqual(["sn-4", "sn-9"]);
    expect(rails[0]!.label).toBe("SN4");
    expect(rails[0]!.href).toBe("/subnets/4");
  });

  it("drops every subnet paid nothing rather than drawing a zero rail", () => {
    expect(pipelineRails(pipeline, pipelineName).some((r) => r.value === 0)).toBe(false);
  });

  it("carries all four stages, and signs the gate delta", () => {
    const [first, second] = pipelineRails(pipeline, pipelineName);
    expect(first!.detail.map((d) => d.key)).toEqual(["raw", "weighted", "gated", "delta"]);
    expect(first!.detail.find((d) => d.key === "delta")?.value).toBe("+5.000%");
    expect(second!.detail.find((d) => d.key === "delta")?.value).toBe("-2.500%");
  });

  it("renders an absent stage rather than printing NaN", () => {
    const rails = pipelineRails(
      [{ ...pipeline[0]!, weighted_share: null, gate_delta: null }],
      pipelineName,
    );
    expect(rails[0]!.detail.find((d) => d.key === "weighted")?.value).toBe("—");
    expect(rails[0]!.detail.find((d) => d.key === "delta")?.value).toBe("—");
  });

  it("honours the limit and survives an empty pipeline", () => {
    expect(pipelineRails(pipeline, pipelineName, 1)).toHaveLength(1);
    expect(pipelineRails([], pipelineName)).toEqual([]);
  });
});

describe("pipelineTally", () => {
  it("splits the unpaid into the three ways a subnet gets there", () => {
    expect(pipelineTally(pipeline)).toEqual({
      total: 5,
      paid: 2,
      unpaid: 3,
      ineligible: 1,
      disabled: 1,
      zeroWeighted: 1,
    });
  });

  it("counts disabled within the eligible set, never against the whole", () => {
    // The response's own aggregate nests these: an ineligible subnet with
    // emission_enabled false must not be counted twice, or the three routes
    // stop summing to `unpaid`.
    const t = pipelineTally([
      { ineligible_reason: "root", emission_enabled: false, final_share: null },
      { ineligible_reason: "never_emitted", emission_enabled: false, final_share: null },
    ]);
    expect(t.ineligible).toBe(2);
    expect(t.disabled).toBe(0);
    expect(t.ineligible + t.disabled + t.zeroWeighted).toBe(t.unpaid);
  });

  it("is all zeroes on an empty pipeline", () => {
    expect(pipelineTally([])).toEqual({
      total: 0,
      paid: 0,
      unpaid: 0,
      ineligible: 0,
      disabled: 0,
      zeroWeighted: 0,
    });
  });
});
