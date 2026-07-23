import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { API_BASE } from "@/lib/metagraphed/config";
import { ResetFiltersButton, SearchInput } from "@/components/metagraphed/table-controls";
import { TimeAgo, ListShell, LoadMore } from "@jsonbored/ui-kit";
import { chainEventsInfiniteQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import type { ChainEvent } from "@/lib/metagraphed/types";
import { chainStreamEventMatchesFilters, useChainStream } from "@/hooks/use-chain-stream";

const TH = "px-4 py-2.5 mg-type-micro text-ink-muted";

/** Page size for the raw all-events feed, shared by /events and /explorer. */
export const CHAIN_EVENTS_PAGE_SIZE = 50;

/**
 * Build the `/api/v1/chain-events` query params from filter state. `method` is
 * only meaningful alongside a `pallet`, so it's dropped when `pallet` is empty —
 * mirroring the API's conjunctive filter contract.
 */
export function chainEventsBaseParams(
  pallet: string,
  method: string,
): Record<string, string | number> {
  const p = pallet.trim();
  const m = method.trim();
  const params: Record<string, string | number> = { limit: CHAIN_EVENTS_PAGE_SIZE };
  if (p) params.pallet = p;
  if (p && m) params.method = m;
  return params;
}

interface Props {
  pallet: string;
  method: string;
  cursor: string;
  /**
   * Patch the pallet/method filter state. The caller owns URL state and is
   * responsible for resetting its own cursor param so a new filter restarts
   * from the newest page.
   */
  onFilter: (patch: { pallet?: string; method?: string }) => void;
}

/**
 * The raw all-events feed (ADR 0013) — cursor-paginated, newest-first, with
 * pallet/method filters. Rendered both as an embedded section on /explorer and
 * as the standalone /events route, so it lives here as one shared component to
 * keep the two in sync.
 *
 * #7008: also listens to `GET /api/v1/chain/stream` (SSE) so matching
 * `chain_events` frames trigger a refetch — EventSource auto-reconnects, and
 * the existing manual/stale-refresh path remains the gap-cover when the stream
 * is down.
 */
export function ChainEventsFeed({ pallet, method, cursor, onFilter }: Props) {
  const baseParams = chainEventsBaseParams(pallet, method);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error,
    isPending,
    isFetching,
    refetch,
  } = useInfiniteQuery(chainEventsInfiniteQuery(baseParams, cursor));

  const { status: streamStatus } = useChainStream({
    topics: ["chain_events"],
    matches: (payload) => chainStreamEventMatchesFilters(payload, pallet, method),
    onEvent: () => {
      void refetch();
    },
  });

  const pages = data?.pages ?? [];
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!(lastPage as { cursorInvalid?: boolean } | undefined)?.cursorInvalid;
  const events = pages.flatMap((p) => (p.data ?? []) as ChainEvent[]);
  const filtersActive = !!(pallet.trim() || method.trim());

  const streamLabel =
    streamStatus === "open"
      ? "Live"
      : streamStatus === "connecting"
        ? "Connecting"
        : streamStatus === "error"
          ? "Polling"
          : null;

  const filters = (
    <>
      <SearchInput
        value={pallet}
        onChange={(v) => onFilter({ pallet: v, method: v.trim() ? method : "" })}
        placeholder="Filter by pallet"
        // SearchInput's own base hardcodes `min-w-[180px]` unconditionally, which
        // wins the same-property (min-width) cascade over a plain `min-w-[140px]`
        // override regardless of prop order (classNames() is a plain string-join,
        // not tailwind-merge-aware -- see #6904); the trailing `!` forces this
        // narrower floor to actually apply for these compact pallet/method filters.
        className="min-w-[140px]! flex-none font-mono text-[11px]"
      />
      <SearchInput
        value={method}
        onChange={(v) => onFilter({ method: v })}
        placeholder={pallet.trim() ? "Filter by method" : "Method (requires pallet)"}
        className="min-w-[140px]! flex-none font-mono text-[11px]"
      />
      {/* #6387: a filtered /events?pallet=X or /explorer?pallet=X link is
          URL-persisted and otherwise stuck until manually cleared, unlike every
          other filterable feed (blocks/extrinsics/providers/surfaces/subnets),
          which all render a ResetFiltersButton. Clearing pallet+method via the
          existing onFilter also resets the cursor at both call sites. */}
      <ResetFiltersButton
        active={filtersActive}
        onReset={() => onFilter({ pallet: "", method: "" })}
      />
      {streamLabel ? (
        <span
          className={classNames(
            "inline-flex items-center gap-1.5 rounded border px-2 py-1 mg-type-micro",
            streamStatus === "open"
              ? "border-accent/40 bg-accent/10 text-accent-text"
              : "border-border bg-surface text-ink-muted",
          )}
          title={
            streamStatus === "open"
              ? "Connected to /api/v1/chain/stream — new matching events refresh this feed"
              : streamStatus === "error"
                ? "Chain stream unavailable — refresh manually or wait for reconnect"
                : "Opening /api/v1/chain/stream"
          }
          data-testid="chain-events-stream-status"
          data-stream-status={streamStatus}
        >
          {streamStatus === "open" ? <span className="mg-live-dot" aria-hidden /> : null}
          {streamLabel}
        </span>
      ) : null}
    </>
  );

  const emptyNode = (
    <EmptyState
      title={
        filtersActive
          ? "No chain events match these filters."
          : "No chain events indexed yet — the all-events backfill fills this feed."
      }
      // #6340: a genuinely-empty feed offers the same "open the API" action every
      // other empty list page does; the filtered-empty case keeps no action,
      // matching the filter-empty convention elsewhere.
      action={
        filtersActive
          ? undefined
          : {
              label: "Open /api/v1/chain-events",
              href: `${API_BASE}/api/v1/chain-events`,
              external: true,
            }
      }
    />
  );

  const table = (
    <table className="w-full text-left text-sm">
      <thead className="bg-surface/40">
        <tr>
          <th className={TH}>Pallet.method</th>
          <th className={TH}>Block</th>
          <th className={`${TH} text-right`}>Observed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((event) => (
          <tr key={`${event.block_number}-${event.event_index}`} className="hover:bg-surface/40">
            <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
              {extrinsicCall(event.pallet, event.method)}
            </td>
            <td className="px-4 py-2.5 font-mono text-[11px]">
              {event.block_number != null ? (
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(event.block_number) }}
                  className="text-ink-strong hover:text-accent hover:underline"
                >
                  #{formatNumber(event.block_number)}
                </Link>
              ) : (
                "—"
              )}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
              <TimeAgo at={event.observed_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const cards = events.map((event) => (
    <Panel
      as="div"
      dense
      key={`${event.block_number}-${event.event_index}-card`}
      className="min-h-11"
    >
      <div className="font-mono text-[11px] text-ink-strong">
        {extrinsicCall(event.pallet, event.method)}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-muted">
        {event.block_number != null ? (
          <Link
            to="/blocks/$ref"
            params={{ ref: String(event.block_number) }}
            className="hover:text-accent hover:underline"
          >
            #{formatNumber(event.block_number)}
          </Link>
        ) : (
          <span>—</span>
        )}
        <TimeAgo at={event.observed_at} />
      </div>
    </Panel>
  ));

  if (isPending) return <Skeleton className="h-56 w-full" />;
  if (error && !data)
    return (
      <ErrorState
        error={error}
        context="chain events feed"
        onRetry={() => {
          void refetch();
        }}
      />
    );

  return (
    <ListShell
      filters={filters}
      table={table}
      cards={cards}
      isEmpty={events.length === 0 && !isFetching}
      empty={emptyNode}
      isStale={isFetching && !isPending && !isFetchingNextPage}
      footer={
        events.length > 0 ? (
          <LoadMore
            hasMore={!!hasNextPage}
            isLoading={isFetchingNextPage}
            onLoadMore={() => {
              void fetchNextPage();
            }}
            shown={events.length}
            error={isFetchNextPageError ? error : null}
            cursorInvalid={cursorInvalid}
          />
        ) : undefined
      }
    />
  );
}
