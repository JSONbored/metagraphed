import { lazy, Suspense, useRef } from "react";
import type { CommandPaletteProps } from "./command-palette-body";

// The ⌘K palette body — search index, scope filters, route index, analytics,
// and the cmdk command primitives — is ~heavy and only ever matters once the
// dialog is opened. Code-split it out of the global app-shell chunk so the
// first paint of every route doesn't pay for it. React.lazy() resolves the
// chunk on first open; the trigger (the ⌘K shortcut wired in the app shell)
// stays instant.
const CommandPaletteBody = lazy(() =>
  import("./command-palette-body").then((m) => ({ default: m.CommandPaletteBody })),
);

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  // Latch: once the palette has been opened we keep the body mounted so the
  // Radix dialog's close animation plays and persisted state survives a
  // close/re-open without re-fetching the lazy chunk. Before the first open we
  // render nothing, so the chunk is never requested on a cold visit.
  const opened = useRef(false);
  if (open) opened.current = true;
  if (!opened.current) return null;

  // No visible fallback: the dialog body is the only thing inside, and it
  // resolves before paint on the user's first ⌘K. Radix Dialog handles focus
  // management + a11y once the body mounts with open=true.
  return (
    <Suspense fallback={null}>
      <CommandPaletteBody open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}
