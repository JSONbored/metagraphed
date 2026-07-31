// #8749: the reconstruction harness ADR 0023 decision 3 gates #8744 on.
//
// Replays the v440 pipeline from a COMMITTED FIXTURE of raw storage hex,
// captured from finney at one pinned block by
// scripts/capture-emission-fixture.ts, and holds the result against the
// emission that block actually paid out. Deterministic and offline: the only
// thing that can move these numbers is a code change or a deliberate
// re-capture, and a re-capture that moves the error is a finding.
//
// The fixture stores RAW HEX, not decoded numbers. Decoding is done here by
// the same exported helpers production uses, so a decoder regression fails
// this test rather than being baked into the fixture and hidden.

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/emission-pipeline.json" with { type: "json" };
import {
  decodeLeU64,
  decodeLeU128,
  u64f64U128ToFloat,
  u96f32U128ToFloat,
  DEFAULT_EMISSION_GATE_EXPONENT,
} from "../src/network-parameters.ts";
import { blockEmissionForIssuance } from "../src/block-emission.ts";
import {
  emissionGate,
  emissionIdentityChecks,
  reconstructEmissionPipeline,
  recomputeEmissionGateBar,
  SUBNET_SHARE_TOLERANCE,
  type SubnetPipelineInput,
} from "../src/emission-pipeline.ts";

type HexMap = Record<string, string | null>;
const maps = fixture.maps as unknown as Record<string, HexMap>;
const values = fixture.values as unknown as Record<string, string | null>;

const at = (name: string, netuid: number): string | null =>
  maps[name]?.[String(netuid)] ?? null;

/** Every netuid the fixture saw, root included so stage 0 can exclude it. */
const NETUIDS = Array.from({ length: 128 }, (_, i) => i);

const theta = u64f64U128ToFloat(decodeLeU128(values.emission_gate_bar)!);
const quantile = u64f64U128ToFloat(decodeLeU128(values.emission_bar_quantile)!);
// Unset on chain today, which means the runtime default h = 3 -- NOT zero,
// which would make the gate 0.5 for every subnet.
const exponent =
  values.emission_gate_exponent === null
    ? DEFAULT_EMISSION_GATE_EXPONENT
    : u64f64U128ToFloat(decodeLeU128(values.emission_gate_exponent)!);
const issuanceRao = decodeLeU64(values.total_issuance)!;
const blockEmission = blockEmissionForIssuance(issuanceRao)!;

const inputs: SubnetPipelineInput[] = NETUIDS.map((netuid) => {
  const price = decodeLeU128(at("moving_price", netuid));
  const burned = decodeLeU128(at("miner_burned", netuid));
  const enabledRaw = at("emission_enabled", netuid);
  return {
    netuid,
    moving_price: price === null ? 0 : u64f64U128ToFloat(price),
    miner_burned: burned === null ? 0 : u96f32U128ToFloat(burned),
    // ABSENT MEANS ENABLED. 57 of 127 subnets have no entry at all.
    emission_enabled: enabledRaw === null ? true : enabledRaw !== "0x00",
    first_emission_block: (() => {
      const raw = decodeLeU64(at("first_emission_block", netuid));
      return raw === null ? null : Number(raw);
    })(),
    subtoken_enabled: at("subtoken_enabled", netuid) === "0x01",
    registration_allowed: at("registration_allowed", netuid) === "0x01",
  };
});

const observed = NETUIDS.map((netuid) => ({
  netuid,
  emission_enabled: inputs[netuid].emission_enabled,
  tao_in_emission_rao: decodeLeU64(at("tao_in_emission", netuid)) ?? 0n,
  excess_tao_rao: decodeLeU64(at("excess_tao", netuid)) ?? 0n,
}));

const reconstruction = reconstructEmissionPipeline({
  subnets: inputs,
  parameters: { theta, exponent },
});

describe("the captured fixture", () => {
  it("is pinned to one block, with the gate block recorded", () => {
    // Reads spread across blocks would mix states that never coexisted, and
    // the harness would chase a capture bug as a reconstruction error.
    expect(fixture.block_number).toBeGreaterThan(8_000_000);
    expect(fixture.block_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fixture.last_gate_block).toBe(
      fixture.block_number - (fixture.block_number % 360),
    );
  });

  it("decodes the live gate parameters", () => {
    expect(theta).toBeCloseTo(0.00927284254359668, 15);
    expect(quantile).toBe(0.75);
    // Unset storage, not a stored 3 — the distinction the default exists for.
    expect(values.emission_gate_exponent).toBeNull();
    expect(exponent).toBe(3);
  });

  it("derives block emission from issuance, past the first halving", () => {
    // The BlockEmission storage item reads 1.0 TAO and is stale; anyone
    // deriving percentages from it is off by 2x.
    expect(blockEmission.halvings).toBe(1);
    expect(blockEmission.rao_per_block).toBe(500_000_000n);
  });
});

