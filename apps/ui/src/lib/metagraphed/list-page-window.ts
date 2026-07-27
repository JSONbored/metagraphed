/** Page size for client-side LoadMore windows on the APIs hub (#8360). */
export const APIS_HUB_PAGE_STEP = 25;

/**
 * Raise a LoadMore `limit` so that 0-based `index` is included, rounding up to
 * the next `step` boundary. No-op when the index is already visible or < 0.
 */
export function ensureIndexVisible(limit: number, index: number, step: number): number {
  if (index < 0 || step <= 0) return limit;
  const needed = index + 1;
  if (needed <= limit) return limit;
  return Math.ceil(needed / step) * step;
}

/**
 * Single-pass window update used when filter keys and deep-link targets share
 * one effect (avoids the reset-vs-hash race that closed #8420).
 *
 * - Filter change → floor at `step`, then expand for `targetIndex` if ≥ 0.
 * - No filter change → keep `prev` (preserves Load more), still expand for
 *   the deep-link target so a late-arriving list or hash update wins.
 */
export function nextListLimit(opts: {
  prev: number;
  filtersChanged: boolean;
  targetIndex: number;
  step: number;
}): number {
  const base = opts.filtersChanged ? opts.step : opts.prev;
  return ensureIndexVisible(base, opts.targetIndex, opts.step);
}
