// #10446: how much of a subnet's emission its external revenue covers.
//
// Two numbers, and they are reciprocals:
//
//   coverage_ratio   = revenue / emission     "12.5% covered"
//   subsidy_multiple = emission / revenue     "8:1", the ecosystem's own phrasing
//
// Both are published because both get quoted, and a reader given only one
// reliably invents the other wrong.
//
// The denominator is `tao_total` -- SubnetTaoInEmission + SubnetExcessTao, the
// TAO the network directs into a subnet. Chosen because it is fully MEASURED
// (get_emission_pipeline reads both from chain storage) and because it
// reconciles with the "$52M a year" framing the ecosystem already uses. The
// alternates are computed alongside and never silently substituted: a ratio
// whose denominator changed without saying so is worse than no ratio.
//
// THE RULE THIS MODULE EXISTS TO HOLD: absent revenue is null, never zero. 127
// of 129 subnets have no readable revenue figure. Rendering them as "0% covered"
// would be a false claim about every one of them, at scale, and it is the single
// most likely way this feature does harm.

/** One day of blocks at 12s. Mirrors validator-economics.ts's own constant. */
export const BLOCKS_PER_DAY = 7200;

/** Share of alpha emission paid to the subnet owner. SubnetOwnerCut is
 * 11796/65535 -- 18%, not 1/6. The difference is ~6 TAO/day on SN64. */
export const OWNER_CUT = 11796 / 65535;

export interface CoverageInput {
  /** `tao_total` for one block: SubnetTaoInEmission + SubnetExcessTao. */
  tao_total_per_block: number;
  /** Alpha paid out per block, for the alternate denominator. */
  alpha_out_per_block?: number;
  /** TAO-denominated alpha price, for the alternate denominator. */
  alpha_price_tao?: number;
  usd_per_tao: number;
  /** Days the window spans. */
  window_days: number;
  /** Summed external revenue over the window, from Tier A + B surfaces only.
   * NULL means not observed -- which is not the same as zero. */
  revenue_usd: number | null;
}

export interface CoverageBasis {
  tao: number;
  usd: number;
}

export interface CoverageResult {
  window_days: number;
  emission: {
    /** The published denominator. */
    basis: "tao_total";
    tao: number;
    usd: number;
    /** Computed and published, never silently substituted for the basis. */
    alternates: {
      alpha_out_priced: CoverageBasis | null;
      owner_take: CoverageBasis;
    };
  };
  revenue_usd: number | null;
  coverage_ratio: number | null;
  subsidy_multiple: number | null;
  verification: {
    verified: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
}

function round(value: number, places = 9): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Compute one subnet's coverage over a window.
 *
 * Throws on a non-finite or negative input rather than propagating NaN: a NaN
 * ratio serialises as null, which is the SAME output as "revenue not observed",
 * and those two must never be confusable.
 */
export function computeCoverage(input: CoverageInput): CoverageResult {
  const {
    tao_total_per_block,
    alpha_out_per_block,
    alpha_price_tao,
    usd_per_tao,
    window_days,
    revenue_usd,
  } = input;

  for (const [name, value] of [
    ["tao_total_per_block", tao_total_per_block],
    ["usd_per_tao", usd_per_tao],
    ["window_days", window_days],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite, non-negative number`);
    }
  }
  if (
    revenue_usd !== null &&
    (!Number.isFinite(revenue_usd) || revenue_usd < 0)
  ) {
    throw new Error(
      "revenue_usd must be null or a finite, non-negative number",
    );
  }

  const blocks = BLOCKS_PER_DAY * window_days;
  const emissionTao = tao_total_per_block * blocks;
  const emissionUsd = emissionTao * usd_per_tao;

  const alphaPriced =
    typeof alpha_out_per_block === "number" &&
    Number.isFinite(alpha_out_per_block) &&
    typeof alpha_price_tao === "number" &&
    Number.isFinite(alpha_price_tao)
      ? {
          tao: round(alpha_out_per_block * blocks * alpha_price_tao),
          usd: round(
            alpha_out_per_block * blocks * alpha_price_tao * usd_per_tao,
            6,
          ),
        }
      : null;

  // The owner's 18% of the SAME denominator, so the two are comparable. Priced
  // off tao_total rather than alpha so it does not silently change basis.
  const ownerTake: CoverageBasis = {
    tao: round(emissionTao * OWNER_CUT),
    usd: round(emissionTao * OWNER_CUT * usd_per_tao, 6),
  };

  // Null propagates. Zero emission also yields null rather than Infinity: a
  // subnet the gate is emitting nothing to has no ratio, and Infinity would
  // render as the worst possible subsidy rather than as "not applicable".
  const haveRevenue = revenue_usd !== null;
  const coverage =
    haveRevenue && emissionUsd > 0 ? round(revenue_usd / emissionUsd) : null;
  const subsidy =
    haveRevenue && revenue_usd > 0 && emissionUsd > 0
      ? round(emissionUsd / revenue_usd)
      : null;

  const checks: CoverageResult["verification"]["checks"] = [
    {
      name: "ratios_are_reciprocal",
      ok:
        coverage === null ||
        subsidy === null ||
        Math.abs(coverage * subsidy - 1) < 1e-6,
      detail:
        coverage === null || subsidy === null
          ? "one or both ratios are null, so there is nothing to reconcile"
          : `coverage x subsidy = ${round(coverage * subsidy, 6)}`,
    },
    {
      name: "absent_revenue_is_null_not_zero",
      ok: haveRevenue || (coverage === null && subsidy === null),
      detail: haveRevenue
        ? "revenue observed"
        : "revenue not observed, so both ratios are null",
    },
    {
      name: "emission_is_positive",
      ok: emissionUsd > 0,
      detail: `emission ${round(emissionTao, 6)} TAO over ${window_days} day(s)`,
    },
  ];

  return {
    window_days,
    emission: {
      basis: "tao_total",
      tao: round(emissionTao, 6),
      usd: round(emissionUsd, 6),
      alternates: { alpha_out_priced: alphaPriced, owner_take: ownerTake },
    },
    revenue_usd: revenue_usd === null ? null : round(revenue_usd, 6),
    coverage_ratio: coverage,
    subsidy_multiple: subsidy,
    verification: { verified: checks.every((c) => c.ok), checks },
  };
}
