import { Check, Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  /** Full value (e.g. coldkey/hotkey/long hash). */
  value: string;
  /** Optional accessible label for screen readers (defaults to "value"). */
  label?: string;
  /** Characters kept from the start before the ellipsis. */
  head?: number;
  /** Characters kept from the end after the ellipsis. */
  tail?: number;
  className?: string;
}

/**
 * Compact, head/tail-truncated chip for long hashes (coldkey, hotkey, etc).
 * Hover/focus shows the full value in a tooltip + offers a copy action.
 * Replaces the old wide CopyableCode for short-width contexts so the chip
 * cannot push its container into a horizontal scrollbar.
 */
export function KeyChip({ value, label = "value", head = 8, tail = 6, className }: Props) {
  const { copied, copy } = useCopy({ label });
  const short =
    value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;

  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={copied ? `${label} copied` : `Copy ${label}: ${value}`}
          className={classNames(
            "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-left font-mono text-[11px] text-ink-strong hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card transition-colors",
            className,
          )}
        >
          <span className="truncate tabular-nums">{short}</span>
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
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[90vw] break-all font-mono text-[11px]">
        <span className="mr-1 uppercase tracking-widest text-[9px] opacity-70">{label}</span>
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
