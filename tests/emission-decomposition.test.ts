// The published decomposition (#8744), held against the SAME committed finney
// fixture #8749's harness uses.
//
// That is the point of this file. The surface and the harness must agree, or
// ADR 0023 decision 3 -- "a reconstructed field ships only while the harness
// holds it" -- is words. Both sides decode the same raw storage hex here, so a
// divergence fails a test instead of shipping.
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/emission-pipeline.json" with { type: "json" };
import {
  buildEmissionDecomposition,
  taoToRao,
  EMISSION_FIELD_SOURCES,
  type DecompositionChainState,
  type EconomicsPipelineRow,
} from "../src/emission-decomposition.ts";
import {
  decodeLeU64,
  decodeLeU128,
  u64f64U128ToFloat,
  u96f32U128ToFloat,
} from "../src/network-parameters.ts";
import { DEFAULT_EMISSION_GATE_EXPONENT } from "../src/emission-pipeline.ts";

type HexMap = Record<string, string>;
const maps = fixture.maps as unknown as Record<string, HexMap>;
const values = fixture.values as unknown as Record<string, string | null>;
const at = (name: string, netuid: number): string | null =>
  maps[name]?.[String(netuid)] ?? null;

const NETUIDS = Array.from({ length: 128 }, (_, i) => i);

const RAO = (tao: number): string => tao.toFixed(9);

/** The fixture's raw hex, decoded into the artifact shape the surface reads. */
const fixtureRows: EconomicsPipelineRow[] = NETUIDS.map((netuid) => {
  const price = decodeLeU128(at("moving_price", netuid));
  const burned = decodeLeU128(at("miner_burned", netuid));
  const enabled = at("emission_enabled", netuid);
  const first = decodeLeU64(at("first_emission_block", netuid));
  const taoIn = decodeLeU64(at("tao_in_emission", netuid)) ?? 0n;
  const excess = decodeLeU64(at("excess_tao", netuid)) ?? 0n;
  return {
    netuid,
    // I96F32, matching the producers (#9224). The reconstruction normalizes
    // this into a share, so the scale cancels and every assertion below holds
    // either way -- which is exactly why the wrong scale survived so long.
    moving_price_pinned: price === null ? null : u96f32U128ToFloat(price),
    miner_burned_fraction: burned === null ? null : u96f32U128ToFloat(burned),
    // ABSENT MEANS ENABLED.
    emission_enabled: enabled === null ? true : enabled !== "0x00",
    subtoken_enabled: at("subtoken_enabled", netuid) === "0x01",
    registration_allowed_pinned: at("registration_allowed", netuid) === "0x01",
    first_emission_block: first === null ? null : Number(first),
    // Exact decimal strings, the way Postgres NUMERIC and the artifact hand
    // them over -- so the test exercises the string path, not just numbers.
    tao_in_emission_tao: RAO(Number(taoIn) / 1e9),
    excess_tao: RAO(Number(excess) / 1e9),
    alpha_in_emission: 0,
    alpha_out_emission: 1,
  };
});

const chainState: DecompositionChainState = {
  block: fixture.block_number,
  block_hash: fixture.block_hash,
  total_issuance_tao: Number(decodeLeU64(values.total_issuance)!) / 1e9,
  emission_gate_bar: u64f64U128ToFloat(decodeLeU128(values.emission_gate_bar)!),
  emission_bar_quantile: u64f64U128ToFloat(
    decodeLeU128(values.emission_bar_quantile)!,
  ),
  emission_gate_exponent:
    values.emission_gate_exponent === null
      ? null
      : Number(u64f64U128ToFloat(decodeLeU128(values.emission_gate_exponent)!)),
};

const result = buildEmissionDecomposition({
  subnets: fixtureRows,
  chainState,
});

