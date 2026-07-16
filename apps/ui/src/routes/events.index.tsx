import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { SearchInput } from "@/components/metagraphed/table-controls";
import {
  TimeAgo,
  PageHero,
  ListShell,
  LoadMore,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
} from "@jsonbored/ui-kit";
import { chainEventsInfiniteQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import type { ChainEvent } from "@/lib/metagraphed/types";

const eventsSearchSchema = z.object({
  // Server-side filters wired to the /api/v1/chain-events feed. `method` is only
  // meaningful alongside a `pallet`, matching the embedded explorer feed (#6268).
  pallet: fallback(z.string(), "").default(""),
  method: fallback(z.string(), "").default(""),
  cursor: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/events/")({
  validateSearch: zodValidator(eventsSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain events — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor pallet events indexed from the chain — pallet.method, block, and observation time, newest first.",
      },
      { property: "og:title", content: "Chain events — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor pallet events indexed from the chain — pallet.method, block, and observation time, newest first.",
      },
    ],
  }),
  component: EventsPage,
});

type EventsSearch = z.infer<typeof eventsSearchSchema>;

function eventsQueryParams(search: EventsSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {};
  const pallet = search.pallet.trim();
  const method = search.method.trim();
  if (pallet) queryParams.pallet = pallet;
  if (pallet && method) queryParams.method = method;
  return queryParams;
}

function EventsPage() {
  const search = Route.useSearch();
  const eventsCsvUrl = buildUrl("/api/v1/chain-events", eventsQueryParams(search));

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Chain events"
        description="Individual Bittensor pallet events indexed directly from the chain — newest first, distinct from aggregate activity stats."
        actions={
          <ActionBar>
            <DownloadCsvButton url={eventsCsvUrl} bare />
            <ShareButton bare />
          </ActionBar>
        }
      />
      <EventsFeed />
      <ApiSourceFooter paths={["/api/v1/chain-events", "/api/v1/chain-events/stats"]} />
    </AppShell>
  );
}

function EventsFeed() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const baseParams = { ...eventsQueryParams(search), limit: 50 };

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
  } = useInfiniteQuery(chainEventsInfiniteQuery(baseParams, search.cursor));

  // Patch filter state only; reset the cursor so a new filter starts from the
  // newest page, and don't scroll to top on each keystroke (#3691).
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }) as never,
      resetScroll: false,
    });

  const pages = data?.pages ?? [];
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!(lastPage as { cursorInvalid?: boolean } | undefined)?.cursorInvalid;
  const events = pages.flatMap((p) => (p.data ?? []) as ChainEvent[]);
  const filtersActive = !!(search.pallet.trim() || search.method.trim());

  const filters = (
    <>
      <SearchInput
        value={search.pallet}
        onChange={(v) => setSearch({ pallet: v, method: v.trim() ? search.method : "" })}
        placeholder="Filter by pallet"
        className="min-w-[140px] flex-none font-mono text-[11px]"
      />
      <SearchInput
        value={search.method}
        onChange={(v) => setSearch({ method: v })}
        placeholder={search.pallet.trim() ? "Filter by method" : "Method (requires pallet)"}
        className="min-w-[140px] flex-none font-mono text-[11px]"
      />
    </>
  );

  const emptyNode = (
    <EmptyState
      title={
        filtersActive
          ? "No chain events match these filters."
          : "No chain events indexed yet — the all-events backfill fills this feed."
      }
    />
  );

  const table = (
    <table className="w-full text-left text-sm">
      <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
        <tr>
          <th className="px-4 py-2.5">Pallet.method</th>
          <th className="px-4 py-2.5">Block</th>
          <th className="px-4 py-2.5 text-right">Observed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((event) => (
          <tr
            key={`${event.block_number}-${event.event_index}`}
            className="mg-row-accent hover:bg-surface/40"
          >
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
    <div
      key={`${event.block_number}-${event.event_index}-card`}
      className="rounded border border-border bg-card p-3 min-h-11"
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
    </div>
  ));

  if (isPending) return <Skeleton className="h-96 w-full" />;
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
