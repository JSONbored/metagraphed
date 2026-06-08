import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import { Skeleton } from "./states";

/**
 * Shared responsive shell for list/table routes.
 *
 * - `filters` renders inside a sticky filter bar that hugs the app header on
 *   mobile and remains visible while the user scrolls a long list.
 * - `cards` renders on viewports < md and provides a tap-friendly card
 *   fallback for tabular data.
 * - `table` renders on viewports >= md with horizontal scroll for overflow.
 *
 * All interactive elements should target min-h-11 for comfortable tap targets.
 */
export function ListShell({
  filters,
  cards,
  table,
  footer,
  empty,
  isEmpty,
  isStale,
}: {
  filters: ReactNode;
  cards?: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  isEmpty?: boolean;
  /** Subtly dim loaded content while a background refetch is in flight. */
  isStale?: boolean;
}) {
  return (
    <div>
      <div
        className={classNames(
          // Sticky filter bar. Offset matches header height (h-14).
          "sticky top-14 z-10 -mx-4 md:mx-0 mb-3",
          "bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80",
          "border-b border-border md:border md:rounded md:bg-card",
          "px-3 py-2 md:p-2.5",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">{filters}</div>
      </div>

      {isEmpty ? (
        empty
      ) : (
        <div className={isStale ? "opacity-70 transition-opacity" : undefined}>
          {cards ? <div className="md:hidden space-y-2">{cards}</div> : null}
          <div className={cards ? "hidden md:block" : undefined}>
            <div className="rounded border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">{table}</div>
              {footer}
            </div>
          </div>
          {cards && footer ? (
            <div className="md:hidden mt-3">{footer}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Tap-friendly card row used by mobile card fallbacks.
 * Targets a 44px minimum height for accessible tap targets.
 */
export function ListCard({
  to,
  onClick,
  children,
}: {
  to?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const cls =
    "block rounded border border-border bg-card p-3 min-h-11 hover:border-ink/30 active:bg-surface transition-colors";
  if (to) {
    return (
      <a href={to} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={`${cls} text-left w-full`}>
      {children}
    </button>
  );
}

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
      <div className="border-t border-border bg-surface/30 p-3 space-y-1.5" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading more results…</span>
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-[11px]">
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
      <div className="flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-[11px] text-health-warn">
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
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted">
      <span>
        {shown}
        {total != null ? ` of ${total}` : ""}
      </span>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-[11px] font-medium hover:border-ink/30 min-h-9"
        >
          Load more
        </button>
      ) : (
        <span className="opacity-60">end of list</span>
      )}
    </div>
  );
}
