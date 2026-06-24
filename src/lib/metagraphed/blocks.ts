// Helpers for the block explorer.

/**
 * Truncate a long hex hash / account id for display ("0x1234…cdef"). Returns
 * `undefined` for empty/nullish input so callers can render their own dash.
 * Short values (≤ keep*2 + ellipsis) are returned unchanged.
 */
export function shortHash(value?: string | null, keep = 6): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (v.length <= keep * 2 + 1) return v;
  return `${v.slice(0, keep)}…${v.slice(-keep)}`;
}

/** True when a ref looks like a 0x-prefixed block hash (vs a numeric block_number). */
export function isHashRef(ref: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(ref);
}
