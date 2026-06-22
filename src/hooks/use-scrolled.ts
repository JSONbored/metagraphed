import { useEffect, useState } from "react";

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
      setScrolled(window.scrollY > threshold);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}
