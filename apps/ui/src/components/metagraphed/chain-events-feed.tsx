import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { API_BASE } from "@/lib/metagraphed/config";
import { ResetFiltersButton, SearchInput } from "@/components/metagraphed/table-controls";
import { TimeAgo, ListShell, LoadMore, LiveTickerProvider } from "@jsonbored/ui-kit";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { StreamStatusChip } from "@/components/metagraphed/stream-status-chip";
import { chainEventsInfiniteQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, formatTao } from "@/lib/metagraphed/format";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { summarizeChainEvent, isNoiseEvent } from "@/lib/metagraphed/chain-event-summary";
import { summarizeEvent } from "@/lib/metagraphed/chain-summaries";
import type { ChainEvent } from "@/lib/metagraphed/types";
import { chainStreamEventMatchesFilters, useChainStream } from "@/hooks/use-chain-stream";

const TH = "px-4 py-2.5 mg-type-caption text-ink-muted";

/** Subnet chip for a decoded `netuid` arg — links to that subnet. */
function SubnetChip({ netuid }: { netuid: number }) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid }}
      className="inline-flex items-center rounded-full border border-border bg-paper px-2 py-0.5 mg-type-micro text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
    >
      SN{netuid}
    </Link>
  );
}

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

/**
 * One chain-event row in card form — who/what/how-much/where, newest data
 * first. Shared by the full feed's mobile card layout and any bounded
 * preview that reuses the same row shape (metagraphed#8359).
 */
