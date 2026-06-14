import { Check, Copy } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import { useCopy } from "@/hooks/use-copy";

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
      <span className="relative inline-flex size-3 items-center justify-center" aria-hidden>
        <Check
          className={classNames(
            "absolute size-3 text-health-ok transition-all duration-150",
            copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
        <Copy
          className={classNames(
            "absolute size-3 transition-all duration-150",
            copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
          )}
        />
      </span>
    </button>
  );
}
