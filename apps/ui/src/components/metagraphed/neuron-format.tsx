/**
 * Pure neuron/validator formatting helpers, deliberately split out of
 * `neuron-table.tsx`. That file also pulls in `StakeUnstakeModal` (wallet
 * connect + signing flow), which is fine for the table itself but was
 * leaking into the homepage's initial bundle via `movers-band.tsx` ->
 * `taoCompact` -> the whole `neuron-table.tsx` module graph, blowing the
 * gzip budget. Anything that only needs a formatter should import from
 * here, not from `neuron-table.tsx`.
 */

/** Format a TAO value compactly. Stake can run into the millions; emission and
 * incentive are sub-unit. Null/non-finite collapses to an em-dash. */
export function taoCompact(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (v === 0) return "0";
  return v.toFixed(4);
}

/** Format a 0..1 score (trust, consensus, incentive) to three decimals. */
export function scoreStr(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(3);
}

/**
 * Small pill marking a DB-toggled featured-validator pin (#5166) — a paid/
 * partner placement, not a quality or trust signal. Deliberately styled
 * distinct from the "Validator" permit pill (that one IS a chain-derived
 * trust fact; this one is a disclosed sponsorship) so the two are never
 * visually confused. Label is persistent (not hover-gated) — the disclosure
 * has to be legible without any interaction. Shared across the metagraph/
 * validator tables and cards.
 */
export function SponsoredBadge() {
  return (
    <span
      className="inline-flex items-center rounded border border-ink-muted/40 bg-surface px-1.5 py-0.5 mg-type-micro text-ink-muted"
      title="Sponsored placement — this validator paid for visibility here. It is not ranked or endorsed; see the validator directory's own stake/trust/APY columns for objective standing."
    >
      Sponsored
    </span>
  );
}
