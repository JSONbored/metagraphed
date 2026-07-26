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
