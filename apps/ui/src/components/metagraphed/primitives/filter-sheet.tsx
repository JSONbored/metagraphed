import { useEffect, useState, type ReactNode } from "react";
import { Filter, X } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

export interface FilterSheetProps {
  /** Trigger label — usually "Filters". */
  label?: string;
  /** Count of active filters, shown as a pill on the trigger. */
  activeCount?: number;
  /** Filter controls to render inside the sheet. */
  children: ReactNode;
  className?: string;
}

/**
 * Mobile-first drawer that hosts secondary filter controls. Trigger is
 * a compact button showing an active-count pill; on click it opens a
 * bottom sheet on mobile / side panel on tablet+. Keeps <StickyToolbar>
 * clean on narrow viewports.
 *
 * Designed to be hidden above `md:` via `md:hidden` wrapper in callers.
 */
export function FilterSheet({
  label = "Filters",
  activeCount = 0,
  children,
  className,
}: FilterSheetProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={classNames(
          "inline-flex min-h-9 items-center gap-1.5 rounded border px-2.5 py-1",
          "mg-type-label uppercase transition-colors",
          activeCount > 0
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border bg-card text-ink-strong hover:border-accent/40",
        )}
      >
        <Filter className="size-3.5" aria-hidden />
        {label}
        {activeCount > 0 ? (
          <span className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full bg-accent text-[9px] text-accent-foreground">
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
        >
          <div
            className="absolute inset-0 bg-ink-strong/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className={classNames(
              "relative z-10 w-full max-h-[85vh] overflow-y-auto",
              "rounded-t-xl border-t border-border bg-card p-4",
              "sm:max-w-md sm:rounded-xl sm:border sm:mx-4",
              "mg-scroll",
            )}
          >
            <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
              <span className="mg-type-label uppercase text-ink-strong">
                {label}
                {activeCount > 0 ? (
                  <span className="ml-2 text-ink-muted">· {activeCount} active</span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close filters"
                className="inline-flex size-8 items-center justify-center rounded text-ink-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="flex flex-col gap-3">{children}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
