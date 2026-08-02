// The published v440 emission decomposition (#8744).
//
// Takes the economics artifact's per-subnet pipeline inputs plus its
// chain_state, replays stages 0-5 through src/emission-pipeline.ts -- the SAME
// module #8749's CI harness and box-side drift monitor run -- and returns the
// per-subnet decomposition, the network aggregate, and the identity checks
// evaluated ON THE ROWS BEING SERVED.
//
// THAT LAST PART IS ADR 0023 DECISION 3, IMPLEMENTED. The decision says a
// reconstructed field ships "only while #8749's harness holds it against live
// chain state", and that a red harness must make the surface report drift
// rather than keep serving a number it can no longer defend. The harness is CI
// plus a systemd unit; neither can reach into a Worker. Checking the identities
// at read time is strictly stronger than a flag either could have written: a
// stored flag can be green while THIS response is broken (a degraded capture
// nulls exactly these columns) and red while this response is fine, and it can
// go stale. This cannot -- it validates the bytes being returned.
//
// Its blind spot is a structural runtime change that still satisfies all four
// identities. That is what the live monitor catches, by failing its unit. The
// two halves cover each other and neither needs new plumbing.
import {
  AGGREGATE_IDENTITY_TOLERANCE_RAO,
  DEFAULT_EMISSION_GATE_EXPONENT,
  emissionIdentityChecks,
  reconstructEmissionPipeline,
  SUBNET_SHARE_TOLERANCE,
  type IdentityCheck,
  type SubnetPipelineInput,
} from "./emission-pipeline.ts";
import { blockEmissionForIssuance } from "./block-emission.ts";
import type { FieldSources } from "./field-provenance.ts";

/** Rao per TAO. */
const RAO_PER_TAO = 1_000_000_000n;

/**
 * TAO (as a JSON number or an exact decimal string) to exact rao.
 *
 * Postgres NUMERIC and the artifact's own TAO fields both arrive as decimal
 * strings often enough that parsing them as strings is the only way to keep
 * #2921's "rao exact in BigInt space" promise -- `Number(x) * 1e9` rounds, and
 * the aggregate identity is checked at a 1000-rao tolerance that a float
 * round-trip across 128 subnets can eat into for no reason.
 */
export function taoToRao(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    // Route through the string form rather than multiplying: the point is to
    // avoid the float multiply, and toFixed(9) is exactly rao precision.
    return taoToRao(value.toFixed(9));
  }
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(9, "0"));
  return whole * RAO_PER_TAO + frac;
}

/** One subnet's row as the economics artifact carries it. */
export interface EconomicsPipelineRow {
  netuid: number;
  moving_price_pinned?: number | null;
  miner_burned_fraction?: number | null;
  emission_enabled?: boolean | null;
  subtoken_enabled?: boolean | null;
  registration_allowed_pinned?: boolean | null;
  first_emission_block?: number | null;
  tao_in_emission_tao?: number | string | null;
  excess_tao?: number | string | null;
  alpha_in_emission?: number | string | null;
  alpha_out_emission?: number | string | null;
}

export interface DecompositionChainState {
  block: number;
  block_hash: string;
  total_issuance_tao: number;
  emission_gate_bar: number | null;
  emission_bar_quantile: number | null;
  emission_gate_exponent: number | null;
}

/**
 * Where each published value came from. ADR 0023 decision 5: provenance is a
 * contract, so the surface names the storage item behind every measurement and
 * marks every derived value as OURS rather than the chain's.
 *
 * The shape is src/field-provenance.ts's, shared with the other surfaces that
 * publish a `field_sources` map (#9078) — this one was first, not special.
 */
