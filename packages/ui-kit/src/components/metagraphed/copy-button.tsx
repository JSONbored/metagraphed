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
        "shrink-0 inline-flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong transition-colors",
        className,
      )}
    >
      <CopyIconToggle copied={copied} />
    </button>
  );
}
