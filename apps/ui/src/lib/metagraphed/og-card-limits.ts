// The /og card's field bounds, in ONE place.
//
// The card has two sides that deliberately share no code -- og-card.ts builds
// the URL and is client-bundled, src/lib/og-image.ts renders it and is
// Worker-only (it pulls in satori). They had two copies of these numbers, and a
// copy that only the renderer enforced is exactly how a URL gets built that the
// renderer then refuses: adding the first-party logo path (#11204) pushed the
// worst legitimate card to 548 characters of query against a 512 cap, and /og
// answers 414 above it -- an unfurl with no image at all.
//
// Constants only, no imports, so both sides can take it without either one
// dragging the other's dependencies in.

/** Per-field caps. Every one is enforced on BOTH sides. */
export const OG_LIMITS = {
  title: 110,
  subtitle: 90,
  eyebrow: 32,
  statLabel: 24,
  statValue: 28,
  /** A bare DNS name, never a URL — see normalizeLogoHost. */
  logoHost: 80,
  /**
   * The renderer's guard on total query size.
   *
   * This bounds PARSE cost on an unauthenticated endpoint; it is not what keeps
   * the card from overflowing -- the per-field caps above do that, after
   * parsing. So it has to be generous enough that no legitimate card is ever
   * refused: the fields sum to ~550 characters once encoded, and a title in a
   * script that percent-encodes to three bytes a character multiplies part of
   * that severalfold. 2048 leaves room for both while still refusing input
   * that could only be someone probing the endpoint.
   */
  query: 2048,
} as const;

/**
 * How far back a cut may reach for a word boundary, as a fraction of the
 * budget. Below this the boundary is too expensive and a hard cut wins.
 */
const WORD_BOUNDARY_FLOOR = 0.6;

/**
 * Bound one card field, ending it with an ellipsis when it had to be cut.
 *
 * The single truncation rule for the card. Both sides apply it: the builder so
 * the URL stays short and honest about what will be painted, the renderer
 * because /og is public and must never trust its query.
 *
 * Cuts at a WORD BOUNDARY where there is one to reach. A blind slice reads as
 * broken rather than shortened — the live subnet cards ended "…machine-readable
 * on Meta…", chopping our own name mid-word on every share. Backing off to the
 * preceding space gives "…machine-readable on…", which reads as deliberate.
 *
 * The floor is what keeps that safe for the values that have no boundary at
 * all: a truncated ss58, a block hash, a 110-character unbroken title. Those
 * still fill their budget instead of collapsing to nothing, because a space
 * that far back is not a word boundary worth having. Trailing punctuation goes
 * too, so a cut after a comma does not paint ", …".
 */
export function clampCardText(value: string | null | undefined, max: number): string {
  const trimmed = (value || "").trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(max * WORD_BOUNDARY_FLOOR) ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:.—–-]+$/u, "")}…`;
}
