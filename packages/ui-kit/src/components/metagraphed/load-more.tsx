import { AlertCircle, RefreshCw } from "lucide-react";
import { Skeleton } from "./skeleton";

/**
 * Cursor-pagination "Load more" affordance with skeletons during fetch and
 * an inline retry strip on error. Keeps already-loaded rows visible.
 */
export function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
  shown,
  total,
  error,
  cursorInvalid,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  shown: number;
  total?: number;
  /** Network / API error from the most recent fetchNextPage. */
  error?: Error | null;
  /** API returned a next_cursor we couldn't trust — stop and inform. */
  cursorInvalid?: boolean;
}) {
  // Skeleton "incoming rows" while a fetch is in flight.
  if (isLoading) {
    return (
      <div
        className="border-t border-border bg-surface p-3 space-y-1.5"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="sr-only">Loading more results…</span>
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-13">
        <span className="inline-flex items-center gap-1.5 text-health-down">
          <AlertCircle className="size-3" />
          Couldn&rsquo;t load more — {error.message || "network error"}.
        </span>
        <button
          type="button"
          onClick={onLoadMore}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 font-medium hover:border-ink/30 min-h-9"
        >
          <RefreshCw className="size-3" /> Retry
        </button>
      </div>
    );
  }

  if (cursorInvalid) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-13 text-health-warn">
        <span className="inline-flex items-center gap-1.5">
          <AlertCircle className="size-3" />
          Pagination stopped — the server returned an invalid next cursor.
        </span>
        <span className="font-mono text-ink-muted">
          {shown}
          {total != null ? ` / ${total}` : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface px-4 py-2 text-11 text-ink-muted">
      <span>
        {shown}
        {total != null ? ` of ${total}` : ""}
      </span>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-13 font-medium hover:border-ink/30 min-h-9"
        >
          Load more
        </button>
      ) : (
        <span className="opacity-60">end of list</span>
      )}
    </div>
  );
}
