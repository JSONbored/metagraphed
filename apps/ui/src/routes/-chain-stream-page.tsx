import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  DataTable,
  FilterField,
  FilterSelect,
  LoadMore,
  truncateIdentifier,
  type SectionNavLink,
} from "@jsonbored/ui-kit";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import {
  blocksQuery,
  blocksSummaryQuery,
  blockExtrinsicsInfiniteQuery,
  chainEventsInfiniteQuery,
  chainEventsStatsQuery,
  extrinsicsQuery,
} from "@/lib/metagraphed/queries";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import {
  PAGE_SIZE,
  PAGE_SIZES,
  blockRows,
  blocksFacts,
  blockQueryParams,
  eventsFacts,
  extrinsicsFacts,
  hasBlockFilters,
  hasNextPage,
  pageFacet,
  pageOf,
  withoutNoise,
} from "@/components/metagraphed/chain-stream/chain-stream-logic";
import {
  blockColumns,
  eventColumns,
  extrinsicColumns,
} from "@/components/metagraphed/chain-stream/chain-stream-columns";
import { BlockActivityWindow } from "@/components/metagraphed/chain-stream/block-activity-window";
import { StreamShell, streamEmpty } from "@/components/metagraphed/chain-stream/stream-shell";
import { ErrorState } from "@/components/metagraphed/states";
import type { BlocksSearch } from "./chain.blocks";
import type { EventsSearch } from "./chain.events";
import type { ExtrinsicsSearch } from "./chain.extrinsics";

/**
 * The three chain streams as one page (#11620) -- /chain/blocks,
 * /chain/extrinsics and /chain/events.
 *
 * They were three modules that agreed on nothing: one opened with a live rail
 * and a three-stat card, one with a 7-day fee chart, one with neither; two
 * carried a `Download CSV / Share view` bar the table menu already provides,
 * and all three put their filters in a toolbar above the table rather than in
 * its caption row. Every difference was incidental -- the pages answer the
 * same question about three different rows.
 *
 * So: hero, then exactly one `DataTable`, then `Raw`. Everything the removed
 * chrome carried is either a hero fact (the block-production stats, the author
 * concentration, the top module) or a column (the cadence heat map is the
 * `tint` on Block time), and the two things that were neither -- the fee chart
 * above the extrinsics table and the aggregate activity band above the events
 * feed -- belong to /chain, which draws both as sections.
 */

const fmt = { count: formatNumber, seconds: humaniseSeconds };

/**
 * Direct block records use a cold lakehouse read for their primary extrinsic
 * ledger. Chain-stream links are the other common entrance to that record
 * (beside the homepage rail), so a deliberate hover or keyboard focus warms
 * its compact identity record and that one ledger. The route preloader owns
 * the first; this component owns the second. The short dwell protects a
 * 50-row table from turning ordinary pointer travel into background reads.
 *
 * This lives in the stream route chunk rather than the global router link:
 * pages that cannot render a block link should not pay for the query code.
 */
const BlockStreamLink: SectionNavLink = ({ href, children, ...rest }) => {
  const match = /^\/blocks\/(\d+)$/.exec(href);
  const blockNumber = match?.[1] ?? null;
  const queryClient = useQueryClient();
  const intentTimer = useRef<number | null>(null);

  const clearIntent = useCallback(() => {
    if (intentTimer.current == null) return;
    window.clearTimeout(intentTimer.current);
    intentTimer.current = null;
  }, []);

  const beginIntent = useCallback(() => {
    if (blockNumber == null) return;
    clearIntent();
    intentTimer.current = window.setTimeout(() => {
      intentTimer.current = null;
      void queryClient.prefetchInfiniteQuery({
        ...blockExtrinsicsInfiniteQuery(blockNumber, 100),
        retry: 0,
      });
    }, 140);
  }, [blockNumber, clearIntent, queryClient]);

  useEffect(() => clearIntent, [clearIntent]);

  return (
    <Link
      to={href}
      {...rest}
      preload={blockNumber == null ? undefined : "intent"}
      preloadDelay={blockNumber == null ? undefined : 140}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") beginIntent();
      }}
      onPointerLeave={clearIntent}
      onFocus={beginIntent}
      onBlur={clearIntent}
    >
      {children}
    </Link>
  );
};

