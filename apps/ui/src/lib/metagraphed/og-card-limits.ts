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
// ./og-display-text.ts and preserves complete Unicode code points.

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
   * This bounds parse cost on the public endpoint; the field caps bound
   * rendering. Text fields total 468 code points, at most 5,616 query bytes
   * with supplementary Unicode (12 encoded bytes per point). Valid logo
   * paths, hosts, parameter names and flags keep the complete URL query below
   * 6,000 bytes. 8 KiB preserves every valid identity without transport-driven
   * truncation, while oversized or duplicate input still fails before rendering.
   */
  query: 8192,
} as const;

/** Shared by emitted image URLs and the renderer cache key. */
export const OG_CARD_VERSION = "9";
