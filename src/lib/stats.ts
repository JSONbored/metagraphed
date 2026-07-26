// Canonical percentile()/median() for the chain-*/subnet-*/blocks-summary
// analytics family. Every distribution builder used to carry its own copy-pasted
// variant of these two functions (16 files), and the copies drifted: most had no
// empty-array guard and no lower-bound clamp, so percentile(arr, 0) indexed
// arr[-1] and returned undefined. This module standardizes on the fully-guarded
// subnet-yield.ts variant: null on an empty array, both bounds clamped (p <= 0
// returns the minimum, p >= 100 the maximum).
//
// Both functions return the RAW statistic. Each caller keeps applying its own
// precision helper (round, round9, roundTao, roundUnit, roundMs, ...) at the
// call site, exactly as it did before the extraction.

// Nearest-rank percentile of an ascending numeric array (deterministic, no
// interpolation ambiguity): rank = ceil(p/100 * n), 0-indexed and clamped to
// [0, n - 1]. Null on an empty array.
export function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return ascending[index];
}

// Conventional median of an ascending array: the middle value for an odd count,
// the average of the two middle values for an even count (so [0.2, 0.4] -> 0.3,
// not the lower-middle a nearest-rank p50 would give). Null on an empty array.
export function median(ascending: number[]): number | null {
  const n = ascending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? ascending[mid]
    : (ascending[mid - 1] + ascending[mid]) / 2;
}
