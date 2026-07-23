import { Check, Copy } from "lucide-react";
import { classNames } from "@/lib/format";
import { CopyStatusRegion } from "./copy-status-region";
import { useCopy } from "@/hooks/use-copy";

interface Props {
  value: string;
  label?: string;
  className?: string;
  truncate?: boolean;
}

export function CopyableCode({
  value,
  label,
  className,
  truncate = true,
}: Props) {
  const { copied, copy } = useCopy({ label: label ?? "value" });

  return (
    <>
      <button
        type="button"
        onClick={() => copy(value)}
        title={value}
        aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
        className={classNames(
          "group inline-flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left font-mono text-[11px] text-ink hover:border-ink/30 transition-colors",
          // Matches KeyChip's ring treatment -- this one is a bordered chip like
          // KeyChip (not an icon-only hit area), so the offset ring reads cleanly
          // against the card behind it (#6371).
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          className,
        )}
      >
        {label ? (
          <span className="shrink-0 text-ink-muted mg-type-micro">{label}</span>
        ) : null}
        <code
          className={classNames(
            "min-w-0 text-ink-strong",
            truncate
              ? "truncate"
              : "truncate sm:whitespace-normal sm:break-all",
          )}
        >
          {value}
        </code>
        <span
          className="relative inline-flex size-3 shrink-0 items-center justify-center"
          aria-hidden
        >
          <Check
            className={classNames(
              "absolute size-3 text-health-ok transition-all duration-150",
              copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
            )}
          />
          <Copy
            className={classNames(
              "absolute size-3 text-ink-muted group-hover:text-ink transition-all duration-150",
              copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
            )}
          />
        </span>
      </button>
      {/* #6372: same live region as every other copy control. */}
      <CopyStatusRegion>
        {copied ? `${label ?? "Value"} copied to clipboard` : ""}
      </CopyStatusRegion>
    </>
  );
}
