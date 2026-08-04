import { useEffect, useState, type RefObject } from "react";

/**
 * The real height of a virtualized table's rows, for `estimateSize`.
 *
 * A virtualizer positions every unmounted row using the estimate and every
 * mounted row using its measured height (these tables pass
 * `rowVirtualizer.measureElement` as a row ref). When the two disagree, the
 * total size is re-derived on every mount, so the scrollbar and all the
 * offsets below the viewport slide while the reader scrolls -- content
 * shifting under the cursor for no reason the reader can see.
 *
 * Both tables disagreed, in opposite directions, and neither was noticeable
 * until the header was pinned and the list scrolled inside its own viewport:
 *
 *   /subnets     estimate 49, actual 56  -> scrollHeight grew  6524 -> 7255
 *   /validators  estimate 41, actual 39  -> scrollHeight shrank 41672 -> 41180
 *
 * A literal is not the fix. Row height is a product of density, font size and
 * whatever the row renders (both of these stack two lines in their first
 * column), so any constant is right for exactly one combination and silently
 * wrong for the rest -- which is how these two drifted apart in the first
 * place. Measure the row that is actually on screen instead, and keep the
 * caller's constant only as the pre-measurement seed.
 */
export function useMeasuredRowHeight(
  scrollRef: RefObject<HTMLElement | null>,
  /** Seed used for the very first render, before a row exists to measure. */
  fallback: number,
): number {
  const [height, setHeight] = useState(fallback);

  // Re-seed when the caller's fallback changes (density toggles), so the
  // measurement below starts from the right ballpark rather than easing over
  // from the previous density's value.
  const [seed, setSeed] = useState(fallback);
  if (seed !== fallback) {
    setSeed(fallback);
    setHeight(fallback);
  }

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const row = root.querySelector<HTMLElement>("tbody tr[data-index]");
      if (!row) return;
      const next = Math.round(row.getBoundingClientRect().height);
      // Guard the update: setting state on every observation would re-render
      // the list on every scroll frame, and a 0 would come from a row that is
      // display:none mid-transition.
      if (next > 0) setHeight((prev) => (prev === next ? prev : next));
    };

    measure();
    // Rows change height when the container width changes (cells wrap) and
    // when density toggles, so observe rather than measuring once.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const row = root.querySelector<HTMLElement>("tbody tr[data-index]");
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [scrollRef, seed]);

  return height;
}
