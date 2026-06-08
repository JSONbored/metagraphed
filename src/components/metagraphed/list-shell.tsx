import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

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
}: {
  filters: ReactNode;
  cards?: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  isEmpty?: boolean;
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
        <>
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
        </>
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

/** Cursor-pagination "Load more" affordance. */
export function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
  shown,
  total,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  shown: number;
  total?: number;
}) {
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
          disabled={isLoading}
          className="inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-[11px] font-medium hover:border-ink/30 disabled:opacity-40 min-h-9"
        >
          {isLoading ? "Loading…" : "Load more"}
        </button>
      ) : (
        <span className="opacity-60">end of list</span>
      )}
    </div>
  );
}
