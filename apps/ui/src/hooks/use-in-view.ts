import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * True when useInView can observe the target: the element is mounted AND the
 * runtime provides `IntersectionObserver`. When this is false the hook takes
 * its fallback path and marks the target visible immediately (SSR /
 * not-yet-mounted / no-`IntersectionObserver` runtime). Written as a type guard
 * so the hook keeps `el` non-null after the check without a cast; extracted so
 * the fallback decision is unit-testable in this DOM-less node suite (see
 * apps/ui/vitest.config.ts).
 */
export function canObserveInView<T extends Element>(
  el: T | null,
  hasIntersectionObserver: boolean,
): el is T {
  return el !== null && hasIntersectionObserver;
}

/**
 * One-shot visibility predicate: any intersecting entry means "become visible".
 * The hook flips to `true` and disconnects on the first hit, so it stays
 * visible forever even after the element scrolls back out of view.
 */
export function entriesIndicateInView(
  entries: ReadonlyArray<{ isIntersecting: boolean }>,
): boolean {
  return entries.some((entry) => entry.isIntersecting);
}

/**
 * Tracks whether an element is within (or near) the viewport, via
 * IntersectionObserver. Once the element has intersected, stays `true`
 * forever (the observer disconnects) — for gating one-shot data fetches
 * (e.g. per-row sparklines in a long table) so only rows actually scrolled
 * into view fire network requests, not every row rendered in the DOM.
 */
export function useInView<T extends Element>(rootMargin = "200px"): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!canObserveInView(el, typeof IntersectionObserver !== "undefined")) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entriesIndicateInView(entries)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView];
}
