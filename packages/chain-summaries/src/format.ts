// Minimal formatting helpers the chain-summaries templates need, duplicated
// (not imported) from apps/ui/src/lib/metagraphed/format.ts and blocks.ts
// (#8525). apps/ui's format.ts re-exports `classNames` from `@jsonbored/
// ui-kit`, whose barrel also exports dozens of React components -- importing
// it here would give a Cloudflare Worker consumer a transitive dependency on
// React. Duplicating just the two pure helpers this package actually needs
// follows the exact precedent packages/ui-kit/src/lib/format.ts already set,
// duplicating apps/ui's freshness helpers "for their 100+ other callers"
// rather than importing apps/ui.

/** "1.23M τ" / "4.5k τ" / "1.23 τ" / "0.1234 τ" -- same thresholds as
 * apps/ui's formatTao. */
export function formatTao(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const magnitude = Math.abs(v);
  if (magnitude >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (magnitude >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (magnitude >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

/**
 * Truncate a long hex hash / account id for display ("0x1234…cdef"). Returns
 * `undefined` for empty/nullish input so callers can render their own dash.
 * Short values (≤ keep*2 + ellipsis) are returned unchanged. Same behavior
 * as apps/ui's blocks.ts#shortHash.
 */
export function shortHash(value?: string | null, keep = 6): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (v.length <= keep * 2 + 1) return v;
  return `${v.slice(0, keep)}…${v.slice(-keep)}`;
}
