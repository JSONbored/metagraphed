// #8528: tracks which rows in a live-refreshed list are *genuinely new* since
// the last render, so only those get an entrance animation — never rows that
// were already present (re-render / refetch / re-sort), and never the initial
// populated paint (which would cascade-animate the whole table). Pure and
// mount-driven: the caller keeps a persistent `seen` Set (a ref) across
// renders and asks, per render, which of the current keys are new. No timers.

export interface NewRowResult {
  /** Keys that were not present at the previous render (empty on first render). */
  newKeys: Set<string>;
}

/**
 * Diffs `currentKeys` against the persistent `seen` set, MUTATING `seen` to
 * include every current key. On the very first call (`primed` false), it primes
 * `seen` with all current keys and reports NOTHING as new — so an already-
 * populated table does not cascade-animate on initial paint (req #6). On every
 * later call, only keys absent from `seen` are new (req #1); keys that vanished
 * and returned are treated as new again, which is correct for a live feed.
 *
 * Returns the primed flag so the caller can persist it (typically alongside the
 * ref) without a second piece of state.
 */
export function diffNewRows(
  currentKeys: readonly string[],
  seen: Set<string>,
  primed: boolean,
): NewRowResult & { primed: true } {
  const newKeys = new Set<string>();
  if (!primed) {
    for (const k of currentKeys) seen.add(k);
    return { newKeys, primed: true };
  }
  for (const k of currentKeys) {
    if (!seen.has(k)) {
      newKeys.add(k);
      seen.add(k);
    }
  }
  return { newKeys, primed: true };
}
