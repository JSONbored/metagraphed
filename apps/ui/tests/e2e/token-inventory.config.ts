// The design-system v2 contract, as numbers (#11605). token-inventory.spec.ts
// measures every route in ROUTES at 1280×800 in both themes and asserts these.
// Absolute, not baseline-diffed: a route either meets the contract or CI is red.
import { ROUTES as OVERFLOW_ROUTES } from "./overflow-check.config.ts";

export const ROUTES = OVERFLOW_ROUTES;

export const THEMES = ["light", "dark"] as const;

export const VIEWPORT = { width: 1280, height: 800 };

/** Font families allowed under <main>, by route prefix. */
export const MONO = "IBM Plex Mono";
export const PROSE = "IBM Plex Sans";
/**
 * The prose routes: the only pages that are an ARTICLE rather than a reading of
 * data, and so the only ones allowed the second face.
 *
 * /docs and /news were the whole list until #11627 put /about, /privacy and
 * /terms into `.mg-prose` — the rule they had always described and no route
 * applied. Everything else is mono, which is the point of having one face.
 */
export const PROSE_ROUTES = ["/docs", "/news", "/about", "/privacy", "/terms"];

export function allowedFamilies(route: string): string[] {
  return PROSE_ROUTES.some((p) => route.startsWith(p)) ? [MONO, PROSE] : [MONO];
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