describe("the reconstruction reproduces the chain", () => {
  const totalObservedRao = observed.reduce(
    (sum, o) => sum + o.tao_in_emission_rao + o.excess_tao_rao,
    0n,
  );

  it("matches every subnet's observed share within tolerance", () => {
    // THE ASSERTION THIS ISSUE EXISTS FOR. Tolerance is measured, not chosen —
    // see SUBNET_SHARE_TOLERANCE for why it is 2e-4 and not the 1e-7 the issue
    // originally asked for.
    let worst = { netuid: -1, error: 0 };
    let sum = 0;
    let counted = 0;
    for (const row of reconstruction.subnets) {
      if (row.ineligible_reason !== null) continue;
      const o = observed[row.netuid];
      const observedShare =
        Number(o.tao_in_emission_rao + o.excess_tao_rao) /
        Number(totalObservedRao);
      const error = Math.abs(observedShare - (row.final_share ?? 0));
      if (error > worst.error) worst = { netuid: row.netuid, error };
      sum += error;
      counted += 1;
    }
    const mean = sum / counted;
    expect(counted).toBeGreaterThan(100);
    expect(worst.error).toBeLessThan(SUBNET_SHARE_TOLERANCE);
    // The mean is an order of magnitude tighter than the max, and pinning it
    // catches a regression that stays under the per-subnet ceiling while
    // degrading everything at once.
    expect(mean).toBeLessThan(SUBNET_SHARE_TOLERANCE / 10);
  });

  it("is not accidentally right — every structural deviation is worse", () => {
    // Each variant below was measured against live chain and lands 30x-200x
    // worse than the pipeline as specified. Without this, a reconstruction
    // that dropped a stage could still pass the tolerance above by luck.
    const observedShare = (netuid: number) =>
      Number(
        observed[netuid].tao_in_emission_rao + observed[netuid].excess_tao_rao,
      ) / Number(totalObservedRao);

    const meanError = (shares: Map<number, number>) => {
      let sum = 0;
      let n = 0;
      for (const [netuid, share] of shares) {
        sum += Math.abs(observedShare(netuid) - share);
        n += 1;
      }
      return sum / n;
    };

    const correct = new Map<number, number>();
    for (const row of reconstruction.subnets) {
      if (row.ineligible_reason === null)
        correct.set(row.netuid, row.final_share ?? 0);
    }

    // Variant: skip stage 2's miner-burn weighting entirely.
    const noBurn = reconstructEmissionPipeline({
      subnets: inputs.map((s) => ({ ...s, miner_burned: 0 })),
      parameters: { theta, exponent },
    });
    const noBurnShares = new Map<number, number>();
    for (const row of noBurn.subnets) {
      if (row.ineligible_reason === null)
        noBurnShares.set(row.netuid, row.final_share ?? 0);
    }

    expect(meanError(noBurnShares)).toBeGreaterThan(meanError(correct) * 30);
  });

  it("gates with the STORED bar, which is stale by design", () => {
    // theta only moves on the 360-block boundary, so between recomputes the
    // chain gates with a bar that no longer matches the live distribution.
    // Replaying with a recomputed bar would gate with a number the chain was
    // not using for 359 blocks out of 360.
    const weighted = reconstruction.subnets
      .filter((r) => r.ineligible_reason === null)
      .map((r) => r.weighted_share ?? 0);
    const recomputed = recomputeEmissionGateBar(weighted, quantile)!;
    expect(recomputed).toBeGreaterThan(0);
    // They genuinely differ — that is the point, not a failure.
    expect(Math.abs(recomputed - theta) / theta).toBeGreaterThan(1e-4);
    expect(fixture.block_number - fixture.last_gate_block).toBeGreaterThan(0);
  });
});

