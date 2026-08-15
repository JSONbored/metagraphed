// The site's ONE truncation rule, for text that has to fit a fixed budget:
// an OG card field, a meta description, a sidebar entry.
//
// Extracted from og-card-limits.ts (#11244) when the API-reference docs needed
// the same thing (#11251). Two implementations of "cut this to N characters
// without looking broken" is precisely the drift that produces one surface
// cutting mid-word while another doesn't.
//
// Dependency-free on purpose: a Worker module, a client-bundled route and a
// build script all take it.

/**
 * How far back a cut may reach for a word boundary, as a fraction of the
 * budget. Below this the boundary is too expensive and a hard cut wins.
 */
const WORD_BOUNDARY_FLOOR = 0.6;

/**
 * Bound one field, ending it with an ellipsis when it had to be cut.
 *
 * Cuts at a WORD BOUNDARY where there is one to reach. A blind slice reads as
 * broken rather than shortened — the live subnet cards ended "…machine-readable
 * on Meta…", chopping our own name mid-word on every share. Backing off to the
 * preceding space gives "…machine-readable on…", which reads as deliberate.
 *
 * The floor is what keeps that safe for values with no boundary at all: a
 * truncated ss58, a block hash, a 110-character unbroken title. Those still
 * fill their budget instead of collapsing to nothing, because a space that far
 * back is not a word boundary worth having. Trailing punctuation goes too, so a
 * cut after a comma does not read ", …".
 */
export function clampText(value: string | null | undefined, max: number): string {
  const trimmed = (value || "").trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(max * WORD_BOUNDARY_FLOOR) ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:.—–-]+$/u, "")}…`;
}
