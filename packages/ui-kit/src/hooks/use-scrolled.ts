import { useEffect, useState } from "react";

/** Pure scrollY-vs-threshold comparison, extracted so it's testable without a DOM. */
export function isScrolledPast(scrollY: number, threshold: number): boolean {
  return scrollY > threshold;
}

/**
 * Returns `true` once the window (or a custom scroll root) has scrolled past
 * `threshold` pixels. Used to toggle scroll-shadows on sticky toolbars.
 * SSR-safe.
 */
export function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => {
      setScrolled(isScrolledPast(window.scrollY, threshold));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}