describe("the four identities", () => {
  const checks = emissionIdentityChecks({
    subnets: observed,
    reconstruction,
    blockEmissionRao: blockEmission.rao_per_block,
    quantile,
  });
  const byName = new Map(checks.map((c) => [c.name, c]));

  it("all hold against the captured block", () => {
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    expect(checks).toHaveLength(4);
  });

  it("reports detail whether or not a check passed", () => {
    // A monitor that only spoke on failure could not tell "all clear" from
    // "did not run".
    for (const check of checks) expect(check.detail.length).toBeGreaterThan(0);
  });

  it("Σ(tao_in + excess) equals the issuance-derived block emission", () => {
    // The strongest single signal in the system: two aggregates and a
    // comparison. Fails on a broken capture, a halving, or a pipeline change.
    expect(byName.get("sum_tao_channels_equals_block_emission")?.ok).toBe(true);
  });

  it("catches a disabled subnet that received TAO", () => {
    const disabled = observed.find((o) => !o.emission_enabled)!;
    const tampered = observed.map((o) =>
      o.netuid === disabled.netuid ? { ...o, excess_tao_rao: 1n } : o,
    );
    const result = emissionIdentityChecks({
      subnets: tampered,
      reconstruction,
      blockEmissionRao: blockEmission.rao_per_block,
      quantile,
    });
    const check = result.find(
      (c) => c.name === "disabled_subnets_receive_nothing",
    )!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(`netuid ${disabled.netuid}`);
  });

  it("catches the quantile moving off 0.75", () => {
    // q was raised from its 0.61 default after the v440 deploy. Another move
    // reshapes the gate for every subnet at once.
    const result = emissionIdentityChecks({
      subnets: observed,
      reconstruction,
      blockEmissionRao: blockEmission.rao_per_block,
      quantile: 0.61,
    });
    expect(
      result.find((c) => c.name === "emission_bar_quantile_is_three_quarters")
        ?.ok,
    ).toBe(false);
  });

  it("catches a halving boundary being crossed", () => {
    // The identity's right-hand side moves discontinuously at a halving, so
    // block emission must be re-derived each run and never cached.
    const result = emissionIdentityChecks({
      subnets: observed,
      reconstruction,
      blockEmissionRao: 250_000_000n,
      quantile,
    });
    expect(
      result.find((c) => c.name === "sum_tao_channels_equals_block_emission")
        ?.ok,
    ).toBe(false);
  });
});

describe("stage 0 eligibility", () => {
  it("excludes root and nothing else on this block", () => {
    const excluded = reconstruction.subnets.filter(
      (r) => r.ineligible_reason !== null,
    );
    expect(excluded.some((r) => r.netuid === 0)).toBe(true);
    // Every eligible subnet has a share; every excluded one has none at all,
    // rather than a zero that reads like a measurement.
    for (const row of reconstruction.subnets) {
      if (row.ineligible_reason === null) {
        expect(row.price_share).not.toBeNull();
        expect(row.final_share).not.toBeNull();
      } else {
        expect(row.price_share).toBeNull();
        expect(row.final_share).toBeNull();
      }
    }
  });

  it("names each reason rather than collapsing them", () => {
    for (const reason of [
      "never_emitted",
      "subtoken_disabled",
      "registration_closed",
    ] as const) {
      const doctored = inputs.map((s, i) =>
        i === 5
          ? {
              ...s,
              ...(reason === "never_emitted"
                ? { first_emission_block: null }
                : reason === "subtoken_disabled"
                  ? { subtoken_enabled: false }
                  : { registration_allowed: false }),
            }
          : s,
      );
      const result = reconstructEmissionPipeline({
        subnets: doctored,
        parameters: { theta, exponent },
      });
      expect(result.subnets[5].ineligible_reason).toBe(reason);
    }
  });
});

