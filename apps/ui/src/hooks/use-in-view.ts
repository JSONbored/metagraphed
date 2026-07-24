import { useEffect, useRef, useState, type RefObject } from "react";

// True when there's no IntersectionObserver in this runtime (SSR, or a
// browser that lacks it) -- the caller should treat the element as visible
// immediately rather than wait on an observer that will never fire.
export function hasIntersectionObserverSupport(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

// The one-shot trigger: true once any observed entry is actually
// intersecting.
export function hasIntersectingEntry(entries: readonly { isIntersecting: boolean }[]): boolean {
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
    if (!el || !hasIntersectionObserverSupport()) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (hasIntersectingEntry(entries)) {
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
