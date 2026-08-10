// Coverage arithmetic shared by the network-wide panels (#10300).
//
// Every one of these surfaces publishes a "how many exist" count beside a "how
// many were read" count, and the reason is always the same: an aggregate over a
// partial read is a real answer about a subset, and rendering it as an answer
// about the network is how a measurement gap becomes a finding.
//
// Kept out of the components so the arithmetic is testable without rendering,
// and so all four panels phrase the same caveat the same way.

/** How many of a set were NOT measured, or null when either count is unknown. */
export function unmeasuredCount(
  total: number | null | undefined,
  measured: number | null | undefined,
): number | null {
  if (typeof total !== "number" || typeof measured !== "number") return null;
  if (!Number.isFinite(total) || !Number.isFinite(measured)) return null;
  // Never negative. A measured count above the total means the two came from
  // different reads, and "-3 unmeasured" is worse than declining to say.
  return Math.max(0, total - measured);
}

/**
 * The sentence a panel puts under a network-wide aggregate.
 *
 * Returns null when coverage is complete or unknown -- a caveat printed on
 * every panel regardless is one readers stop seeing, so it appears only when
 * there is something to caveat.
 */
export function coverageNote(
  total: number | null | undefined,
  measured: number | null | undefined,
  noun = "subnet",
): string | null {
  const missing = unmeasuredCount(total, measured);
  if (missing === null || missing === 0) return null;
  return (
    `Computed over ${measured} of ${total} ${noun}s — ${missing} ${noun}${missing === 1 ? "" : "s"} ` +
    `had no reading, so this describes the measured subset, not the network.`
  );
}

/**
 * Whether a series was computed by more than one builder version.
 *
 * A trend drawn across a version change compares two definitions rather than
 * measuring a movement, so the panel says so instead of drawing a line through
 * the seam.
 */
export function spansBuilderVersions(versions: readonly number[]): boolean {
  return new Set(versions).size > 1;
}

/**
 * Are two capture stamps far enough apart to be worth stating separately?
 *
 * Both halves of a joined answer carry their own timestamp, and when they were
 * read minutes apart that is noise. Past a threshold it is not: the older half
 * is describing a different moment than the newer one.
 */
export function capturesDiverge(
  a: string | null | undefined,
  b: string | null | undefined,
  thresholdMs = 60 * 60_000,
): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  // An unparseable stamp is not a divergence -- it is an unknown, and reporting
  // it as "these disagree" would invent a discrepancy out of a formatting bug.
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) >= thresholdMs;
}
