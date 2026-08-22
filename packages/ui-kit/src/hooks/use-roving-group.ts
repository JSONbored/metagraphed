import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

// #6391: several segmented widgets (endpoints' EndpointKindTabs, explorer's
// section tabs, the subnet stake/unstake toggle) render `role="tab"`/`aria-selected`
// on plain `<button onClick>` elements with no keyboard handler — so they advertise
// the WAI-ARIA APG tabs pattern via `role` but never implement its arrow-key contract.
// This hook factors that contract (roving tabIndex + ArrowLeft/Right + Home/End) into
// one shared primitive those tablists consume, matching the manual ArrowLeft/Right
// idiom already used in nav-mega-menu.tsx.

/**
 * Pure next-index computation for a horizontal tablist. Given the current index,
 * the key pressed, and the item count, returns the index that should receive
 * focus, or `null` when the key isn't a navigation key this list handles.
 *
 * ArrowRight/ArrowLeft wrap around the ends (APG "automatic activation" tablists
 * conventionally wrap); Home/End jump to the first/last item.
 */
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

interface RovingGroup {
  /** Ref callback to attach to each item, in order (call with the item's index). */
  itemRef: (index: number) => (el: HTMLElement | null) => void;
  /** `onKeyDown` for a tab button at `index`: moves DOM focus (and selection) per the APG contract. */
  onKeyDown: (index: number) => (e: ReactKeyboardEvent<HTMLElement>) => void;
}

/** Roving `tabIndex` for a tab: 0 for the active tab, -1 for the rest, so only the
 *  active tab is in the Tab order and arrow keys move within the list. */
export function rovingTabIndex(index: number, activeIndex: number): 0 | -1 {
  return index === activeIndex ? 0 : -1;
}

/**
 * Wire the roving-tabindex keyboard contract onto a horizontal group -- a
 * `role="radiogroup"` (`RangeControl`, #11607) or a tablist.
 *
 * `count` is the number of rendered items; `onSelect(index)` selects the item
 * (the same effect as its onClick) — arrow navigation moves focus AND selects.
 * Pair with `rovingTabIndex(i, activeIndex)` on each item so only the active
 * one is in the Tab order and arrow keys move within.
 */
export function useRovingGroup(
  count: number,
  onSelect: (index: number) => void,
): RovingGroup {
  const refs = useRef<(HTMLElement | null)[]>([]);

  const itemRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      refs.current[index] = el;
    },
    [],
  );

  const onKeyDown = useCallback(
    (index: number) => (e: ReactKeyboardEvent<HTMLElement>) => {
      const next = nextTabIndex(index, e.key, count);
      if (next == null) return;
      e.preventDefault();
      refs.current[next]?.focus();
      onSelect(next);
    },
    [count, onSelect],
  );

  return { itemRef, onKeyDown };
}
