/**
 * Touch-primary (coarse-pointer) media query for hover-card gating (#5337).
 *
 * Devices that match this query cannot reliably "hover" — Radix HoverCard
 * would stick open on first tap and require a second tap to navigate. The app
 * convention is to skip the hover chrome entirely and let the underlying link
 * remain the single-tap target (see EntityHoverCard).
 *
 * @see https://github.com/JSONbored/metagraphed/issues/5337
 */

/** Media query that detects touch-primary / no-hover pointers. */
export const COARSE_POINTER_MEDIA_QUERY = "(hover: none), (pointer: coarse)";

/**
 * Pure matcher for the coarse-pointer media query.
 * Accepts an optional MediaQueryList-like object so unit tests don't need a
 * full `window.matchMedia` implementation.
 */
export function matchesCoarsePointer(
  media: Pick<MediaQueryList, "matches"> | null | undefined,
): boolean {
  return Boolean(media?.matches);
}

/**
 * Resolve the MediaQueryList for the coarse-pointer query, or null when the
 * environment has no matchMedia (SSR / older runtimes).
 */
export function getCoarsePointerMediaQuery(
  win: Pick<Window, "matchMedia"> | null | undefined = typeof window !== "undefined"
    ? window
    : null,
): MediaQueryList | null {
  if (!win?.matchMedia) return null;
  try {
    return win.matchMedia(COARSE_POINTER_MEDIA_QUERY);
  } catch {
    return null;
  }
}
