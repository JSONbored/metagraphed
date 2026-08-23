/**
 * The shape of a long prose document (#11627) — /privacy and /terms.
 *
 * These two pages are the only ones on the site that are genuinely an
 * article: ten-odd headed sections of running text with no chart in any of
 * them. Wrapping each section in an `AnalyticsSection` would promise a
 * `Name. One question.` composition and a visual that legal prose does not
 * have, so they get the document treatment instead — one `.mg-prose` article,
 * a `SectionNav` over its headings, and nothing else.
 *
 * The section list lives here rather than in the page so the nav and the
 * article are built from the SAME array: the page supplies a
 * `Record<Section, ReactNode>` of bodies, which the compiler will not let it
 * leave a hole in, and the nav maps the same array. A heading can therefore
 * never appear in one and not the other.
 */

/** `The short version` -> `the-short-version`, the anchor the nav links to. */
export function sectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const PRIVACY_SECTIONS = [
  "The short version",
  "Requests to the API and MCP server",
  "If you sign in",
  "The credential store",
  "What we do not collect",
  "Retention",
  "Who else processes it",
  "Your choices",
  "Changes",
  "Contact",
] as const;

export type PrivacySection = (typeof PRIVACY_SECTIONS)[number];

export const TERMS_SECTIONS = [
  "What this service is",
  "Accuracy, and what you should not rely on",
  "Fair use",
  "Calling subnet APIs through us",
  "Non-custodial by design",
  "Using the data",
  "Liability",
  "Changes",
  "Contact",
] as const;

export type TermsSection = (typeof TERMS_SECTIONS)[number];

/** Nav items for a document's own headings. */
export function proseNavItems(titles: readonly string[]): { id: string; name: string }[] {
  return titles.map((name) => ({ id: sectionId(name), name }));
}
