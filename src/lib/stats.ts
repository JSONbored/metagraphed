// Nearest-rank percentile of an ascending numeric array (deterministic, no
// interpolation ambiguity): rank = ceil(p/100 * n), 0-indexed and clamped to
// [0, n-1], so p<=0 returns the minimum and p>=100 returns the maximum. Null on
// an empty array. The single canonical implementation for every distribution's
// percentile field across the chain-*/subnet-*/blocks-summary analytics family.
export function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return ascending[index];
}

// Conventional median of an ascending array: the middle value for an odd count,
// the average of the two middle values for an even count (so [0.2, 0.4] -> 0.3,
// not the lower-middle a nearest-rank p50 would give). Null on an empty array.
// Returns the raw, unrounded value -- callers apply their own precision (round9,
// roundTao, roundUnit, roundMs, ...) to the result, same as before extraction.
export function median(ascending: number[]): number | null {
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? ascending[mid]
    : (ascending[mid - 1] + ascending[mid]) / 2;
}

/**
 * Round to `dp` decimal places (#10948).
 *
 * THE sixteen-way copy: `round(value, dp = 2)` with this exact body was
 * declared byte-identically in sixteen chain/subnet analytics modules -- the
 * one shape of the family with no behavioural spread at all, which is why it
 * collapses without a decision. The variants that DIFFER (a null-guard, a
 * clamp-below-one, a fixed 1e6 factor) are different contracts and stay
 * separate -- see roundBelowOne below and the issue for the survivor table.
 *
 * The default is the caller's to state: the copies defaulted dp = 2, and the
 * callers that meant something else always passed it explicitly.
 */
export function roundDp(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Round to `dp` places, clamped strictly below 1 for a value that was below 1
 * (#10948). A share of 0.99996 rounded at 4dp is 1.0 -- which reads as "all of
 * it" in every ratio column this serves, so a sub-1 input saturates at
 * 0.9999... instead of crossing the boundary rounding alone would invent.
 * Four modules declared this byte-identically as their own `round`.
 */
export function roundBelowOne(value: number, dp = 4): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

/**
 * `roundDp`, but null in and null out (#10948).
 *
 * The null-preserving generic of the family: concentration ratios and
 * hyperparameter readings where "not computable" must survive the rounding
 * rather than become a rounded NaN or an invented zero. Four modules carried
 * this shape privately (two as `round`, two as `roundTaoOrNull` at 6dp).
 */
export function roundDpOrNull(
  value: number | null | undefined,
  dp = 2,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return roundDp(value, dp);
}
