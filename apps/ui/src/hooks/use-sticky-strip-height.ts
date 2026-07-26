import { useEffect, type RefObject } from "react";

/**
 * Publishes a sticky tab strip's measured height as `--mg-tabs-h` on the
 * document root, so anything that sticks *below* it can stack instead of
 * collide.
 *
 * A page has exactly one of these strips — hub tabs (/chain, /subnets/…) or
 * profile tabs (an entity detail page) — never both, so one variable is
 * enough and the two callers can't fight over it.
 *
 * Why it's measured rather than a constant: everything that sticks under the
 * strip used to hardcode an offset for whatever page chrome existed when it
 * was written. Those magic numbers go wrong the moment the chrome changes,
 * which is precisely what consolidating pages into hubs does — /chain ended
 * up with the strip and the list filter bar both pinned at
 * `--mg-sticky-offset`, overlapping each other on every scroll (#8254).
 *
 * Consumers read `calc(var(--mg-sticky-offset, 3.5rem) + var(--mg-tabs-h, 0px))`.
 * The `0px` fallback matters: the variable is removed on unmount, so a page
 * with no strip gets no phantom offset.
 */
export function useStickyStripHeight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      document.documentElement.style.setProperty(
        "--mg-tabs-h",
        `${el.getBoundingClientRect().height}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--mg-tabs-h");
    };
  }, [ref]);
}
