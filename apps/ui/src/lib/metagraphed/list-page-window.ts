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
