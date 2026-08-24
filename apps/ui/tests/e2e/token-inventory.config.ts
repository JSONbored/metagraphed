// The design-system v2 contract, as numbers (#11605). token-inventory.spec.ts
// measures every route in ROUTES at every VIEWPORT in both themes and asserts
// these. Absolute, not baseline-diffed: a route either meets the contract or
// CI is red.
import { ROUTES as OVERFLOW_ROUTES } from "./overflow-check.config.ts";

export const ROUTES = OVERFLOW_ROUTES;

export const THEMES = ["light", "dark"] as const;

/**
 * Every width the contract is measured at.
 *
 * It was 1280 alone until #11678. `responsive-overflow` had always swept four
 * widths, so a phone was proven not to OVERFLOW -- and that is the whole of
 * what was ever checked there. Nothing asserted that a phone renders the same
 * type scale, the same radii, the same section count, or no pills; a route
 * could satisfy the design system on a desktop and quietly be a different
 * design on a phone, which is where most of the traffic is.
 *
 * 375 and 768 rather than the overflow sweep's four: 1024 and 1280 are the same
 * layout branch on every route (the tables never become cards, the grids never
 * collapse), so the third and fourth widths would triple the run time to
 * re-measure what 1280 already covers. 375 is below every `sm:`/`md:` breakpoint
 * and 768 is exactly `md`, so between them they exercise both branches.
 */
export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

export type ContractViewport = (typeof VIEWPORTS)[number];

/**
 * The two families, and nothing else (#11698).
 *
 * The site was one mono everywhere, and `allowedFamilies` said so: a single
 * name, with a second granted to the five prose routes. It is a PAIR now --
 * Geist for text, Geist Mono for identifiers, figures and code -- so every
 * route may show both, and the rule the gate can still hold is that it shows
 * ONLY those two. A third family reaching a page is a component that brought
 * its own stack, which is what this catches.
 *
 * The split itself is enforced where it is decided: `styles.css` names the
 * handful of hooks that take the mono, and everything else inherits the sans
 * from `body`. A runtime gate cannot tell an identifier from a label.
 */
export const MONO = "Geist Mono";
export const SANS = "Geist";

/**
 * The prose routes: the pages that are an ARTICLE rather than a reading of
 * data.
 *
 * They no longer differ in FACE -- the whole site is the sans now -- but they
 * still differ in measure, rhythm and heading scale, and `.mg-prose` is what
 * applies that. The list stays because those rules key off it.
 */
export const PROSE_ROUTES = ["/docs", "/news", "/about", "/privacy", "/terms"];

export function allowedFamilies(_route: string): string[] {
  return [SANS, MONO];
}

/** The seven sizes. 64px is the landing h1 only. */
export const SIZES = new Set(["10px", "11px", "13px", "16px", "28px", "40px", "64px"]);
export function allowedSizes(route: string): Set<string> {
  if (route === "/") return SIZES;
  const s = new Set(SIZES);
  s.delete("64px");
  return s;
}

/** letter-spacing: normal everywhere; <th> carries 0.05em from CSS. */
export const TRACKING_NORMAL = "normal";

/** border-radius: 0, the one radius, or a circle (status dots only). */
export const RADII = new Set(["0px", "4px", "50%"]);

/** A pill: wider than tall, not a dot, with a radius that is effectively round. */
export const DOT_MAX_PX = 12;
// The one radius the contract allows; never counted as a pill however thin the element.
export const CONTRACT_RADIUS_PX = 4;

/**
 * The page-shape rule: at most seven `section.mg-section` per route.
 *
 * `AnalyticsPage` enforces this at runtime outside production, but only for
 * pages that use it. /design/primitives mounts fifteen sections by hand and is
 * the documented exception -- it is the specimen page, and one section per
 * primitive family is what it is for.
 */
export const MAX_SECTIONS_PER_ROUTE = 7;

/**
 * Routes exempt from the STRUCTURAL rules (section count, one tall table per
 * section) — never from the token rules, which hold everywhere.
 *
 * /design/primitives is the only one, and the reason is what the page is: a
 * specimen sheet. One section per primitive family is exactly its job, and a
 * section demonstrating `DataTable` necessarily holds the specimen table AND
 * the props table describing it. Collapsing either would make the page
 * document less of the library than exists. It is also why the page mounts
 * `ActiveEntityProvider` + `SectionNav` by hand rather than using
 * `AnalyticsPage`, whose own `MAX_SECTIONS` throws at eight.
 */
export const SPECIMEN_ROUTES: Record<string, string> = {
  "/design/primitives":
    "the specimen sheet: one section per primitive family, each with its props table",
};
