import { useCallback, useRef } from "react";

// #6417: several overlays (the ⌘K command palette, the API drawer #6418, the
// mobile nav sheet) open from a discrete button but have no in-tree Radix
// trigger, so on close focus falls to <body> instead of the control that opened
// them. #6548's review asked for the repeated capture-and-restore pattern to be
// factored into one hook rather than copied a fourth time — this is that hook.

/** True when `el` is a real element still in the document, so focusing it is
 *  meaningful. Pure, so it can be unit-tested without a DOM. */
export function canRestoreFocusTo(el: Element | null): el is HTMLElement {
  return el != null && (el as HTMLElement).isConnected === true;
}

interface RestoreFocus {
  /** Record the currently-focused element as the one to return focus to on close. */
  capture: () => void;
  /** Return focus to the captured element if it's still connected; no-op otherwise. */
  restore: () => void;
}

/**
 * Capture the element focused when an overlay opens and restore focus to it when
 * the overlay closes. Call `capture()` in the open path (before the overlay
 * takes focus) and `restore()` in the close path (e.g. `onOpenChange(false)`).
 *
 * Restores only to a still-connected element — if the opener was unmounted while
 * the overlay was open, focus is left where the overlay's own logic put it,
 * never forced onto a detached node.
 */
export function useRestoreFocus(): RestoreFocus {
  const ref = useRef<HTMLElement | null>(null);

  const capture = useCallback(() => {
    ref.current = (document.activeElement as HTMLElement | null) ?? null;
  }, []);

  const restore = useCallback(() => {
    const el = ref.current;
    if (canRestoreFocusTo(el)) el.focus();
    ref.current = null;
  }, []);

  return { capture, restore };
}
