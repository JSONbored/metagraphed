import { type ReactNode, type RefObject } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { classNames } from "@/lib/format";
import { Skeleton } from "./skeleton";

/**
 * Shared responsive shell for list/table routes.
 *
 * - `filters` renders inside a sticky filter bar that hugs the app header on
 *   mobile and remains visible while the user scrolls a long list.
 * - `cards` renders on viewports < md and provides a tap-friendly card
 *   fallback for tabular data.
 * - `table` renders on viewports >= md with horizontal scroll for overflow.
 *
 * The table's <thead> sticks against the bounded viewport this shell puts
 * around it, so consumers pin their header with `sticky top-0` and nothing
 * else. That is the ONE pattern -- a <thead> cannot stick against the page
 * from in here, and every attempt to make it do so has been inert: an
 * `overflow-x: auto` wrapper computes `overflow-y` to `auto` too (CSS
 * Overflow 3 §3: a non-`visible` value on one axis coerces the other), so
 * this wrapper is unavoidably the header's scroll container. Without a
 * max-height it simply never scrolls, and `sticky top-0` resolved to a
 * no-op on /chain/blocks, /chain/extrinsics, and three component tables --
 * headers that read as sticky in the markup but scrolled away in the
 * browser. Bounding the wrapper is what makes the declaration real.
 */
export function ListShell({
  filters,
  cards,
  table,
  footer,
  empty,
  isEmpty,
  isStale,
  viewportRef,
  stickyHeader = true,
}: {
  filters: ReactNode;
  cards?: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  isEmpty?: boolean;
  /** Subtly dim loaded content while a background refetch is in flight. */
  isStale?: boolean;
  /**
   * Handle on the bounded viewport, for a virtualizer's `getScrollElement`.
   *
   * Exists so a virtualized route doesn't hand-roll a second bounded div
   * inside this one just to own a ref -- /subnets did exactly that and ended
   * up with two nested `max-h-[70vh]` scrollers, the outer one permanently
   * inert. There is one viewport per list, and this is how you reach it.
   */
  viewportRef?: RefObject<HTMLDivElement | null>;
  /**
   * Pin the table header inside a bounded viewport (default). Pass `false`
   * for a list that should simply scroll with the page, header and all.
   *
   * This is honoured again. It spent a while destructured to `_stickyHeader`
   * and ignored, which was invisible only because stickiness was inert
   * everywhere at the time -- an `overflow-x-auto` wrapper with no
   * max-height is a containing block that never scrolls, so `sticky top-0`
   * did nothing regardless of what any prop said. Now that headers really
   * pin, ignoring it would silently give /surfaces -- the one caller that
   * passes `false` -- the exact behaviour it opted out of.
   */
  stickyHeader?: boolean;
}) {
  const tableCard = "rounded border border-border bg-card overflow-hidden";
  // .mg-table-scroll brings the edge-fade + thin scrollbar; .mg-list-viewport
  // brings the height cap, both overflow axes and overscroll containment. They
  // belong on the SAME element (see the note below).
  const viewportClass = stickyHeader
    ? "mg-table-scroll mg-list-viewport"
    : "mg-table-scroll overflow-x-auto";
  return (
    <div>
      <div
        className={classNames(
          // Sticky below `md`, in normal flow at and above it. Offset reads
          // --mg-sticky-offset (published by AppShell to match real header +
          // ticker height) with a fallback.
          //
          // The breakpoint is the same one that swaps cards for the table,
          // and that is the whole reason for it: a page-sticky filter bar and
          // a table header pinned inside a bounded viewport are in different
          // scroll contexts, so once the page scrolls far enough for the
          // table's top to pass under this bar, the bar covers the header --
          // the column labels disappear again, by a different mechanism than
          // the one they were just fixed for. Below `md` there is no table
          // (cards render instead), nothing to cover, and a filter bar that
          // follows a long list is genuinely useful, so it stays pinned.
          //
          // /subnets reached this conclusion first and encoded it as a
          // page-specific override in apps/ui/src/styles.css
          // (`#subnets-list > div > div:first-child { position: static }`,
          // at >=1024px only, which is why tablet still showed the overlap).
          // That override is deleted; this is the general rule.
          "sticky md:static z-[var(--mg-z-raised)] -mx-4 md:mx-0 mb-3",
          "bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80",
          "border-b border-border md:border md:rounded md:bg-card",
          "px-3 py-2 md:p-2.5",
        )}
        // --mg-sticky-offset is the app header (published by AppShell);
        // --mg-tabs-h is the page's sticky tab strip, 0 when there isn't one.
        // Without the second term this bar pinned to the same offset as the
        // hub tabs on /chain and overlapped them on scroll (#8254).
        style={{
          top: "calc(var(--mg-sticky-offset, 3.5rem) + var(--mg-tabs-h, 0px))",
        }}
      >
        <div className="flex flex-wrap items-center gap-2">{filters}</div>
      </div>

      {isEmpty ? (
        // Marked so a test can tell "this list rendered nothing" apart from
        // "this list rendered fine". The responsive-overflow sweep only ever
        // asserted that nothing OVERFLOWS, and an empty page cannot overflow,
        // so a route whose fixture had gone stale rendered no rows at all and
        // still passed -- /chain/extrinsics sat like that undetected. This
        // attribute is what makes that state observable.
        <div data-mg-list-empty="">{empty}</div>
      ) : (
        <div className={isStale ? "opacity-70 transition-opacity" : undefined}>
          {cards ? <div className="md:hidden space-y-2">{cards}</div> : null}
          <div className={cards ? "hidden md:block" : undefined}>
            <div className={tableCard}>
              {/* ONE scroll container, both axes. These used to be two
                  nested divs -- .mg-table-scroll for x, an inner bounded div
                  for y -- and that does not work: `overflow-y: auto` coerces
                  `overflow-x` to `auto` as well, so the inner div quietly took
                  the horizontal axis too and left .mg-table-scroll unable to
                  scroll at all. Its edge-fade and thin-scrollbar styling then
                  applied to an element that never moved, while a 15px default
                  scrollbar appeared inside the bounded region. Same coercion
                  rule that made the headers inert in the first place. */}
              <div ref={viewportRef} className={viewportClass}>
                {table}
              </div>
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
        className="border-t border-border bg-surface/30 p-3 space-y-1.5"
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
      <div className="flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 mg-type-caption">
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
      <div className="flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 mg-type-caption text-health-warn">
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
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 mg-type-data text-ink-muted">
      <span>
        {shown}
        {total != null ? ` of ${total}` : ""}
      </span>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="inline-flex items-center rounded border border-border bg-card px-3 py-1.5 mg-type-caption font-medium hover:border-ink/30 min-h-9"
        >
          Load more
        </button>
      ) : (
        <span className="opacity-60">end of list</span>
      )}
    </div>
  );
}
