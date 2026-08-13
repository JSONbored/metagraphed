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

/**
 * 1 TAO in rao, as a NUMBER.
 *
 * The same constant as `RAO_PER_TAO` above in a different type, because both
 * are genuinely needed: bigint for exact accumulation, number for the 9-decimal
 * rounding below and for the many `value / 1e9` conversions that never enter
 * rao space at all. Fourteen modules declared one or the other privately and
 * `src/movers.ts` declared BOTH, four lines apart.
 */
export const RAO_PER_TAO_NUMBER = 1e9;

/**
 * Round to 9 decimal places -- rao precision, the finest TAO can express.
 *
 * ## THREE FUNCTIONS, NOT ONE, AND THAT IS THE POINT
 *
 * Six modules declared `round9`, described in their own comments as matching
 * each other ("Matches src/chain-yield.ts / src/subnet-yield.ts's own round9
 * exactly"). They did not match. On the same non-finite input they returned
 * three different answers:
 *
 *   - `NaN` / `Infinity`  chain-yield        (bare `Number()`, unguarded)
 *   - `0`                 subnet-yield       (via a local `toNumber()`)
 *   - `null`              metagraph-neurons  (explicit non-finite check)
 *
 * That is not hypothetical. Both yield modules compute `round9(emission /
 * stake)`, so a subnet with zero stake produces `Infinity` on one surface and
 * `0` on the other, from the same arithmetic.
 *
 * Collapsing them onto whichever is most common would hand some call site the
 * other's behaviour silently, which is the failure this refactor exists to
 * remove rather than repeat. So each behaviour keeps a name that says what it
 * does, and each caller keeps the one it had. Choosing BETWEEN them is a
 * separate decision about what a zero-stake subnet should report, and it wants
 * its own change and its own issue.
 */
export function round9(value: number): number {
  return Math.round(value * RAO_PER_TAO_NUMBER) / RAO_PER_TAO_NUMBER;
}

/**
 * `round9`, but a non-finite input reads as 0 rather than propagating.
 *
 * Replaces subnet-yield's `round9(toNumber(value))`. Note that 0 is a CLAIM --
 * "this yield is zero" -- where the input was actually unusable; preserved
 * because changing it is a product decision, not a refactor.
 */
export function round9OrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : 0;
}

/**
 * `round9`, but a non-finite or absent input reads as null.
 *
 * Replaces metagraph-neurons' variant. The honest one of the three: it says
 * "not computable" instead of asserting a number nobody measured.
 */
export function round9OrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

/**
 * A value as a finite number, or 0.
 *
 * Nine modules declared this privately and all nine were behaviourally
 * identical -- the only difference between them was whether the local was
 * called `n` or `parsed`, which is what a "deliberate byte-for-byte copy"
 * convention produces when it is actually followed. (`round9` above is what it
 * produces when it is not.)
 *
 * ZERO IS A CLAIM, and callers should know they are making it: this reports an
 * unusable input as the number zero, which is right for an accumulator and
 * wrong for anything a reader will interpret as a measurement. `round9OrNull`
 * exists for the other case.
 */
export function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A value as a finite NON-NEGATIVE number, or 0.
 *
 * A different function from `numberOrZero`, and it was hiding under the same
 * name: `accounts-list` and `metagraph-neurons` each declared a private
 * `numberOrZero` that also clamped negatives, while nine other modules
 * declared a `toNumber` that did not. Collapsing them onto one name turned a
 * negative stake cell into a real negative on two surfaces that had been
 * treating it as zero, and both modules' existing suites failed -- which is
 * how this is a separate export rather than a footnote.
 *
 * Use where the quantity CANNOT be negative in the domain (a stake, a balance,
 * a count) and a negative therefore means the cell is junk. Where a negative is
 * meaningful (a net flow, a delta), `numberOrZero` is the one that says so.
 */
export function nonNegativeOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * A store cell as rao-rounded TAO, or null when the cell says nothing.
 *
 * The difference from `round9OrNull`, and why it is a separate function rather
 * than an option: `Number("")` is 0, so a BLANK cell would round to a
 * confident zero. `account-events` and `extrinsics` both carried an identical
 * private copy that rejects blank and whitespace-only strings first, and their
 * comment says why -- "Blank cells coerce via Number('') -> 0; trim rejects
 * '' / whitespace-only".
 *
 * Folding that rule into `round9OrNull` would silently change what a blank
 * cell means on every existing caller of it, which is the move #10948 exists
 * to stop.
 */
export function taoCellOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}
