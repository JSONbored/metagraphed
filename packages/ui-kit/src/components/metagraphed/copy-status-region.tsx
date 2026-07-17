import type { ReactNode } from "react";

/**
 * The shared screen-reader status line for copy affordances (#6372): a
 * visually-hidden polite live region announcing the result of a copy.
 *
 * Every copy control consumes the same `useCopy` hook, but a swapped
 * `aria-label` on an already-focused button is not reliably re-announced by
 * most assistive tech — so the outcome needs its own live region. ShareButton
 * shipped one; CopyButton/CopyableCode/KeyChip did not. This centralizes the
 * markup so all four announce identically instead of duplicating (or omitting)
 * it per component.
 *
 * `sr-only` is absolutely positioned, so this adds no layout: it can sit beside
 * a button inside a flex row without shifting it.
 *
 * Render an empty child to say nothing — the region must stay mounted for a
 * later content change to be announced, so callers clear the text rather than
 * unmounting the region.
 */
export function CopyStatusRegion({ children }: { children: ReactNode }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {children}
    </span>
  );
}
