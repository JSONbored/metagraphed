// Shared, pure helpers for the maintainer-reviewed trust tier so the promotion
// writer (scripts/promote-reviewed.mjs) and the CI guard (scripts/validate.mjs)
// agree on one definition. registry/reviews/maintainer-reviewed.json is the
// single source of truth for the tier (see docs/curation-playbook.md): a
// recorded decision is the ONLY sanctioned way an overlay reaches
// curation.level "maintainer-reviewed".

// The two top trust tiers. `adapter-backed` sits ABOVE `maintainer-reviewed`
// (see TOP_TRUST_LEVELS / the level-resolution order in scripts/lib.mjs), so a
// maintainer-reviewed decision must never DOWN-grade an already adapter-backed
// overlay, and the CI guard must accept either tier as satisfying the decision.
export const TOP_TRUST_LEVELS = new Set([
  "maintainer-reviewed",
  "adapter-backed",
]);

// Apply a review decision to an overlay's curation block. Always records the
// decision's review_state/reviewed_at; and, for a maintainer-reviewed decision,
// promotes curation.level to "maintainer-reviewed" from ANY lower starting tier
// (community-seeded / candidate-discovered / native / machine-verified) — not
// only machine-verified as before, which silently left the rest un-promoted
// (live drift: SN59, SN107). An already top-trust level is left untouched.
export function curationForDecision(curation, decision) {
  const next = {
    ...(curation || {}),
    review_state: decision.decision,
    reviewed_at: decision.reviewed_at,
  };
  if (
    decision.decision === "maintainer-reviewed" &&
    !TOP_TRUST_LEVELS.has(next.level)
  ) {
    next.level = "maintainer-reviewed";
  }
  return next;
}

// The inverse of validate.mjs's existing "a maintainer-reviewed level needs a
// backing decision" gate: find every maintainer-reviewed DECISION whose subnet
// overlay is NOT actually at a top-trust level — i.e. a recorded decision that
// never took effect on the overlay. Returns [{ netuid, slug, level }] so the
// caller can name the drifted overlays. Decisions with no loaded overlay are
// skipped (a missing overlay is a separate concern).
export function maintainerReviewedDrift(subnets, decisions) {
  const levelByNetuid = new Map(
    subnets.map((subnet) => [subnet.netuid, subnet.curation?.level]),
  );
  const drifted = [];
  for (const decision of decisions || []) {
    if (decision.decision !== "maintainer-reviewed") {
      continue;
    }
    const level = levelByNetuid.get(decision.netuid);
    if (level === undefined) {
      continue;
    }
    if (!TOP_TRUST_LEVELS.has(level)) {
      drifted.push({ netuid: decision.netuid, slug: decision.slug, level });
    }
  }
  return drifted;
}
