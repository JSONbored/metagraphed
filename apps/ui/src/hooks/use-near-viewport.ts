import { useEffect, useRef, useState } from "react";

/**
 * Defers a non-critical read until its section is close enough to be useful.
 *
 * A route can still render its source, anchor, and an honest loading affordance
 * on the server. The browser starts the read once the section is within the
 * requested margin, rather than making a below-the-fold payload compete with
 * the route's primary data.
 */
export function useNearViewport<T extends HTMLElement = HTMLElement>(
  rootMargin = "480px 0px",
  enabled = true,
) {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const target = ref.current;
    if (!enabled || !target || nearViewport) return;
    // An older browser without IntersectionObserver should still receive the
    // data; it simply cannot defer the request based on scroll position.
    if (!("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(target);

    // IntersectionObserver is the primary signal, but a section can change
    // geometry while its loading placeholder is replaced or while a sticky
    // table establishes its scrollport. Chromium can then coalesce the exact
    // observer transition that a same-frame anchor scroll depends on. A small
    // geometry check on scroll/resize makes that reader action deterministic
    // without polling or starting the read any earlier than the same margin.
    const verticalMargins = rootMargin
      .split(/\s+/)
      .map((part) => Number.parseFloat(part))
      .filter(Number.isFinite);
    const proximity = Math.max(0, verticalMargins[0] ?? 0, verticalMargins[2] ?? 0);
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const rect = target.getBoundingClientRect();
      if (rect.bottom < -proximity || rect.top > window.innerHeight + proximity) return;
      setNearViewport(true);
      observer.disconnect();
    };
    const scheduleMeasure = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [enabled, nearViewport, rootMargin]);

  return { ref, nearViewport };
}
