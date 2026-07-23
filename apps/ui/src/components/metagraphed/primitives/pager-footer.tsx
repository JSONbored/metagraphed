import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { GhostButton } from "./ghost-button";

export type PagerFooterProps = {
  /** Human-readable count summary, e.g. "Showing 1–50 of 129". */
  summary?: React.ReactNode;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /** Optional loading marker for cursor pagination. */
  loading?: boolean;
  className?: string;
};

/**
 * Shared pagination footer for list pages and table shells. Extracts the
 * "Prev / count summary / Next" pattern that had drifted across
 * /blocks, /extrinsics, /accounts, /events, /subnets.
 */
export function PagerFooter({
  summary,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  loading,
  className,
}: PagerFooterProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 text-[12px] text-ink-muted",
        className,
      )}
    >
      <div className="min-w-0 truncate" aria-live="polite">
        {loading ? "Loading…" : summary}
      </div>
      <div className="flex items-center gap-2">
        <GhostButton
          onClick={onPrev}
          disabled={!hasPrev || loading}
          icon={<ChevronLeft className="size-3.5" />}
          aria-label="Previous page"
        >
          Prev
        </GhostButton>
        <GhostButton
          onClick={onNext}
          disabled={!hasNext || loading}
          iconRight={<ChevronRight className="size-3.5" />}
          aria-label="Next page"
        >
          Next
        </GhostButton>
      </div>
    </div>
  );
}
