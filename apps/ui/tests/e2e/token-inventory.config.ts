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
export function allowedFamilies(route: string): string[] {
  return route.startsWith("/docs") || route.startsWith("/news") ? [MONO, PROSE] : [MONO];
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
