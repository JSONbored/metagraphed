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
}: {
  value: string;
  label?: string;
  className?: string;
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
        className,
      )}
    >
      <CopyIconToggle copied={copied} />
    </button>
  );
}
