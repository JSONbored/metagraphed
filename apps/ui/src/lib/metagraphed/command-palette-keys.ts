/** The subset of a keyboard event `isCopySelectedKey` reads — structural so the
 * predicate is unit-testable without a real event. */
export interface CopyKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
}

/**
 * Whether a keydown in the command palette should copy the highlighted result's
 * link (#6414). ⌘/Ctrl + C, with **no** Shift — Ctrl+Shift+C is the browser's
 * "inspect element" devtools shortcut, so it's deliberately excluded despite the
 * issue floating it. Suppressed when the user has actually selected text in the
 * search input, so a plain ⌘C there still copies that text natively rather than
 * being hijacked.
 *
 * Kept pure (no DOM, no event methods) so the modifier matrix is unit-tested in
 * the plain-node suite; the caller does the DOM lookup + click.
 */
export function isCopySelectedKey(e: CopyKeyEvent, hasInputTextSelection: boolean): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    (e.key === "c" || e.key === "C") &&
    !hasInputTextSelection
  );
}
