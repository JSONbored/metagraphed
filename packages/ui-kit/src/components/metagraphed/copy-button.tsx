import { classNames } from "@/lib/format";
import { useCopy } from "@/hooks/use-copy";
import { CopyIconToggle } from "./copy-icon-toggle";

/**
 * Icon-only copy button with the same green-check microinteraction as
 * CopyableCode. Use this when the visible affordance is already a URL
 * or other text rendered alongside (table rows, inline rails, etc).
 */
export function CopyButton({
  value,
  label,
  className,
  compact,
}: {
  value: string;
  label?: string;
  className?: string;
  /**
   * Pass true inside a dense table/list row. The 44px min-h-11/min-w-11
   * touch target below is correct for a standalone header icon button,
   * but forces every row it sits in to at least 44px tall otherwise --
   * `compact` keeps the same 44px hit area (still meets touch-target
   * guidelines) while pulling it back into the row's normal flow with a
   * negative margin, so the row renders at its natural (usually ~36px)
   * height instead. Every table-row CopyButton in this app needs this;
   * before this prop existed, each call site copy-pasted its own
   * `className="-my-3.5"` to get the same result -- several did, several
   * didn't, and the ones that didn't silently inflated their row height.
   */
  compact?: boolean;
}) {
  const { copied, copy } = useCopy({ label });
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
      title={copied ? "Copied!" : `Copy ${label ?? "value"}`}
      className={classNames(
        // min-h-11 min-w-11 gives the icon-only button the same 44px minimum
        // touch target as every other header icon button in the shell (the
        // convention list-shell.tsx documents); p-1 keeps the icon itself compact
        // and centered within that hit area.
        "shrink-0 inline-flex items-center justify-center rounded p-1 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong transition-colors",
        compact && "-my-3.5",
        className,
      )}
    >
      <CopyIconToggle copied={copied} />
    </button>
  );
}
