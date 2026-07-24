import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * True when the hook should treat the element as already in view without
 * observing: missing element (SSR / not yet mounted) or no IntersectionObserver
 * in the runtime.
 */
export function shouldFallbackInView(
  el: Element | null,
  hasIntersectionObserver: boolean,
): boolean {
  return !el || !hasIntersectionObserver;
}

/**
 * One-shot visibility: any intersecting entry means "become visible forever".
 */
export function entriesIndicateInView(entries: ReadonlyArray<{ isIntersecting: boolean }>): boolean {
  return entries.some((e) => e.isIntersecting);
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
    if (shouldFallbackInView(el, typeof IntersectionObserver !== "undefined")) {
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
    observer.observe(el as T);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView];
}
