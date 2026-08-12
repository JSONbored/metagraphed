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
//
// THE RULE BINDS THE PRICE AS HARD AS IT BINDS THE REVENUE, and did not
// revenue. `usd_per_tao` arrived here already coalesced to 0, so every USD leg
// -- `emission.usd` and both `alternates` branches -- published a literal 0 for
// all 129 subnets while `emission.tao` carried a real figure. Read straight,
// that is "the network directs 441 TAO into this subnet and that is worth
// nothing". The rate is now nullable end to end, and an unpriceable window
// serialises null in every USD field or none of them.

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
  /** The rate to price the denominator through. NULL means the index could not
   * price this moment -- ADR 0025's `insufficient_pools`, a stale index, or no
   * reading at all. It is NOT a rate of zero, and every USD field downstream
   * serialises null rather than 0 because of it. */
  usd_per_tao: number | null;
  /** Days the window spans. */
  window_days: number;
  /** Summed external revenue over the window, from Tier A + B surfaces only.
   * NULL means not observed -- which is not the same as zero. */
  revenue_usd: number | null;
}

export interface CoverageBasis {
  tao: number;
  /** Null when there is no rate to price the TAO leg through. */
  usd: number | null;
}

export interface CoverageResult {
  window_days: number;
  emission: {
    /** The published denominator. */
    basis: "tao_total";
    tao: number;
    /** Null when unpriceable. Never 0 -- see the header rule. */
    usd: number | null;
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

function roundTo(value: number, places = 9): number {
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
    ["window_days", window_days],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite, non-negative number`);
    }
  }
  // Null is a legitimate input -- "no rate" -- but a present rate still has to
  // be a real one. A NaN or negative price would otherwise reach the payload as
  // a NaN that serialises to null, which is the SAME output as "unpriceable"
  // and must never be confusable with it.
  if (
    usd_per_tao !== null &&
    (!Number.isFinite(usd_per_tao) || usd_per_tao < 0)
  ) {
    throw new Error(
      "usd_per_tao must be null or a finite, non-negative number",
    );
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
  /** Price a TAO leg, or decline. The ONE place the rate is applied, so an
   * unpriceable window cannot be null in one field and 0 in the next. */
  const priced = (tao: number): number | null =>
    usd_per_tao === null ? null : roundTo(tao * usd_per_tao, 6);
  const emissionUsd = priced(emissionTao);

  const alphaPriced =
    typeof alpha_out_per_block === "number" &&
    Number.isFinite(alpha_out_per_block) &&
    typeof alpha_price_tao === "number" &&
    Number.isFinite(alpha_price_tao)
      ? {
          tao: roundTo(alpha_out_per_block * blocks * alpha_price_tao),
          usd: priced(alpha_out_per_block * blocks * alpha_price_tao),
        }
      : null;

  // The owner's 18% of the SAME denominator, so the two are comparable. Priced
  // off tao_total rather than alpha so it does not silently change basis.
  const ownerTake: CoverageBasis = {
    tao: roundTo(emissionTao * OWNER_CUT),
    usd: priced(emissionTao * OWNER_CUT),
  };

  // Null propagates. Zero emission also yields null rather than Infinity: a
  // subnet the gate is emitting nothing to has no ratio, and Infinity would
  // render as the worst possible subsidy rather than as "not applicable".
  // An unpriceable window has no ratios either: both sides must be USD, and
  // there is no rate to bring the denominator over.
  const haveRevenue = revenue_usd !== null;
  const priceable = emissionUsd !== null && emissionUsd > 0;
  const coverage =
    haveRevenue && priceable ? roundTo(revenue_usd / emissionUsd) : null;
  const subsidy =
    haveRevenue && revenue_usd > 0 && priceable
      ? roundTo(emissionUsd / revenue_usd)
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
          : `coverage x subsidy = ${roundTo(coverage * subsidy, 6)}`,
    },
    {
      name: "absent_revenue_is_null_not_zero",
      ok: haveRevenue || (coverage === null && subsidy === null),
      detail: haveRevenue
        ? "revenue observed"
        : "revenue not observed, so both ratios are null",
    },
    {
      // Tests the TAO leg, which is what the name and the detail have always
      // said. It used to test `emissionUsd > 0`, so an unpriceable window
      // reported a subnet with real emission as failing "emission_is_positive"
      // -- a claim about the emission, sourced from the price.
      name: "emission_is_positive",
      ok: emissionTao > 0,
      detail: `emission ${roundTo(emissionTao, 6)} TAO over ${window_days} day(s)`,
    },
    {
      // The price-side twin of absent_revenue_is_null_not_zero, and the same
      // rule: a rate we do not have is null, never 0. `emission.usd: 0` next to
      // a positive `emission.tao` is a claim that the network emits nothing of
      // value, published at network scale.
      name: "unpriceable_emission_is_null_not_zero",
      ok: usd_per_tao !== null || emissionUsd === null,
      detail:
        usd_per_tao === null
          ? "no TAO/USD rate, so every USD leg is null"
          : `priced through ${usd_per_tao} USD/TAO`,
    },
  ];

  return {
    window_days,
    emission: {
      basis: "tao_total",
      tao: roundTo(emissionTao, 6),
      usd: emissionUsd,
      alternates: { alpha_out_priced: alphaPriced, owner_take: ownerTake },
    },
    revenue_usd: revenue_usd === null ? null : roundTo(revenue_usd, 6),
    coverage_ratio: coverage,
    subsidy_multiple: subsidy,
    verification: { verified: checks.every((c) => c.ok), checks },
  };
}