describe("taoToRao", () => {
  it("is exact where a float multiply is not", () => {
    // 0.1 + 0.2 territory: `Number("0.123456789") * 1e9` is 123456788.99999999.
    expect(taoToRao("0.123456789")).toBe(123_456_789n);
    // Nine decimals IS rao precision -- exact, and past 2^53 in rao space,
    // which is where a float round-trip starts losing whole rao (#2921).
    expect(taoToRao("1234567.891234567")).toBe(1_234_567_891_234_567n);
    expect(taoToRao("1234567.891234")).toBe(1_234_567_891_234_000n);
    // A tenth decimal is finer than rao and is REJECTED, not truncated:
    // silently dropping it would lose precision invisibly, which is the exact
    // failure this function exists to prevent.
    expect(taoToRao("0.1234567891")).toBe(null);
    expect(taoToRao("0")).toBe(0n);
    expect(taoToRao("21000000")).toBe(21_000_000_000_000_000n);
  });

  it("accepts numbers via their exact rao rendering", () => {
    expect(taoToRao(0.123456789)).toBe(123_456_789n);
    expect(taoToRao(0)).toBe(0n);
  });

  it("rejects anything that is not a non-negative decimal", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "abc",
      "-1",
      "1e9",
      "0x10",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      {},
      [],
    ]) {
      expect(taoToRao(bad)).toBe(null);
    }
  });
});

