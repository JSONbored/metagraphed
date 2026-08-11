// #10484: how much owner cut a subnet accrued, per day.
//
// The network hands every subnet owner a share of alpha emission,
// unconditionally. This is the ACCRUAL half -- what was credited. Where it went
// afterwards is #10485, and the two are deliberately separate: the amount is
// knowable from emission alone, the destination is not.
//
// THREE THINGS THIS GETS RIGHT THAT A NAIVE VERSION DOES NOT.
//
// 1. The cut is 18%, not one sixth. SubnetOwnerCut is 11796/65535 = 0.17999...
//    At SN64's scale the difference between 16.7% and 18% is ~6 TAO/day
//    (~$1.2k/day), which would surface as an unexplained residual in exactly
//    the reconciliation #10440 is built on.
//
// 2. The rate is READ, not hardcoded -- and reading it correctly is the whole
//    difficulty, because `SubtensorModule.SubnetOwnerCut` is UNSET on chain.
//    src/network-parameters.ts resolves absent to the runtime default and
//    publishes raw and effective separately; this module takes the effective
//    share and refuses to invent one. A caller that passes 0 because it read
//    the raw field gets zero accrual, which is why `owner_cut` is required and
//    validated rather than defaulted here.
//
// 3. The cut is paid in ALPHA. Pricing it needs the subnet's own alpha price at
//    the instant it accrued, not a window average and not the TAO figure --
//    alpha is a different token per subnet, and 1 alpha on two subnets is two
//    different values.
//
// ZERO AND NULL ARE DIFFERENT ANSWERS HERE, as everywhere in this epic. A
// subnet with `owner_cut_enabled: false` genuinely accrues nothing and reports
// 0 with a stated reason. A subnet whose price or emission we could not read
// reports null. Collapsing them would say "this owner earned nothing" about a
// subnet we simply failed to measure.

/** One day of blocks at 12s. Mirrors src/revenue-coverage.ts's own constant. */
export const BLOCKS_PER_DAY = 7200;

export interface OwnerCutAccrualInput {
  netuid: number;
  /** Alpha emitted to the subnet per block, from the economics capture. */
  alpha_out_per_block: number | null | undefined;
  /** The subnet's alpha price in TAO, for pricing the alpha share. */
  alpha_price_tao: number | null | undefined;
  /** TAO/USD at the instant being priced. Null yields a null USD leg only. */
  usd_per_tao?: number | null;
  /**
   * The share the runtime applies -- network-parameters'
   * `subnet_owner_cut_effective`, NOT the raw numerator. Null when the
   * parameter could not be read, which makes the whole accrual null rather
   * than silently 18%.
   */
  owner_cut: number | null | undefined;
  /**
   * The subnet's own `owner_cut_enabled` hyperparameter. FALSE accrues zero for
   * a stated reason; NULL/undefined means we did not read it and must not
   * assume either way.
   */
  owner_cut_enabled?: boolean | null;
  /** Days this row covers. Defaults to one. */
  window_days?: number;
}

export interface OwnerCutAccrual {
  netuid: number;
  window_days: number;
  /** The share applied, echoed so a reader never has to assume 18%. */
  owner_cut: number | null;
  /** Alpha credited over the window. Null when unmeasurable. */
  alpha: number | null;
  /** That alpha priced in TAO. Null when no alpha price resolves. */
  tao: number | null;
  /** That TAO priced in USD. Null when no rate resolves. */
  usd: number | null;
  /** Did the subnet accrue at all, as far as we can tell? */
  accrues: boolean;
  /** Why the figures are null or zero. Null when they are neither. */
  reason: string | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, places = 9): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * One subnet's accrual over a window.
 *
 * Never throws: this runs over 128 subnets at a time and one unreadable row
 * must not take the other 127 with it.
 */
export function computeOwnerCutAccrual(
  input: OwnerCutAccrualInput,
): OwnerCutAccrual {
  const window_days = finite(input.window_days) ?? 1;
  const owner_cut = finite(input.owner_cut);
  const base: OwnerCutAccrual = {
    netuid: input.netuid,
    window_days,
    owner_cut,
    alpha: null,
    tao: null,
    usd: null,
    accrues: false,
    reason: null,
  };

  // A DISABLED cut is a real zero, and the only zero this function produces.
  // "The owner receives nothing" is a fact about the subnet; every other empty
  // answer below is a fact about our reading of it.
  if (input.owner_cut_enabled === false) {
    return {
      ...base,
      alpha: 0,
      tao: 0,
      usd: 0,
      accrues: false,
      reason: "owner_cut_enabled is false, so nothing accrues",
    };
  }
  if (owner_cut === null || owner_cut < 0) {
    return { ...base, reason: "owner cut share not read" };
  }
  const alphaPerBlock = finite(input.alpha_out_per_block);
  if (alphaPerBlock === null || alphaPerBlock < 0) {
    return { ...base, reason: "alpha_out_emission not read" };
  }

  const alpha = alphaPerBlock * BLOCKS_PER_DAY * window_days * owner_cut;
  const alphaPrice = finite(input.alpha_price_tao);
  // A missing alpha price leaves the ALPHA figure standing. It is the measured
  // quantity; TAO and USD are conversions of it, and dropping the measurement
  // because a conversion is unavailable throws away the part we actually know.
  if (alphaPrice === null || alphaPrice < 0) {
    return {
      ...base,
      alpha: round(alpha),
      accrues: alpha > 0,
      reason: "no alpha price, so the TAO and USD legs are unpriced",
    };
  }
  const tao = alpha * alphaPrice;
  const usdRate = finite(input.usd_per_tao);
  return {
    ...base,
    alpha: round(alpha),
    tao: round(tao),
    usd: usdRate !== null && usdRate > 0 ? round(tao * usdRate, 6) : null,
    accrues: alpha > 0,
    reason:
      usdRate !== null && usdRate > 0
        ? null
        : "no TAO/USD rate, so the USD leg is unpriced",
  };
}

/**
 * The whole network's accrual for one window.
 *
 * A row we cannot read is INCLUDED with null figures rather than dropped --
 * omitting it would make the measured set look like the whole network, the
 * same rule the coverage table holds.
 */
export function computeOwnerCutAccrualSeries(
  rows: Array<Record<string, unknown>> | null | undefined,
  options: {
    owner_cut: number | null | undefined;
    usd_per_tao?: number | null;
    window_days?: number;
    /** netuid -> owner_cut_enabled, where it was read. */
    enabledByNetuid?: Map<number, boolean>;
  },
): OwnerCutAccrual[] {
  const out: OwnerCutAccrual[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid)) continue;
    out.push(
      computeOwnerCutAccrual({
        netuid,
        alpha_out_per_block: row?.alpha_out_emission as number | null,
        alpha_price_tao: row?.alpha_price_tao as number | null,
        usd_per_tao: options.usd_per_tao ?? null,
        owner_cut: options.owner_cut,
        owner_cut_enabled: options.enabledByNetuid?.get(netuid) ?? null,
        window_days: options.window_days,
      }),
    );
  }
  return out;
}
