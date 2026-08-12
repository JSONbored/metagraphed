// Rao-space accumulation: the one implementation.
//
// 1 TAO = 1e9 rao. Summing hundreds to thousands of per-UID / per-account TAO
// values with plain `+=` compounds float rounding error across the accumulation
// even when every individual value is exact (metagraphed#2922, #2933), so the
// codebase sums in BigInt rao space and converts back once at the end.
//
// ## WHY THIS MODULE EXISTS
//
// Nine modules each carried a private copy of these two functions, every one of
// them annotated as "a deliberate byte-for-byte copy per this codebase's
// per-module rounding-helper convention". They were not byte-for-byte, and the
// convention was a description of the drift rather than a reason for it. There
// were FOUR different implementations:
//
//   1. unguarded  -- accounts-list, movers, metagraph-neurons, chain-yield,
//      subnet-yield: `BigInt(Math.round(tao * 1e9))`, which THROWS RangeError
//      on a NaN or Infinite input.
//   2. input-guarded -- subnet-idle-stake, domain-summary, concentration:
//      `Number.isFinite(n) ? ... : 0n`. Still throws, because a huge-but-finite
//      input overflows `n * 1e9` to Infinity AFTER the guard has passed.
//   3. output-guarded -- counterparties: checks the post-multiply value. The
//      only one that cannot throw.
//
// counterparties.ts found the overflow, fixed it, and wrote down why. The fix
// never reached the other eight. That is the failure duplication produces, and
// it is why this is now one function: the guard belongs on the value that is
// actually handed to `BigInt`, and there should be exactly one place to get
// that right.
//
// `src/lib/stats.ts` already establishes that shared numeric helpers are
// welcome here; rounding was simply never moved.

/** 1 TAO in rao, as a BigInt for exact integer division. */
export const RAO_PER_TAO = 1_000_000_000n;

/**
 * A TAO amount as exact rao, or `0n` when it cannot be represented.
 *
 * Takes `unknown` so a raw store cell can be passed straight in — several
 * callers read numeric columns that arrive as strings, and `Number(null)` is
 * `0` rather than a throw.
 *
 * THE GUARD IS ON THE POST-MULTIPLY VALUE, not the input. `Number.isFinite`
 * on the input alone still admits `Number.MAX_VALUE`, whose `* 1e9` is
 * `Infinity`, and `BigInt(Infinity)` throws a RangeError that would take down
 * an entire response rather than dropping one row. Clamping to `0n` preserves
 * the behaviour the pre-BigInt `Math.round` accumulation had.
 */
export function toRaoBig(taoValue: unknown): bigint {
  const n = typeof taoValue === "number" ? taoValue : Number(taoValue);
  const rao = Math.round(n * 1e9);
  return Number.isFinite(rao) ? BigInt(rao) : 0n;
}

/**
 * Exact rao back to TAO.
 *
 * Split into whole and fractional parts rather than `Number(rao) / 1e9`: a
 * total above 2^53 rao (~9.007M TAO, which several network-wide sums exceed)
 * loses precision in the direct conversion.
 */
export function raoBigToTao(rao: bigint): number {
  return Number(rao / RAO_PER_TAO) + Number(rao % RAO_PER_TAO) / 1e9;
}