/* -- Blocks ------------------------------------------------------------- */

const BLOCK_PATHS = ["/api/v1/blocks", "/api/v1/blocks/summary"];

export function BlocksPage() {
  const search = useSearch({ from: "/chain/blocks" }) as BlocksSearch;
  const navigate = useNavigate({ from: "/chain/blocks" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  const params = blockQueryParams(search);
  const hasFilters = hasBlockFilters(search);

  // Only the first page polls: paging back through older blocks must not be
  // yanked out from under the reader by a refresh that reflows the page.
  const refetchInterval = useRefetchInterval(15_000, search.offset === 0);
  const feed = useSuspenseQuery({ ...blocksQuery(params), refetchInterval }).data;
  const summary = useQuery({ ...blocksSummaryQuery(), retry: 0 });
  const rows = useMemo(() => blockRows((feed.data ?? []) as Block[]), [feed.data]);

  const facts = blocksFacts(
    summary.data?.data,
    rows[0]?.block_number ?? null,
    fmt,
    summary.isPending,
  );
  const authors = useMemo(() => pageFacet(rows, (row) => row.author), [rows]);

  return (
    <StreamShell
      name="Blocks"
      lede="Every block the indexer has seen, newest first."
      facts={facts}
      updatedAt={rows[0]?.observed_at ?? null}
      refreshing={summary.isFetching}
      onRefresh={() => void summary.refetch()}
      apiPaths={BLOCK_PATHS}
      artifacts={["/metagraph/blocks.json"]}
    >
      <BlockActivityWindow blocks={rows} filtered={hasFilters || search.offset > 0} />
      <DataTable
        id="blocks"
        rows={rows}
        columns={blockColumns()}
        rowKey={(row) => String(row.block_number)}
        caption="Blocks"
        rowHref={(row) => `/blocks/${row.block_number}`}
        link={BlockStreamLink}
        source="chain-block"
        storageKey="mg-blocks-columns"
        hasMore={hasNextPage(rows.length, search.limit)}
        captionCount={null}
        page={pageOf(search.offset, search.limit)}
        onPage={(page) => setSearch({ offset: (page - 1) * search.limit })}
        pageSize={search.limit}
        pageSizes={PAGE_SIZES}
        onPageSize={(limit) => setSearch({ limit, offset: 0 })}
        filters={
          <FilterField label="Author">
            <FilterSelect
              value={search.author}
              onChange={(event) => setSearch({ author: event.target.value, offset: 0 })}
            >
              <option value="">Any author</option>
              {authors.map((author) => (
                <option key={author} value={author}>
                  {truncateIdentifier(author)}
                </option>
              ))}
            </FilterSelect>
          </FilterField>
        }
        empty={streamEmpty(hasFilters, "blocks", "/api/v1/blocks")}
      />
    </StreamShell>
  );
}

/* -- Extrinsics --------------------------------------------------------- */

const EXTRINSIC_PATHS = ["/api/v1/extrinsics"];

export function ExtrinsicsPage() {
  const search = useSearch({ from: "/chain/extrinsics" }) as ExtrinsicsSearch;
  const navigate = useNavigate({ from: "/chain/extrinsics" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  const params: Record<string, string | number> = { limit: search.limit, offset: search.offset };
  if (search.signer) params.signer = search.signer;
  if (search.call_module) params.call_module = search.call_module;
  if (search.call_function) params.call_function = search.call_function;
  if (search.success) params.success = search.success;

  const refetchInterval = useRefetchInterval(15_000, search.offset === 0);
  const feed = useSuspenseQuery({ ...extrinsicsQuery(params), refetchInterval }).data;
  const rows = useMemo(() => (feed.data ?? []) as Extrinsic[], [feed.data]);

  const facts = extrinsicsFacts(rows, fmt);
  const modules = useMemo(() => pageFacet(rows, (row) => row.call_module), [rows]);
  const functions = useMemo(() => pageFacet(rows, (row) => row.call_function), [rows]);

  return (
    <StreamShell
      name="Extrinsics"
      lede="Every call submitted to the chain, newest first."
      facts={facts}
      updatedAt={rows[0]?.observed_at ?? null}
      refreshing={false}
      onRefresh={() => setSearch({ offset: 0 })}
      apiPaths={EXTRINSIC_PATHS}
      artifacts={["/metagraph/extrinsics.json"]}
    >
      <DataTable
        id="extrinsics"
        rows={rows}
        columns={extrinsicColumns()}
        rowKey={(row) =>
          row.extrinsic_hash || `${row.block_number ?? "?"}-${row.extrinsic_index ?? "?"}`
        }
        caption="Extrinsics"
        rowHref={(row) => (row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined)}
        link={BlockStreamLink}
        source="chain-extrinsic"
        storageKey="mg-extrinsics-columns"
        hasMore={hasNextPage(rows.length, search.limit)}
        captionCount={null}
        page={pageOf(search.offset, search.limit)}
        onPage={(page) => setSearch({ offset: (page - 1) * search.limit })}
        pageSize={search.limit}
        pageSizes={PAGE_SIZES}
        onPageSize={(limit) => setSearch({ limit, offset: 0 })}
        search={{
          value: search.signer,
          onChange: (signer) => setSearch({ signer, offset: 0 }),
          placeholder: "Signer ss58",
        }}
        filters={
          <>
            <FilterField label="Module">
              <FilterSelect
                value={search.call_module}
                onChange={(event) =>
                  setSearch({ call_module: event.target.value, call_function: "", offset: 0 })
                }
              >
                <option value="">Any module</option>
                {modules.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
            <FilterField label="Call">
              <FilterSelect
                value={search.call_function}
                onChange={(event) => setSearch({ call_function: event.target.value, offset: 0 })}
              >
                <option value="">Any call</option>
                {functions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
            <FilterField label="Result">
              <FilterSelect
                value={search.success}
                onChange={(event) => setSearch({ success: event.target.value, offset: 0 })}
              >
                <option value="">Any result</option>
                <option value="true">ok</option>
                <option value="false">failed</option>
              </FilterSelect>
            </FilterField>
          </>
        }
        empty={streamEmpty(
          Boolean(search.signer || search.call_module || search.call_function || search.success),
          "extrinsics",
          "/api/v1/extrinsics",
        )}
      />
    </StreamShell>
  );
}

/* -- Events ------------------------------------------------------------- */

const EVENT_PATHS = ["/api/v1/chain-events", "/api/v1/chain-events/stats"];
const EVENT_STATS_BLOCKS = 1000;

export function EventsPage() {
  const search = useSearch({ from: "/chain/events" }) as EventsSearch;
  const navigate = useNavigate({ from: "/chain/events" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      resetScroll: false,
    });

  const params: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search.pallet) params.pallet = search.pallet;
  if (search.method) params.method = search.method;

  // Cursor paging, not offset: /api/v1/chain-events takes `before` / `cursor`
  // and publishes neither an offset nor a total, so there is no page N to jump
  // to and no "1-50 of" to print. `LoadMore` is what the design system offers
  // for exactly that shape; the numbered pager on the other two streams is
  // only possible because their endpoints take an offset.
  const feed = useInfiniteQuery({ ...chainEventsInfiniteQuery(params), retry: 0 });
  const stats = useQuery({ ...chainEventsStatsQuery(EVENT_STATS_BLOCKS), retry: 0 });

  const fetched = useMemo(
    () => (feed.data?.pages ?? []).flatMap((page) => page.data as ChainEvent[]),
    [feed.data],
  );
  const { rows, hidden } = useMemo(
    () => withoutNoise(fetched, search.noise),
    [fetched, search.noise],
  );
  const facts = eventsFacts(stats.data?.data, fmt, stats.isPending);

  // The pallet and event lists come from the STATS endpoint, which counts a
  // real block window, rather than from the rows on screen: the feed is
  // newest-first, so a quiet minute would silently shrink the filter to
  // whatever happened to have just been emitted.
  // Memoised, not inlined: `?? []` builds a fresh array on every render, and
  // the two useMemos below would then recompute their facets every time.
  const activity = useMemo(() => stats.data?.data.activity ?? [], [stats.data]);
  const pallets = useMemo(() => pageFacet(activity, (row) => row.pallet), [activity]);
  const methods = useMemo(
    () =>
      pageFacet(
        activity.filter((row) => !search.pallet || row.pallet === search.pallet),
        (row) => row.method,
      ),
    [activity, search.pallet],
  );

  return (
    <StreamShell
      name="Events"
      lede="What the runtime emitted while executing those calls, newest first."
      facts={facts}
      updatedAt={rows[0]?.observed_at ?? null}
      refreshing={feed.isFetching && !feed.isFetchingNextPage}
      onRefresh={() => void feed.refetch()}
      apiPaths={EVENT_PATHS}
    >
      <DataTable
        id="events"
        rows={rows}
        columns={eventColumns()}
        rowKey={(row) => `${row.block_number ?? "?"}-${row.event_index ?? "?"}`}
        caption={
          hidden > 0 ? `Chain events (${formatNumber(hidden)} plumbing hidden)` : "Chain events"
        }
        link={BlockStreamLink}
        source="chain-event"
        storageKey="mg-events-columns"
        paginate={false}
        loading={feed.isPending}
        error={
          feed.isError ? (
            <ErrorState
              error={feed.error}
              context="chain events"
              onRetry={() => void feed.refetch()}
            />
          ) : undefined
        }
        // The args blob is the one field with no shape worth a column, so it
        // is a row expansion: the reader who needs it gets all of it, and the
        // reader who does not never sees a truncated JSON string in a cell.
        expand={(row) =>
          row.args == null ? null : (
            <pre className="mg-raw-code">{JSON.stringify(row.args, null, 2)}</pre>
          )
        }
        filters={
          <>
            <FilterField label="Pallet">
              <FilterSelect
                value={search.pallet}
                onChange={(event) =>
                  setSearch({ pallet: event.target.value, method: "", cursor: "" })
                }
              >
                <option value="">Any pallet</option>
                {pallets.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
            <FilterField label="Event">
              <FilterSelect
                value={search.method}
                onChange={(event) => setSearch({ method: event.target.value, cursor: "" })}
              >
                <option value="">Any event</option>
                {methods.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </FilterSelect>
            </FilterField>
            <FilterField label="Plumbing">
              <FilterSelect
                value={search.noise ? "1" : ""}
                onChange={(event) => setSearch({ noise: event.target.value === "1" })}
              >
                <option value="">Hidden</option>
                <option value="1">Shown</option>
              </FilterSelect>
            </FilterField>
          </>
        }
        // `hidden > 0` counts as a filter: an empty table under the plumbing
        // switch means "we hid them all", not "the feed is empty", and only
        // the second deserves the API link.
        empty={streamEmpty(
          Boolean(search.pallet || search.method || hidden > 0),
          "chain events",
          "/api/v1/chain-events",
        )}
      />
      {/* Only while there is more to fetch. A cursor feed has no total or
          terminal range to repeat beneath the table. */}
      {feed.hasNextPage || (feed.error && fetched.length > 0) ? (
        <LoadMore
          hasMore={feed.hasNextPage}
          isLoading={feed.isFetchingNextPage}
          onLoadMore={() => void feed.fetchNextPage()}
          shown={rows.length}
          error={feed.error}
        />
      ) : null}
    </StreamShell>
  );
}
