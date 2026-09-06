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
// dragging the other's dependencies in. The truncation RULE itself lives in
// ./truncate.ts — every surface that has to fit a budget shares it.

/** Per-field caps. Every one is enforced on BOTH sides. */
export const OG_LIMITS = {
  title: 110,
  subtitle: 90,
  eyebrow: 32,
  identifier: 80,
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

/** Shared by emitted image URLs and the renderer cache key. */
export const OG_CARD_VERSION = "7";
