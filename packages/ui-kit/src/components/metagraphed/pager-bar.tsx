import { ChevronLeft, ChevronRight } from "lucide-react";
import { ActionBar } from "./action-bar";

export interface PagerBarProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  prevLabel?: string;
  nextLabel?: string;
}

/**
 * Offset-paging Prev/Next control, sharing one connected `ActionBar` instead
 * of two separately spaced, individually-bordered buttons — the same
 * two-button idiom copy-pasted across several table/list footers.
 */
export function PagerBar({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  prevLabel = "Newer",
  nextLabel = "Older",
}: PagerBarProps) {
  const itemCls =
    "inline-flex items-center gap-1 rounded px-2.5 py-1.5 min-h-9 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted";
  return (
    <ActionBar>
      <button
        type="button"
        onClick={onPrev}
        disabled={!hasPrev}
        className={itemCls}
      >
        <ChevronLeft className="size-3" /> {prevLabel}
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        className={itemCls}
      >
        {nextLabel} <ChevronRight className="size-3" />
      </button>
    </ActionBar>
  );
}
