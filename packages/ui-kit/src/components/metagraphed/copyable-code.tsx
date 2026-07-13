import { Check, Copy } from "lucide-react";
import { classNames } from "@/lib/format";
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
    <button
      type="button"
      onClick={() => copy(value)}
      title={value}
      aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
      className={classNames(
        "group inline-flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left font-mono text-[11px] text-ink hover:border-ink/30 transition-colors",
        className,
      )}
    >
      {label ? (
        <span className="shrink-0 text-ink-muted uppercase tracking-wider text-[10px]">
          {label}
        </span>
      ) : null}
      <code
        className={classNames(
          "min-w-0 text-ink-strong",
          truncate ? "truncate" : "truncate sm:whitespace-normal sm:break-all",
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
  );
}
