import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { classNames } from "@/lib/format";
import { CopyIconToggle } from "./copy-icon-toggle";
import { CopyStatusRegion } from "./copy-status-region";

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
export function KeyChip({
  value,
  label = "value",
  head = 8,
  tail = 6,
  className,
}: Props) {
  const { copied, copy } = useCopy({ label });
  const short =
    value.length > head + tail + 1
      ? `${value.slice(0, head)}…${value.slice(-tail)}`
      : value;

  return (
    // Self-wrapped so KeyChip works outside AppShell's global provider.
    <TooltipProvider>
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
            <CopyIconToggle
              copied={copied}
              className="text-ink-muted group-hover:text-ink"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[90vw] break-all font-mono text-[11px]"
        >
          <span className="mr-1 uppercase tracking-widest text-[9px] opacity-70">
            {label}
          </span>
          {value}
        </TooltipContent>
      </Tooltip>
      {/* #6372: the tooltip is pointer/focus affordance only -- the copy result
          still needs its own live region, same as every sibling control. */}
      <CopyStatusRegion>
        {copied ? `${label} copied to clipboard` : ""}
      </CopyStatusRegion>
    </TooltipProvider>
  );
}