describe("the decomposition against the committed finney fixture", () => {
  it("verifies -- every identity holds on the rows being served", () => {
    // ADR 0023 decision 3. If this ever goes false on the fixture, the surface
    // is serving something it cannot defend and the test says so first.
    expect(result.verification.verified).toBe(true);
    expect(result.verification.checks.length).toBeGreaterThanOrEqual(4);
    for (const check of result.verification.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it("sums final_share to 1", () => {
    expect(result.aggregate.total_final_share).toBeCloseTo(1, 9);
  });

  it("reproduces the network split", () => {
    // The number #8744 exists to publish. Roughly a third pool injection.
    expect(result.aggregate.liquidity_fraction).toBeGreaterThan(0.2);
    expect(result.aggregate.liquidity_fraction).toBeLessThan(0.5);
    expect(result.aggregate.tao_total).toBeCloseTo(
      result.aggregate.tao_in_emission + result.aggregate.excess_tao,
      9,
    );
  });

  it("derives block emission past the first halving", () => {
    expect(result.block_emission_halvings).toBe(1);
    expect(result.block_emission_tao).toBeCloseTo(0.5, 9);
  });

  it("excludes root and counts the disabled", () => {
    const root = result.subnets.find((s) => s.netuid === 0)!;
    expect(root.ineligible_reason).toBe("root");
    expect(root.emission_share).toBe(null);
    expect(result.aggregate.disabled_count).toBeGreaterThan(0);
    expect(result.aggregate.eligible_count).toBeGreaterThan(0);
  });

  // The finding #8744 needs and cannot infer: a deeply gated but ENABLED
  // subnet and a disabled one both read final_share = 0.
  it("keeps emission_enabled distinguishable from a zero final share", () => {
    const zeroed = result.subnets.filter(
      (s) => s.ineligible_reason === null && s.final_share === 0,
    );
    expect(zeroed.length).toBeGreaterThan(0);
    // The flag is published because it cannot be derived from the share.
    for (const subnet of zeroed) {
      expect(typeof subnet.emission_enabled).toBe("boolean");
    }
  });

  it("labels every reconstructed field as ours, not the chain's", () => {
    expect(EMISSION_FIELD_SOURCES.final_share.kind).toBe("reconstructed");
    expect(EMISSION_FIELD_SOURCES.liquidity_fraction.kind).toBe(
      "reconstructed",
    );
    // And every measurement names the storage item behind it.
    expect(EMISSION_FIELD_SOURCES.tao_in_emission.storage).toBe(
      "SubtensorModule.SubnetTaoInEmission",
    );
    expect(EMISSION_FIELD_SOURCES.excess_tao.storage).toBe(
      "SubtensorModule.SubnetExcessTao",
    );
  });

  it("carries the pinned block through to the response", () => {
    expect(result.chain_state.block).toBe(fixture.block_number);
    expect(result.chain_state.block_hash).toBe(fixture.block_hash);
  });
});

describe("degraded and edge inputs", () => {
  const base = chainState;

  it("reports drift instead of serving when issuance is unusable", () => {
    const broken = buildEmissionDecomposition({
      subnets: fixtureRows,
      chainState: { ...base, total_issuance_tao: Number.NaN },
    });
    expect(broken.verification.verified).toBe(false);
    expect(broken.block_emission_tao).toBe(null);
    expect(broken.verification.checks[0].name).toBe("block_emission_derivable");
  });

  it("treats an unset exponent as the runtime default, never zero", () => {
    // h = 0 would make the Hill gate exactly 0.5 for every subnet, which is a
    // different pipeline, not a missing value.
    const unset = buildEmissionDecomposition({
      subnets: fixtureRows,
      chainState: { ...base, emission_gate_exponent: null },
    });
    const explicit = buildEmissionDecomposition({
      subnets: fixtureRows,
      chainState: {
        ...base,
        emission_gate_exponent: DEFAULT_EMISSION_GATE_EXPONENT,
      },
    });
    expect(unset.aggregate.total_final_share).toBeCloseTo(
      explicit.aggregate.total_final_share,
      12,
    );
    const zeroed = buildEmissionDecomposition({
      subnets: fixtureRows,
      chainState: { ...base, emission_gate_exponent: 0 },
    });
    const netuid = fixtureRows[1].netuid;
    expect(
      zeroed.subnets.find((s) => s.netuid === netuid)!.gated_share,
    ).not.toBe(unset.subnets.find((s) => s.netuid === netuid)!.gated_share);
  });

  it("nulls a subnet's totals when a channel was not captured", () => {
    const partial = buildEmissionDecomposition({
      subnets: [
        { ...fixtureRows[1], tao_in_emission_tao: null },
        { ...fixtureRows[2], excess_tao: null },
      ],
      chainState: base,
    });
    for (const subnet of partial.subnets) {
      expect(subnet.tao_total).toBe(null);
      expect(subnet.liquidity_fraction).toBe(null);
    }
  });

  it("returns null rather than NaN for a zero-intake subnet", () => {
    const zero = buildEmissionDecomposition({
      subnets: [
        {
          ...fixtureRows[1],
          tao_in_emission_tao: "0.000000000",
          excess_tao: "0.000000000",
        },
      ],
      chainState: base,
    });
    expect(zero.subnets[0].tao_total).toBe(0);
    expect(zero.subnets[0].liquidity_fraction).toBe(null);
    expect(zero.aggregate.liquidity_fraction).toBe(null);
  });

  it("treats an absent emission_enabled as enabled", () => {
    const absent = buildEmissionDecomposition({
      subnets: [{ ...fixtureRows[1], emission_enabled: null }],
      chainState: base,
    });
    expect(absent.subnets[0].emission_enabled).toBe(true);
  });

  it("handles an empty subnet set without dividing by zero", () => {
    const empty = buildEmissionDecomposition({ subnets: [], chainState: base });
    expect(empty.subnets).toEqual([]);
    expect(empty.aggregate.eligible_count).toBe(0);
    expect(empty.aggregate.liquidity_fraction).toBe(null);
    expect(empty.aggregate.total_final_share).toBe(0);
  });

  // Every one of these is "the storage read did not come back", which is a
  // different state from the value being false or zero -- and each defaults
  // the safe way: not eligible, and no quantile claimed.
  it("treats absent stage-0 flags and an absent quantile as not-captured", () => {
    const decomposed = buildEmissionDecomposition({
      subnets: [
        {
          ...fixtureRows[1],
          subtoken_enabled: null,
          registration_allowed_pinned: null,
        },
      ],
      chainState: { ...base, emission_bar_quantile: null },
    });
    // Absent subtoken_enabled fails stage 0 first -- it is checked before
    // registration_allowed, so that is the reason reported.
    expect(decomposed.subnets[0].ineligible_reason).toBe("subtoken_disabled");
    expect(decomposed.subnets[0].emission_share).toBe(null);
    expect(decomposed.aggregate.eligible_count).toBe(0);

    const closed = buildEmissionDecomposition({
      subnets: [
        {
          ...fixtureRows[1],
          subtoken_enabled: true,
          registration_allowed_pinned: null,
        },
      ],
      chainState: { ...base, emission_bar_quantile: null },
    });
    expect(closed.subnets[0].ineligible_reason).toBe("registration_closed");
  });

  it("disables the gate outright when the bar is unset", () => {
    // apply_emission_gate's own `if theta <= zero { return; }`.
    const ungated = buildEmissionDecomposition({
      subnets: fixtureRows,
      chainState: { ...base, emission_gate_bar: null },
    });
    for (const subnet of ungated.subnets) {
      if (subnet.ineligible_reason !== null) continue;
      expect(subnet.distance_to_bar).toBe(null);
      expect(subnet.gated_share).toBeCloseTo(subnet.weighted_share!, 12);
    }
  });
});