export const EMISSION_FIELD_SOURCES = {
  emission_share: {
    kind: "measured",
    storage: "SubtensorModule.SubnetMovingPrice",
  },
  miner_burned: { kind: "measured", storage: "SubtensorModule.MinerBurned" },
  emission_enabled: {
    kind: "measured",
    storage: "SubtensorModule.SubnetEmissionEnabled",
  },
  tao_in_emission: {
    kind: "measured",
    storage: "SubtensorModule.SubnetTaoInEmission",
  },
  excess_tao: { kind: "measured", storage: "SubtensorModule.SubnetExcessTao" },
  alpha_in_emission: {
    kind: "measured",
    storage: "SubtensorModule.SubnetAlphaInEmission",
  },
  alpha_out_emission: {
    kind: "measured",
    storage: "SubtensorModule.SubnetAlphaOutEmission",
  },
  weighted_share: { kind: "reconstructed", storage: null },
  gated_share: { kind: "reconstructed", storage: null },
  final_share: { kind: "reconstructed", storage: null },
  liquidity_fraction: { kind: "reconstructed", storage: null },
  gate_delta: { kind: "reconstructed", storage: null },
  distance_to_bar: { kind: "reconstructed", storage: null },
  // The three below were missing (or wrong) until tests/field-provenance.test.ts
  // checked this map against the row schema it describes. `tao_emission` was
  // declared here and served nowhere -- provenance for a field that does not
  // exist -- while `tao_total` and `ineligible_reason`, both served on every
  // row, had no entry at all.
  //
  // `tao_total` is tao_in_emission + excess_tao, our sum of two reads.
  // `ineligible_reason` is stage 0's verdict, decided from netuid,
  // first_emission_block, subtoken_enabled and registration_allowed together
  // (src/emission-pipeline.ts's ineligibleReason) -- four inputs, one string
  // the chain never publishes.
  tao_total: { kind: "reconstructed", storage: null },
  ineligible_reason: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

export interface SubnetDecomposition {
  netuid: number;
  ineligible_reason: string | null;
  /** Stage 1. Named to match the published `emission_share` (ADR 0023 #1). */
  emission_share: number | null;
  miner_burned: number;
  weighted_share: number | null;
  gated_share: number | null;
  emission_enabled: boolean;
  final_share: number | null;
  gate_delta: number | null;
  distance_to_bar: number | null;
  /** Stage 8, measured. */
  tao_in_emission: number | null;
  /** Stage 7, measured. */
  excess_tao: number | null;
  /** Their sum -- the subnet's whole TAO intake this block. */
  tao_total: number | null;
  /** `tao_in_emission / tao_total`. The headline per-subnet number. */
  liquidity_fraction: number | null;
  alpha_in_emission: number | null;
  alpha_out_emission: number | null;
}

export interface EmissionDecomposition {
  chain_state: DecompositionChainState;
  block_emission_tao: number | null;
  block_emission_halvings: number | null;
  subnets: SubnetDecomposition[];
  aggregate: {
    eligible_count: number;
    disabled_count: number;
    tao_in_emission: number;
    excess_tao: number;
    tao_total: number;
    /** The network split nobody publishes: pool injection vs chain buys. */
    liquidity_fraction: number | null;
    /** Σ final_share. 1.0 to float precision, or the surface is broken. */
    total_final_share: number;
  };
  /**
   * The four identities, evaluated on the rows above. `verified` is false when
   * any failed -- see this module's header for why that is checked here rather
   * than read from a flag.
   */
  verification: {
    verified: boolean;
    checks: IdentityCheck[];
    subnet_share_tolerance: number;
    aggregate_tolerance_rao: string;
  };
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** rao -> TAO without a float multiply on the way in. */
function raoToTao(rao: bigint): number {
  const whole = rao / RAO_PER_TAO;
  const frac = rao % RAO_PER_TAO;
  return Number(whole) + Number(frac) / 1e9;
}

export function buildEmissionDecomposition(input: {
  subnets: readonly EconomicsPipelineRow[];
  chainState: DecompositionChainState;
}): EmissionDecomposition {
  const { chainState } = input;

  // theta AS STORED at this block, never recomputed. Recomputing would gate
  // with a number the chain was not using for up to 359 blocks.
  const theta = chainState.emission_gate_bar ?? 0;
  // Absent h is the runtime default 3, NOT 0 -- h = 0 makes the Hill gate a
  // constant 0.5 for every subnet.
  const exponent =
    chainState.emission_gate_exponent ?? DEFAULT_EMISSION_GATE_EXPONENT;

  const inputs: SubnetPipelineInput[] = input.subnets.map((row) => ({
    netuid: row.netuid,
    moving_price: numberOrNull(row.moving_price_pinned) ?? 0,
    miner_burned: numberOrNull(row.miner_burned_fraction) ?? 0,
    // Absent means ENABLED on chain -- the default that inverts if a missing
    // value is read as false.
    emission_enabled: row.emission_enabled ?? true,
    first_emission_block: numberOrNull(row.first_emission_block),
    subtoken_enabled: row.subtoken_enabled ?? false,
    registration_allowed: row.registration_allowed_pinned ?? false,
  }));

  const reconstruction = reconstructEmissionPipeline({
    subnets: inputs,
    parameters: { theta, exponent },
  });
  const stagesByNetuid = new Map(
    reconstruction.subnets.map((row) => [row.netuid, row]),
  );

  let sumTaoInRao = 0n;
  let sumExcessRao = 0n;
  let totalFinalShare = 0;

  const observed: {
    netuid: number;
    emission_enabled: boolean;
    tao_in_emission_rao: bigint;
    excess_tao_rao: bigint;
  }[] = [];

  const subnets: SubnetDecomposition[] = input.subnets.map((row) => {
    const stages = stagesByNetuid.get(row.netuid)!;
    const taoInRao = taoToRao(row.tao_in_emission_tao);
    const excessRao = taoToRao(row.excess_tao);
    sumTaoInRao += taoInRao ?? 0n;
    sumExcessRao += excessRao ?? 0n;
    totalFinalShare += stages.final_share ?? 0;

    observed.push({
      netuid: row.netuid,
      emission_enabled: stages.emission_enabled,
      tao_in_emission_rao: taoInRao ?? 0n,
      excess_tao_rao: excessRao ?? 0n,
    });

    // Null, not zero, when either channel was not captured: their sum is only
    // a subnet's intake if both were actually read.
    const totalRao =
      taoInRao !== null && excessRao !== null ? taoInRao + excessRao : null;
    return {
      netuid: row.netuid,
      ineligible_reason: stages.ineligible_reason,
      emission_share: stages.price_share,
      miner_burned: stages.miner_burned,
      weighted_share: stages.weighted_share,
      gated_share: stages.gated_share,
      emission_enabled: stages.emission_enabled,
      final_share: stages.final_share,
      gate_delta: stages.gate_delta,
      distance_to_bar: stages.distance_to_bar,
      tao_in_emission: taoInRao === null ? null : raoToTao(taoInRao),
      excess_tao: excessRao === null ? null : raoToTao(excessRao),
      tao_total: totalRao === null ? null : raoToTao(totalRao),
      // Zero intake is a real state (a deeply gated or disabled subnet), and
      // 0/0 is not a fraction -- null rather than NaN.
      liquidity_fraction:
        totalRao === null || totalRao === 0n
          ? null
          : Number(taoInRao!) / Number(totalRao),
      alpha_in_emission: numberOrNull(row.alpha_in_emission),
      alpha_out_emission: numberOrNull(row.alpha_out_emission),
    };
  });

  const issuanceRao = taoToRao(chainState.total_issuance_tao);
  const blockEmission =
    issuanceRao === null ? null : blockEmissionForIssuance(issuanceRao);

  const checks = blockEmission
    ? emissionIdentityChecks({
        subnets: observed,
        reconstruction,
        // rao_per_block, not tao_per_block * 1e9: the identity is checked at a
        // 1000-rao tolerance, and there is no reason to spend any of it on a
        // float round-trip when the exact value is right there.
        blockEmissionRao: blockEmission.rao_per_block,
        quantile: chainState.emission_bar_quantile ?? 0,
      })
    : [
        {
          name: "block_emission_derivable",
          ok: false,
          detail:
            "could not derive block emission from TotalIssuance -- the " +
            "identity's right-hand side is unknown, so nothing is verified",
        },
      ];

  const sumTotalRao = sumTaoInRao + sumExcessRao;
  return {
    chain_state: chainState,
    block_emission_tao: blockEmission?.tao_per_block ?? null,
    block_emission_halvings: blockEmission?.halvings ?? null,
    subnets,
    aggregate: {
      eligible_count: reconstruction.eligible_count,
      disabled_count: reconstruction.disabled_count,
      tao_in_emission: raoToTao(sumTaoInRao),
      excess_tao: raoToTao(sumExcessRao),
      tao_total: raoToTao(sumTotalRao),
      liquidity_fraction:
        sumTotalRao === 0n ? null : Number(sumTaoInRao) / Number(sumTotalRao),
      total_final_share: totalFinalShare,
    },
    verification: {
      verified: checks.every((check) => check.ok),
      checks,
      subnet_share_tolerance: SUBNET_SHARE_TOLERANCE,
      aggregate_tolerance_rao: AGGREGATE_IDENTITY_TOLERANCE_RAO.toString(),
    },
  };
}
