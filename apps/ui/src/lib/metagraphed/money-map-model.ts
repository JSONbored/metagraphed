/**
 * #10511: the money-map panel's display decisions, extracted so the ones with
 * consequences are testable without rendering.
 *
 * TWO RULES, AND THEY PULL THE SAME WAY.
 *
 *   1. `unresolved` IS RENDERED PLAINLY. It may be the majority state at launch
 *      — every subnet's disposition is unresolved today, because the flow
 *      streams are not wired in. Styling it as a warning would turn a gap in
 *      OUR coverage into an accusation across most of the network.
 *   2. NULL IS NOT ZERO. A bucket we could not read and a bucket measured at
 *      nothing are different claims, and only the second is ever "0".
 *
 * The claim-vs-chain delta is reported and never characterised. Both numbers sit
 * side by side; the panel states the difference and stops.
 */

export const DISPOSITION_BUCKETS = [
  "held-as-stake",
  "unstaked",
  "transferred-out",
  "burned",
  "unresolved",
] as const;

export type DispositionBucket = (typeof DISPOSITION_BUCKETS)[number];

const BUCKET_LABEL: Record<DispositionBucket, string> = {
  "held-as-stake": "Held as stake",
  unstaked: "Unstaked",
  "transferred-out": "Transferred out",
  burned: "Burned",
  unresolved: "Unresolved",
};

export function bucketLabel(bucket: DispositionBucket): string {
  return BUCKET_LABEL[bucket];
}

/**
 * The tone a bucket renders with.
 *
 * `unresolved` is DELIBERATELY the same neutral tone as every other bucket.
 * It is the honest answer for a subnet whose flows we have not read, and the
 * majority state today; a warning colour would read as a finding about the
 * owner rather than about our own reach.
 */
export function bucketTone(): "muted" {
  return "muted";
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Alpha, in the token the subnet actually emits. Never summed with TAO. */
export function alphaLabel(value: unknown): string {
  const n = finite(value);
  if (n == null) return "Not read";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M α`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k α`;
  return `${n.toFixed(n < 10 ? 4 : 2)} α`;
}

export function taoLabel(value: unknown): string {
  const n = finite(value);
  if (n == null) return "Not read";
  return `${n.toFixed(n < 10 ? 4 : 2)} τ`;
}

/**
 * A bucket's rendered figure.
 *
 * "Not read" for null, "0" for a measured zero. Rendering the first as the
 * second says "this owner kept nothing" about a subnet nobody measured.
 */
export function bucketLabelValue(value: unknown): string {
  return finite(value) == null ? "Not read" : alphaLabel(value);
}

export interface DispositionSummary {
  /** True when the whole accrual resolved to `unresolved`. */
  allUnresolved: boolean;
  /** The note shown beneath the buckets. Never an alarm. */
  note: string;
}

export function summariseDisposition(
  disposition: Record<string, unknown> | null | undefined,
): DispositionSummary {
  const buckets = (disposition?.buckets ?? {}) as Record<string, unknown>;
  const accrued = finite(disposition?.accrued_alpha);
  const unresolved = finite(buckets.unresolved);
  const others = DISPOSITION_BUCKETS.filter((b) => b !== "unresolved").map((b) =>
    finite(buckets[b]),
  );
  const allUnresolved =
    unresolved != null &&
    accrued != null &&
    unresolved > 0 &&
    others.every((v) => v == null || v === 0);
  return {
    allUnresolved,
    note: allUnresolved
      ? "Where this went is not determinable from what we index. The owner cut is paid as stake rather than a liquid balance, so a disposition derived from transfers alone would report 'held' for every subnet — this reports what was actually read, which today is nothing. It is a statement about our coverage, not about the owner."
      : "Buckets are not balanced to tie. `residual_alpha` reports whatever is unaccounted for, including a negative residual when the parts exceed the whole — assigning the remainder so the totals reconcile would turn 'we cannot account for this' into a number that looks derived.",
  };
}

export interface ClaimVsChain {
  claimed: number | null;
  observed: number | null;
  /** observed - claimed, or null when either side is unread. */
  delta: number | null;
}

/**
 * Claim against chain, both sides reported.
 *
 * The delta is arithmetic and nothing more. A non-zero delta has several
 * explanations — a stale claim, an attribution of ours that is wrong, a real
 * movement — and this model does not pick one, so the panel cannot either.
 */
export function claimVsChain(claimed: unknown, observed: unknown): ClaimVsChain {
  const c = finite(claimed);
  const o = finite(observed);
  return { claimed: c, observed: o, delta: c == null || o == null ? null : o - c };
}

/** A wallet row's role, and whether it came from the chain or from a person. */
export interface WalletRowModel {
  ss58: string;
  role: string;
  chainDerived: boolean;
  name: string | null;
  sourceUrls: string[];
  unspendableProofBasis: string | null;
}

export function walletRows(raw: unknown): WalletRowModel[] {
  if (!Array.isArray(raw)) return [];
  const out: WalletRowModel[] = [];
  for (const item of raw) {
    const row = (item ?? {}) as Record<string, unknown>;
    const ss58 = typeof row.ss58 === "string" ? row.ss58 : "";
    const role = typeof row.role === "string" ? row.role : "";
    if (!ss58 || !role) continue;
    out.push({
      ss58,
      role,
      chainDerived: row.chain_derived === true,
      name: typeof row.name === "string" && row.name ? row.name : null,
      sourceUrls: Array.isArray(row.source_urls)
        ? row.source_urls.filter((u): u is string => typeof u === "string")
        : [],
      unspendableProofBasis:
        typeof row.unspendable_proof_basis === "string" ? row.unspendable_proof_basis : null,
    });
  }
  return out;
}

/**
 * What to say beside a wallet with no evidence.
 *
 * A chain-derived owner needs none — the chain is the source. A declared role
 * with an empty list is a different thing entirely, and worth flagging before
 * anyone repeats it.
 */
export function evidenceNote(row: WalletRowModel): string | null {
  if (row.chainDerived) return "Read from SubnetOwner — needs no evidence";
  if (row.sourceUrls.length === 0) return "No evidence recorded";
  return null;
}
