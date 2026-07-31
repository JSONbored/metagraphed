// #8747: block emission, derived from total issuance rather than read from the
// stale `BlockEmission` storage item.
//
// DO NOT "SIMPLIFY" THIS INTO A STORAGE READ. `BlockEmission`
// (twox128 = 34ebdb22bbd04c61ef98f1974907c68d) reads 0x00ca9a3b00000000 =
// 1.0 TAO and has not been updated since the network passed its first halving.
// The live value is recomputed from issuance every block and is 0.5 TAO. Every
// figure in the #8739 emission pipeline is a share OF block emission, so
// reading the storage item makes all of them wrong by exactly 2x.
//
// The formula is get_block_emission_for_issuance
// (pallets/subtensor/src/coinbase/block_emission.rs, v440):
//
//   residual = log2( 1 / (1 - issuance / (2 * 10_500_000_000_000_000)) )
//   halvings = floor(residual)
//   emission = DefaultBlockEmission / 2^halvings
//
// Confirmed live at 11,180,113.34 TAO issued: ratio 0.532386, residual
// 1.096611, one halving, 0.5 TAO/block -- which the chain independently
// agrees with, since Sum(SubnetTaoInEmission + SubnetExcessTao) over all
// subnets is exactly 0.500000 TAO/block.

/** `DefaultBlockEmission` in rao — 1 TAO, the pre-halving rate. */
export const DEFAULT_BLOCK_EMISSION_RAO = 1_000_000_000n;

/**
 * The supply the halving curve is measured against, in rao.
 *
 * `2 * 10_500_000_000_000_000`, a CONSTANT in the runtime source — not a
 * storage lookup. `TotalSupply` reads `None` on chain, so anything trying to
 * fetch this would get null and silently fall back to something wrong.
 */
export const HALVING_SUPPLY_DENOMINATOR_RAO = 21_000_000_000_000_000n;

/**
 * Emission floors at zero after this many halvings, which bounds the search.
 *
 * `DEFAULT_BLOCK_EMISSION_RAO >> 30n` is already 0, so nothing beyond this can
 * change the answer. A bound also means the loop below cannot spin on a
 * pathological input.
 */
const MAX_HALVINGS = 64;

export interface BlockEmission {
  /** TAO emitted per block at the current halving. */
  tao_per_block: number;
  /** How many halvings have occurred. A step, never interpolated. */
  halvings: number;
  /** rao per block, exact — the value the arithmetic actually produced. */
  rao_per_block: bigint;
}

/**
 * Block emission at a given total issuance, or null when issuance is unusable.
 *
 * ENTIRELY IN BIGINT — there is no floating-point step, and that is not
 * fastidiousness. The halving count is `floor(log2(1 / (1 - r)))` for
 * `r = issuance / denominator`, and evaluating that through doubles cannot
 * resolve the boundary: one rao either side of it differs in `r` by ~5e-17,
 * below the ~1.1e-16 spacing of doubles near 0.5, so both land on the same
 * value and the step is invisible. Since the result is a STEP function, being
 * off by one there halves or doubles every downstream figure in #8739.
 *
 * The condition rearranges into exact integer arithmetic:
 *
 *   floor(log2(1 / (1 - r))) >= n
 *     <=> 1 - r <= 2^-n
 *     <=> r >= 1 - 2^-n
 *     <=> issuance * 2^n >= denominator * (2^n - 1)
 *
 * So the answer is the largest `n` satisfying that — computed by counting up,
 * with no division and no rounding anywhere. This is the #2921 exact-integer
 * rule taken to its conclusion rather than approximated with a wider scale
 * factor.
 *
 * Returns null rather than a guess for issuance at or beyond the denominator:
 * that is `r >= 1`, where the curve is undefined. Unreachable on a live chain,
 * and a caller that somehow sees it should report "unknown" rather than an
 * emission figure it invented.
 */
export function blockEmissionForIssuance(
  issuanceRao: bigint | null | undefined,
): BlockEmission | null {
  if (typeof issuanceRao !== "bigint") return null;
  if (issuanceRao < 0n) return null;
  if (issuanceRao >= HALVING_SUPPLY_DENOMINATOR_RAO) return null;

  let halvings = 0;
  while (halvings < MAX_HALVINGS) {
    const next = BigInt(halvings + 1);
    const pow = 1n << next;
    if (issuanceRao * pow < HALVING_SUPPLY_DENOMINATOR_RAO * (pow - 1n)) break;
    halvings += 1;
  }

  const raoPerBlock = DEFAULT_BLOCK_EMISSION_RAO >> BigInt(halvings);

  return {
    tao_per_block: Number(raoPerBlock) / 1e9,
    halvings,
    rao_per_block: raoPerBlock,
  };
}