describe("emission_enabled = false is distinguishable from a low share", () => {
  it("zeroes the disabled subnet and redistributes", () => {
    const disabled = reconstruction.subnets.filter(
      (r) => r.ineligible_reason === null && !r.emission_enabled,
    );
    expect(disabled.length).toBeGreaterThan(40);
    for (const row of disabled) {
      expect(row.final_share).toBe(0);
      // gated_share is retained so the decomposition can still show what the
      // gate did to a subnet before the switch zeroed it.
      expect(row.gated_share).not.toBeNull();
      expect(row.gated_share).toBeGreaterThanOrEqual(0);
    }
  });

  it("CANNOT be inferred from final_share alone — the flag must be published", () => {
    // ADR 0023 requires the off switch to be distinguishable from "gated to
    // near-zero". It is NOT distinguishable from the final share: a subnet
    // far enough below the bar has its gated share underflow to exactly 0,
    // so an enabled-but-deeply-gated subnet and a disabled one both end at
    // final_share === 0.
    //
    // Measured on this fixture: several disabled subnets ALSO have
    // gated_share === 0, so neither field separates the two states on its
    // own. #8744 must publish emission_enabled explicitly rather than let a
    // client infer it from a zero — which is exactly the inference this test
    // exists to make impossible to get away with.
    const eligible = reconstruction.subnets.filter(
      (r) => r.ineligible_reason === null,
    );
    const zeroGated = eligible.filter((r) => r.gated_share === 0);
    expect(zeroGated.length).toBeGreaterThan(0);

    const zeroFinalEnabled = eligible.filter(
      (r) => r.emission_enabled && r.final_share === 0,
    );
    const zeroFinalDisabled = eligible.filter(
      (r) => !r.emission_enabled && r.final_share === 0,
    );
    // Both populations exist and both read final_share === 0.
    expect(zeroFinalDisabled.length).toBeGreaterThan(0);
    for (const row of [...zeroFinalEnabled, ...zeroFinalDisabled]) {
      expect(row.final_share).toBe(0);
    }
    // The flag is the only thing that separates them.
    expect(
      new Set(
        [...zeroFinalEnabled, ...zeroFinalDisabled].map(
          (r) => r.emission_enabled,
        ),
      ).size,
    ).toBe(zeroFinalEnabled.length > 0 ? 2 : 1);
  });
});

