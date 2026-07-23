// #5546: fair per-run selection of which webhook subscriptions to dispatch to
// when the total exceeds the per-run fan-out cap (MAX_DISPATCH_SUBSCRIPTIONS).
//
// The dispatcher lists subscription keys from KV (returned in lexicographic
// order) and may only fan out to `max` of them per run. A plain
// `keys.slice(0, max)` deterministically picks the same lexicographically-first
// `max` keys every run, so once the total exceeds the cap every subscription
// whose id sorts after the cap receives ZERO dispatches forever.
//
// This selects a fair rotating window instead: keys are ordered by a
// run-varying hash (a per-run `seed`, e.g. the publish timestamp), so across a
// bounded number of runs every subscription is eventually included. The cap
// itself is preserved. When the total is within the cap, the input is returned
// unchanged (no reordering) so the common case is byte-for-byte identical to the
// previous behavior.

// FNV-1a 32-bit — a small, dependency-free, well-distributed string hash.
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit unsigned range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

interface SelectDispatchKeysOptions {
  max: number;
  seed?: number | string;
}

// Choose up to `max` subscription keys to dispatch to this run. Returns at
// most `max` keys; the full input (unchanged order) when
// `allKeys.length <= max`.
export function selectDispatchKeys(
  allKeys: string[],
  { max, seed = 0 }: SelectDispatchKeysOptions,
): string[] {
  if (!Array.isArray(allKeys)) {
    throw new TypeError("selectDispatchKeys: allKeys must be an array");
  }
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(
      "selectDispatchKeys: max must be a non-negative integer",
    );
  }
  if (allKeys.length <= max) {
    // Within the cap: no rotation needed, preserve the input exactly.
    return [...allKeys];
  }
  const seedStr = String(seed);
  return allKeys
    .map((key) => ({ key, rank: fnv1a32(`${seedStr}:${key}`) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Stable tiebreak on the key so equal-hash pairs are deterministic.
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, max)
    .map((entry) => entry.key);
}
