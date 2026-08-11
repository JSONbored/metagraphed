/**
 * #10477: the revenue panel's display decisions, extracted so the one that
 * matters can be tested without rendering.
 *
 * THE DECISION: a null ratio renders as "Not observed", never as 0%. 127 of 129
 * subnets have no observable external revenue, and "0% covered" is a false claim
 * about every one of them — at a scale that makes it defamatory rather than
 * merely wrong. An OBSERVED zero is a different value and survives as a real 0%.
 *
 * Same shape as stake-moves-tile.ts: a pure model beside the panel that renders
 * it, so the rule is checkable rather than asserted in a comment.
 */

/** Only these two rungs reach the headline ratio. */
export const HEADLINE_TIERS = new Set(["chain-verified", "probe-derived"]);

const TIER_LABEL: Record<string, string> = {
  "chain-verified": "Chain-verified",
  "probe-derived": "Probe-derived",
  "operator-attested": "Operator-attested",
  "third-party-reported": "Third-party reported",
  "self-reported": "Self-reported",
  inferred: "Inferred",
};

export function tierLabel(provenance: unknown): string {
  const key = typeof provenance === "string" ? provenance : "";
  return TIER_LABEL[key] ?? (key || "Unrecorded");
}

export function isHeadlineEligible(provenance: unknown): boolean {
  return HEADLINE_TIERS.has(String(provenance ?? ""));
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A figure ALREADY in dollars. `formatUsdApprox` converts TAO at a price,
 * which is a different job — handing it dollars would price the currency
 * against itself. */
export function usdLabel(value: unknown): string | null {
  const n = finite(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

/** A ratio as a percentage, or the honest absence. NEVER "0%" for a null. */
export function coverageLabel(value: unknown): string {
  const n = finite(value);
  return n == null ? "Not observed" : `${(n * 100).toFixed(1)}%`;
}

export function subsidyLabel(value: unknown): string {
  const n = finite(value);
  return n == null ? "Not observed" : `${n.toFixed(1)}×`;
}

/**
 * The sentence under the tiles.
 *
 * Prose rather than a tooltip, because for 127 of 129 subnets it is the most
 * important thing on the panel — and a tooltip does not survive a screenshot.
 */
export function coverageNote(observedUsd: unknown): string {
  return finite(observedUsd) == null
    ? "No observable external revenue. This subnet has not been measured — it has not been judged. " +
        "A subnet that publishes no figure gets no ratio, which is not the same as earning nothing, " +
        "and a subnet that publishes one will usually look worse than one that hides it."
    : "Only chain-verified and probe-derived readings reach this ratio. The numerator is external revenue, " +
        "not profit; the denominator is emission received, not cost. A high subsidy multiple is not an accusation.";
}