describe("the gate itself", () => {
  it("passes exactly one half at the bar", () => {
    expect(emissionGate(theta, theta, exponent)).toBeCloseTo(0.5, 15);
  });

  it("is monotonic and bounded", () => {
    let previous = 0;
    for (const share of [theta / 8, theta / 2, theta, theta * 2, theta * 8]) {
      const gate = emissionGate(share, theta, exponent);
      expect(gate).toBeGreaterThanOrEqual(previous);
      expect(gate).toBeLessThanOrEqual(1);
      previous = gate;
    }
  });

  it("is disabled by a zero bar rather than zeroing every subnet", () => {
    // apply_emission_gate returns early on theta <= 0. Treating it as a
    // threshold instead would strand the block's entire emission.
    expect(emissionGate(0.01, 0, exponent)).toBe(1);
    expect(emissionGate(0, theta, exponent)).toBe(0);
  });

  it("survives a distribution the gate would zero entirely", () => {
    // A stale bar far above every share with a steep h. The runtime restores
    // the ungated shares so emission is not stranded; so does this.
    const result = reconstructEmissionPipeline({
      subnets: inputs,
      parameters: { theta: 1e9, exponent: 30 },
    });
    const sum = result.subnets.reduce((a, r) => a + (r.final_share ?? 0), 0);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("distance_to_bar", () => {
  it("is measured against the weighted share, not the price share", () => {
    // ADR 0023 decision 3: theta is computed over the post-MinerBurned
    // distribution, so comparing stage 1 to it answers a question the gate
    // does not ask.
    const row = reconstruction.subnets.find(
      (r) => r.ineligible_reason === null && r.miner_burned > 0.1,
    )!;
    expect(row.distance_to_bar).toBeCloseTo(
      (row.weighted_share ?? 0) / theta,
      12,
    );
    expect(row.distance_to_bar).not.toBeCloseTo(
      (row.price_share ?? 0) / theta,
      6,
    );
  });

  it("is null when the bar is zero, because there is no bar to be near", () => {
    // apply_emission_gate returns early on theta <= 0, so the gate is off and
    // "distance to the bar" is not a quantity that exists. Null says that;
    // Infinity or 0 would both read as measurements.
    const ungated = reconstructEmissionPipeline({
      subnets: inputs,
      parameters: { theta: 0, exponent },
    });
    const eligible = ungated.subnets.filter(
      (r) => r.ineligible_reason === null,
    );
    expect(eligible.length).toBeGreaterThan(0);
    for (const row of eligible) {
      expect(row.distance_to_bar).toBeNull();
      // With the gate off, the gated share is the weighted share untouched.
      expect(row.gated_share).toBeCloseTo(row.weighted_share ?? 0, 12);
      expect(row.gate_delta).toBeCloseTo(0, 12);
    }
  });

  it("separates subnets above and below the bar", () => {
    const above = reconstruction.subnets.filter(
      (r) => (r.distance_to_bar ?? 0) > 1,
    );
    const below = reconstruction.subnets.filter(
      (r) => r.ineligible_reason === null && (r.distance_to_bar ?? 0) <= 1,
    );
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
  });

  it("does not mean 'above the bar gains' — renormalization decides that", () => {
    // The tempting reading is that clearing the bar means gaining share. It
    // does not: the gate multiplies, then everything is renormalized to sum
    // 1, so whether a subnet gains depends on its gate factor relative to the
    // WEIGHTED MEAN gate factor, not on the bar. Measured on this fixture, 13
    // of 29 subnets above the bar still LOSE share.
    //
    // Only well clear of the bar is the sign reliable.
    const marginal = reconstruction.subnets.filter(
      (r) =>
        r.ineligible_reason === null &&
        (r.distance_to_bar ?? 0) > 1 &&
        (r.gate_delta ?? 0) <= 0,
    );
    expect(marginal.length).toBeGreaterThan(0);

    const wellAbove = reconstruction.subnets.filter(
      (r) => r.ineligible_reason === null && (r.distance_to_bar ?? 0) > 2,
    );
    expect(wellAbove.length).toBeGreaterThan(0);
    for (const row of wellAbove) expect(row.gate_delta).toBeGreaterThan(0);
  });

  it("conserves share — the gate redistributes and never withholds", () => {
    // ADR 0023 decision 4: no surface may describe the gate as withholding.
    // This is that claim as arithmetic: the deltas sum to zero, so every unit
    // one subnet gains at the gate is a unit another lost.
    const sum = reconstruction.subnets.reduce(
      (a, r) => a + (r.gate_delta ?? 0),
      0,
    );
    expect(Math.abs(sum)).toBeLessThan(1e-12);
  });
});

describe("degenerate inputs", () => {
  it("returns a defined result for no subnets", () => {
    const result = reconstructEmissionPipeline({
      subnets: [],
      parameters: { theta, exponent },
    });
    expect(result.subnets).toEqual([]);
    expect(result.eligible_count).toBe(0);
    expect(result.disabled_count).toBe(0);
  });

  it("falls back to price shares when every subnet burns everything", () => {
    // get_shares does exactly this rather than stranding the block.
    const result = reconstructEmissionPipeline({
      subnets: inputs.map((s) => ({ ...s, miner_burned: 1 })),
      parameters: { theta, exponent },
    });
    const eligible = result.subnets.filter((r) => r.ineligible_reason === null);
    const sum = eligible.reduce((a, r) => a + (r.weighted_share ?? 0), 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("handles a zero-price population without producing NaN", () => {
    const result = reconstructEmissionPipeline({
      subnets: inputs.map((s) => ({ ...s, moving_price: 0 })),
      parameters: { theta, exponent },
    });
    for (const row of result.subnets) {
      if (row.ineligible_reason !== null) continue;
      expect(Number.isFinite(row.price_share ?? 0)).toBe(true);
      expect(Number.isFinite(row.final_share ?? 0)).toBe(true);
    }
  });

  it("ignores a negative or non-finite miner_burned rather than inverting a weight", () => {
    const result = reconstructEmissionPipeline({
      subnets: inputs.map((s, i) =>
        i === 3
          ? { ...s, miner_burned: NaN }
          : i === 4
            ? { ...s, miner_burned: -1 }
            : s,
      ),
      parameters: { theta, exponent },
    });
    expect(result.subnets[3].miner_burned).toBe(0);
    expect(result.subnets[4].miner_burned).toBe(0);
  });

  it("caps miner_burned at 1 so a weight can never go negative", () => {
    const result = reconstructEmissionPipeline({
      subnets: inputs.map((s, i) => (i === 6 ? { ...s, miner_burned: 4 } : s)),
      parameters: { theta, exponent },
    });
    expect(result.subnets[6].miner_burned).toBe(1);
    expect(result.subnets[6].weighted_share).toBe(0);
  });

  it("returns null from the bar recompute for an empty distribution", () => {
    expect(recomputeEmissionGateBar([], 0.75)).toBeNull();
    expect(recomputeEmissionGateBar([0, -1, NaN], 0.75)).toBeNull();
  });
});
