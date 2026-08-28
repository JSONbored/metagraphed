import { lazy, Suspense, useRef } from "react";
import type { CommandPaletteProps } from "./command-palette-body";

type CommandPaletteModule = {
  default: typeof import("./command-palette-body").CommandPaletteBody;
};

// The ⌘K palette body — search index, scope filters, route index, analytics,
// and the cmdk command primitives — is ~heavy and only ever matters once the
// dialog is opened. Code-split it out of the global app-shell chunk so the
// first paint of every route doesn't pay for it. React.lazy() resolves the
// chunk on first open; the trigger (the ⌘K shortcut wired in the app shell)
// stays instant.
let commandPaletteLoad: Promise<CommandPaletteModule> | null = null;

function loadCommandPalette(): Promise<CommandPaletteModule> {
  commandPaletteLoad ??= import("./command-palette-body").then((m) => ({
    default: m.CommandPaletteBody,
  }));
  return commandPaletteLoad;
}

const CommandPaletteBody = lazy(loadCommandPalette);

/**
 * Start loading search only after a reader shows intent (pointer hover or
 * keyboard focus). This keeps the route shell lean while removing the first
 * open's avoidable network wait, especially on a phone where the palette is
 * the primary search surface.
 */
export function preloadCommandPalette(): void {
  void loadCommandPalette();
}

function CommandPaletteOpening() {
  // This is intentionally a status, not a second temporary dialog: a dialog
  // that does not yet contain the search field cannot safely own focus. The
  // real command dialog takes focus as soon as its code arrives; until then a
  // compact, non-blocking acknowledgement is better than a blank first tap.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Opening search"
      className="pointer-events-none fixed left-1/2 top-1/2 z-[var(--mg-z-modal)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 border border-border bg-paper px-4 py-3 text-13 text-ink-muted"
    >
      <span className="inline-flex items-center gap-2">
        <span className="mg-fact-loading h-3 w-16" aria-hidden="true" />
        Opening search…
      </span>
    </div>
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  // Latch: once the palette has been opened we keep the body mounted so the
  // Radix dialog's close animation plays and persisted state survives a
  // close/re-open without re-fetching the lazy chunk. Before the first open we
  // render nothing, so the chunk is never requested on a cold visit.
  const opened = useRef(false);
  if (open) opened.current = true;
  if (!opened.current) return null;

  // The dialog body resolves before paint on a warm first open. A cold,
  // intentional open gets a small status instead of a blank beat. Radix Dialog handles focus
  // management + a11y once the body mounts with open=true.
  return (
    <Suspense fallback={<CommandPaletteOpening />}>
      <CommandPaletteBody open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}