export function ChainEventCard({ event }: { event: ChainEvent }) {
  const s = summarizeChainEvent(event.args);
  // #8371: leads with the human-readable sentence when a template covers
  // this pallet.method; falls back to today's raw module.function otherwise
  // -- never a guessed sentence.
  const sentence = summarizeEvent(event.pallet, event.method, event.args);
  return (
    <Panel as="div" dense className="min-h-11">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="min-w-0 truncate mg-type-data text-ink-strong"
          title={sentence ?? undefined}
        >
          {sentence ?? extrinsicCall(event.pallet, event.method)}
        </span>
        {s.amountTao != null ? (
          <span className="shrink-0 mg-type-data tabular-nums text-ink">
            {formatTao(s.amountTao)}
          </span>
        ) : null}
      </div>
      {s.from || s.to ? (
        <div className="mt-1 flex items-center gap-1.5 mg-type-data-sm text-ink-muted">
          <AddressDisplay ss58={s.from} compact fallback="—" />
          {s.to ? (
            <>
              <span aria-hidden>→</span>
              <AddressDisplay ss58={s.to} compact fallback="—" />
            </>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 flex items-center justify-between gap-2 mg-type-data-sm text-ink-muted">
        <span className="flex items-center gap-2">
          {s.netuid != null ? <SubnetChip netuid={s.netuid} /> : null}
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
        </span>
        <TimeAgo at={event.observed_at} />
      </div>
    </Panel>
  );
}

interface Props {
  pallet: string;
  method: string;
  cursor: string;
  /**
   * #8253: show the high-volume plumbing events. Defaults to false (hidden)
   * at every call site; the flag exists so the raw firehose stays reachable.
   */
  showNoise?: boolean;
  /**
   * Patch the pallet/method filter state. The caller owns URL state and is
   * responsible for resetting its own cursor param so a new filter restarts
   * from the newest page.
   */
  onFilter: (patch: { pallet?: string; method?: string; noise?: boolean }) => void;
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
export function ChainEventsFeed({ pallet, method, cursor, showNoise = false, onFilter }: Props) {
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
  const allEvents = pages.flatMap((p) => (p.data ?? []) as ChainEvent[]);
  // #8253: noise filtering is CLIENT-side because the API has no "exclude
  // these pallet.methods" param -- it only filters TO a pallet/method, not
  // away from several. That means a page can arrive mostly-hidden; the
  // hidden-count line below says so explicitly rather than leaving a reader
  // wondering why 50 fetched rows rendered as 16.
  const events = showNoise ? allEvents : allEvents.filter((e) => !isNoiseEvent(e.pallet, e.method));
  const hiddenCount = allEvents.length - events.length;
  const filtersActive = !!(pallet.trim() || method.trim());

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
        className="min-w-[140px]! flex-none mg-type-data"
      />
      <SearchInput
        value={method}
        onChange={(v) => onFilter({ method: v })}
        placeholder={pallet.trim() ? "Filter by method" : "Method (requires pallet)"}
        className="min-w-[140px]! flex-none mg-type-data"
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
      {/* #8253: accent lit only while the toggle is NARROWING the feed --
          the same convention /subnets' own exclude-toggle uses, so the
          default (noise hidden) reads as the quiet normal state. */}
      <button
        type="button"
        onClick={() => onFilter({ noise: showNoise ? false : true })}
        aria-pressed={!showNoise}
        title={
          showNoise
            ? "Showing every event, including ExtrinsicSuccess / ExtrinsicFailed / TransactionFeePaid"
            : "System plumbing events (ExtrinsicSuccess / ExtrinsicFailed / TransactionFeePaid) are hidden — click to show them"
        }
        className={classNames(
          "mg-type-caption inline-flex min-h-9 items-center gap-1.5 rounded border px-2 py-1 transition-colors",
          !showNoise
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border bg-card text-ink-muted hover:text-ink-strong",
        )}
      >
        <span className={classNames("size-1.5 rounded-full", !showNoise && "bg-accent")} />
        Hide system noise
        {hiddenCount > 0 ? <span className="text-ink-muted">· {hiddenCount}</span> : null}
      </button>
      <StreamStatusChip status={streamStatus} testId="chain-events-stream-status" />
    </>
  );

  const emptyNode = (
    <EmptyState
      title={
        // #8253: a page that fetched rows but hid all of them is a distinct
        // state from a genuinely empty feed -- say which one it is, and offer
        // the toggle as the fix, rather than claiming nothing is indexed.
        hiddenCount > 0
          ? `Every event on this page was system noise (${hiddenCount} hidden).`
          : filtersActive
            ? "No chain events match these filters."
            : "No chain events indexed yet — the all-events backfill fills this feed."
      }
      // #6340: a genuinely-empty feed offers the same "open the API" action every
      // other empty list page does; the filtered-empty case keeps no action,
      // matching the filter-empty convention elsewhere. #8253: the
      // all-hidden-by-the-noise-toggle case is also "filtered", so it gets no
      // API link either -- the toggle beside the feed is the fix there.
      action={
        filtersActive || hiddenCount > 0
          ? undefined
          : {
              label: "Open /api/v1/chain-events",
              href: `${API_BASE}/api/v1/chain-events`,
              external: true,
            }
      }
    />
  );

  // #8253: decoded columns replace the old three-column
  // `Pallet.Method · block · age` row, which answered none of who / what /
  // how-much / where. The args have carried this all along -- see
  // lib/metagraphed/chain-event-summary.ts.
  const table = (
    <table className="w-full text-left text-sm">
      <thead className="bg-surface/40">
        <tr>
          <th className={TH}>Event</th>
          <th className={`${TH} text-right`}>Amount</th>
          <th className={TH}>From</th>
          <th className={TH}>To</th>
          <th className={TH}>Subnet</th>
          <th className={TH}>Block</th>
          <th className={`${TH} text-right`}>Observed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((event) => {
          const s = summarizeChainEvent(event.args);
          const sentence = summarizeEvent(event.pallet, event.method, event.args);
          return (
            <tr key={`${event.block_number}-${event.event_index}`} className="hover:bg-surface/40">
              <td
                className="px-4 py-2.5 mg-type-data text-ink-strong"
                title={sentence ?? undefined}
              >
                {sentence ?? extrinsicCall(event.pallet, event.method)}
              </td>
              <td className="px-4 py-2.5 text-right mg-type-data tabular-nums text-ink">
                {s.amountTao != null ? formatTao(s.amountTao) : "—"}
              </td>
              <td className="px-4 py-2.5 mg-type-data">
                <AddressDisplay ss58={s.from} compact fallback="—" />
              </td>
              <td className="px-4 py-2.5 mg-type-data">
                <AddressDisplay ss58={s.to} compact fallback="—" />
              </td>
              <td className="px-4 py-2.5 mg-type-data">
                {s.netuid != null ? <SubnetChip netuid={s.netuid} /> : "—"}
              </td>
              <td className="px-4 py-2.5 mg-type-data">
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
              <td className="px-4 py-2.5 text-right mg-type-data text-ink-muted">
                <TimeAgo at={event.observed_at} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const cards = events.map((event) => (
    <ChainEventCard key={`${event.block_number}-${event.event_index}-card`} event={event} />
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
    // #8365: a shared 1s clock for every row's TimeAgo instead of one
    // self-scheduled timer per row -- this list can carry dozens of
    // sub-minute-old rows simultaneously right after a busy block, which is
    // exactly the case a per-row timer adds up for.
    <LiveTickerProvider>
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
    </LiveTickerProvider>
  );
}
