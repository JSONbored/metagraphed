import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChevronLeft, ChevronRight, Timer, Activity, Users, SlidersHorizontal } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { AccountCell } from "@/components/metagraphed/account-cell";
import {
  TimeAgo,
  PageHero,
  ListShell,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  StatTile,
  Sparkline,
  CopyButton,
  CopyableCode,
} from "@jsonbored/ui-kit";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
} from "@/components/metagraphed/table-controls";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { blocksQuery, blocksSummaryQuery, chainActivityQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import { activeFilterCount, filterToggleLabel } from "@/lib/metagraphed/filter-disclosure";
import { buildUrl } from "@/lib/metagraphed/client";
import { nakamotoTone } from "@/lib/metagraphed/network-decentralization";
import { shortHash } from "@/lib/metagraphed/blocks";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Block } from "@/lib/metagraphed/types";

const blocksSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  // Server-side filters wired to the /api/v1/blocks conjunctive set.
  author: fallback(z.string(), "").default(""),
  spec_version: fallback(z.string(), "").default(""),
  block_start: fallback(z.string(), "").default(""),
  block_end: fallback(z.string(), "").default(""),
  min_extrinsics: fallback(z.string(), "").default(""),
  min_events: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/blocks/")({
  validateSearch: zodValidator(blocksSearchSchema),
  head: () => ({
    meta: [
      { title: "Blocks — Metagraphed" },
      {
        name: "description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
      { property: "og:title", content: "Blocks — Metagraphed" },
      {
        property: "og:description",
        content:
          "Recent Bittensor blocks indexed from the chain — block number, hash, author, extrinsic and event counts, newest first.",
      },
    ],
  }),
  component: BlocksPage,
});

type BlocksSearch = z.infer<typeof blocksSearchSchema>;

function blocksQueryParams(search: BlocksSearch): Record<string, string | number> {
  const queryParams: Record<string, string | number> = {
    limit: search.limit,
    offset: search.offset,
  };
  if (search.author) queryParams.author = search.author;
  if (search.spec_version) queryParams.spec_version = search.spec_version;
  if (search.block_start) queryParams.block_start = search.block_start;
  if (search.block_end) queryParams.block_end = search.block_end;
  if (search.min_extrinsics) queryParams.min_extrinsics = search.min_extrinsics;
  if (search.min_events) queryParams.min_events = search.min_events;
  return queryParams;
}

function BlocksPage() {
  const search = Route.useSearch();
  const blocksCsvUrl = buildUrl("/api/v1/blocks", blocksQueryParams(search));

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Blocks"
        description="Recent Bittensor blocks indexed directly from the chain — newest first, with author, extrinsic, and event counts."
        actions={
          <>
            <ActionBar>
              <DownloadCsvButton url={blocksCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-24 w-full mb-3" />}>
          <BlockThroughputCard />
        </Suspense>
      </QueryErrorBoundary>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-28 w-full mb-8" />}>
          <BlockProductionHeader />
        </Suspense>
      </QueryErrorBoundary>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <BlocksTable />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={["/api/v1/blocks", "/api/v1/blocks/summary", "/api/v1/chain/activity"]}
        artifacts={["/metagraph/blocks.json", "/metagraph/blocks/summary.json"]}
      />
    </AppShell>
  );
}

// #3390: block-throughput sparkline — daily block_count over the default window
// from /api/v1/chain/activity (the source explorer.tsx already uses), rendered as
// a compact card directly above the production-stats header so the throughput
// trend sits with the other block-production metrics (no separate hero KPI).
function BlockThroughputCard() {
  const chrono = [...useSuspenseQuery(chainActivityQuery()).data.data.days].reverse();
  const blockCounts = chrono.map((d) => d.block_count);
  if (blockCounts.length === 0) return null;
  const totalBlocks = blockCounts.reduce((acc, n) => acc + n, 0);
  return (
    <div className="mb-3 flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Blocks / day
        </div>
        <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink-strong">
          {formatNumber(totalBlocks)}
          <span className="ml-1.5 text-sm font-normal text-ink-muted">total</span>
        </div>
      </div>
      <Sparkline
        values={blockCounts}
        points={chrono.map((d) => ({ t: d.day, v: d.block_count }))}
        width={220}
        height={44}
        ariaLabel="Daily block throughput, oldest to newest"
        formatValue={formatNumber}
      />
    </div>
  );
}

// #3488: point-in-time block-production health above the raw blocks feed —
// inter-block cadence, per-block throughput, and block-author decentralization
// from /api/v1/blocks/summary, in its own Suspense/error boundary so a slow or
// failed summary never blocks the table below.
function BlockProductionHeader() {
  const summary = useSuspenseQuery(blocksSummaryQuery()).data.data;
  const blockTime = summary.block_time;
  const throughput = summary.throughput;
  const nakamoto = summary.author_concentration?.nakamoto_coefficient;
  const nakamotoStatTone = nakamotoTone(nakamoto);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
      <StatTile
        icon={Timer}
        eyebrow="Inter-block time"
        value={blockTime ? humaniseSeconds(blockTime.mean_ms / 1000) : "—"}
        hint={blockTime ? `p90 ${humaniseSeconds(blockTime.p90_ms / 1000)}` : undefined}
      />
      <StatTile
        icon={Activity}
        eyebrow="Throughput"
        // #3940: bare number like the sibling tiles -- unit + secondary metric live in the hint.
        value={throughput ? formatNumber(throughput.mean_extrinsics_per_block) : "—"}
        hint={
          throughput
            ? `ext/block · ${formatNumber(throughput.mean_events_per_block)} events/block`
            : undefined
        }
      />
      <StatTile
        icon={Users}
        eyebrow="Author decentralization"
        value={nakamoto != null ? formatNumber(nakamoto) : "—"}
        hint="Nakamoto coefficient"
        tone={nakamotoStatTone}
      />
    </div>
  );
}

function BlocksTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Only send filters the user actually set, so an empty bar is the plain feed.
  const queryParams = blocksQueryParams(search);

  // Blocks turn over fast (~12s/block) — poll the first page only, so paging
  // through older blocks (offset > 0) isn't yanked or reflowed mid-read.
  const refetchInterval = useRefetchInterval(15_000, search.offset === 0);
  const rows = (useSuspenseQuery({ ...blocksQuery(queryParams), refetchInterval }).data.data ??
    []) as Block[];

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasPrev = search.offset > 0;
  const hasNext = rows.length === search.limit;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const goPrev = () => setSearch({ offset: Math.max(0, search.offset - search.limit) });
  const goNext = () => setSearch({ offset: search.offset + search.limit });

  const filtersActive = Boolean(
    search.author ||
    search.spec_version ||
    search.block_start ||
    search.block_end ||
    search.min_extrinsics ||
    search.min_events,
  );

  const activeCount = activeFilterCount([
    search.author,
    search.spec_version,
    search.block_start,
    search.block_end,
    search.min_extrinsics,
    search.min_events,
  ]);
  // Six placeholder-only inputs stacked to ~a full 375px screen before any block
  // row was visible (#5323). Collapse them behind a toggle on mobile — open by
  // default when a filter is already applied (e.g. a shared URL), so the reason
  // the list is narrowed is never hidden.
  const [filtersOpen, setFiltersOpen] = useState(activeCount > 0);

  const filters = (
    <>
      <button
        type="button"
        onClick={() => setFiltersOpen((open) => !open)}
        aria-expanded={filtersOpen}
        aria-controls="blocks-filter-fields"
        className="md:hidden inline-flex min-h-11 items-center gap-1.5 rounded border border-border bg-card px-2.5 font-mono text-[11px] text-ink-muted hover:border-ink/30 hover:text-ink-strong transition-colors"
      >
        <SlidersHorizontal className="size-3" aria-hidden="true" />
        {filterToggleLabel(activeCount)}
      </button>
      {/* `md:contents` dissolves this wrapper at md and up, so the fields lay out
          as direct children of the filter bar exactly as they did before — the
          collapse is mobile-only. */}
      <div
        id="blocks-filter-fields"
        className={classNames(
          "w-full flex-wrap items-center gap-2 md:contents",
          filtersOpen ? "flex" : "hidden",
        )}
      >
        <span
          className="font-mono text-[11px] text-ink-muted whitespace-nowrap"
          title="Blocks are listed newest first"
        >
          <span aria-hidden="true">↓ </span>Newest first
        </span>
        <SearchInput
          value={search.author}
          onChange={(v) => setSearch({ author: v, offset: 0 })}
          placeholder="Author ss58…"
        />
        <SearchInput
          value={search.spec_version}
          onChange={(v) => setSearch({ spec_version: v, offset: 0 })}
          placeholder="Spec version…"
          inputMode="numeric"
          className="min-w-[120px] max-w-[140px] flex-none"
        />
        <SearchInput
          value={search.block_start}
          onChange={(v) => setSearch({ block_start: v, offset: 0 })}
          placeholder="Block from…"
          inputMode="numeric"
          className="min-w-[120px] max-w-[140px] flex-none"
        />
        <SearchInput
          value={search.block_end}
          onChange={(v) => setSearch({ block_end: v, offset: 0 })}
          placeholder="Block to…"
          inputMode="numeric"
          className="min-w-[120px] max-w-[140px] flex-none"
        />
        <SearchInput
          value={search.min_extrinsics}
          onChange={(v) => setSearch({ min_extrinsics: v, offset: 0 })}
          placeholder="Min extrinsics…"
          inputMode="numeric"
          className="min-w-[120px] max-w-[140px] flex-none"
        />
        <SearchInput
          value={search.min_events}
          onChange={(v) => setSearch({ min_events: v, offset: 0 })}
          placeholder="Min events…"
          inputMode="numeric"
          className="min-w-[120px] max-w-[140px] flex-none"
        />
        <PageSizeSelect
          value={search.limit}
          onChange={(n) => setSearch({ limit: n, offset: 0 })}
          options={[10, 25, 50, 100]}
        />
        <ResetFiltersButton
          active={filtersActive}
          onReset={() =>
            setSearch({
              author: "",
              spec_version: "",
              block_start: "",
              block_end: "",
              min_extrinsics: "",
              min_events: "",
              offset: 0,
            })
          }
        />
      </div>
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No blocks indexed yet"
      description="The chain poller fills this every few minutes — check back shortly, or open the API directly."
      action={{
        label: "Open /api/v1/blocks",
        href: `${API_BASE}/api/v1/blocks`,
        external: true,
      }}
    />
  );

  const footerNode = (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted">
      <span>
        {rows.length
          ? `${formatNumber(search.offset + 1)}–${formatNumber(search.offset + rows.length)}`
          : "0"}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goPrev}
          disabled={!hasPrev}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          <ChevronLeft className="size-3" /> Newer
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!hasNext}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed min-h-9"
        >
          Older <ChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      empty={emptyNode}
      cards={rows.map((b) => (
        <Link
          key={b.block_hash || b.block_number}
          to="/blocks/$ref"
          params={{ ref: String(b.block_number) }}
          className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-sm font-medium text-ink-strong">
              #{formatNumber(b.block_number)}
            </div>
            <span className="font-mono text-[11px] text-ink-muted">
              <TimeAgo at={b.observed_at} />
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-ink-muted truncate">
            {shortHash(b.block_hash)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-muted">
            <span>{shortHash(b.author) ?? "no author"}</span>
            <span>{formatNumber(b.extrinsic_count ?? 0)} ext</span>
            <span>{formatNumber(b.event_count ?? 0)} evt</span>
          </div>
        </Link>
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
            <tr>
              <th className="px-4 py-2.5">Block</th>
              <th className="px-4 py-2.5">Hash</th>
              <th className="px-4 py-2.5">Author</th>
              <th className="px-4 py-2.5 text-right">Extrinsics</th>
              <th className="px-4 py-2.5 text-right">Events</th>
              <th className="px-4 py-2.5 text-right">Observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((b) => (
              <tr
                key={b.block_hash || b.block_number}
                className="mg-row-accent hover:bg-surface/40"
              >
                <td className="px-4 py-2.5 font-mono text-[12px]">
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(b.block_number) }}
                    className="font-medium text-ink-strong hover:underline"
                  >
                    #{formatNumber(b.block_number)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <Link
                      to="/blocks/$ref"
                      params={{ ref: b.block_hash || String(b.block_number) }}
                      className="hover:text-ink-strong truncate"
                      title={b.block_hash}
                    >
                      {shortHash(b.block_hash)}
                    </Link>
                    {b.block_hash ? <CopyButton value={b.block_hash} label="block hash" compact /> : null}
                  </span>
                </td>
                <td
                  className="px-4 py-2.5 font-mono text-[11px] text-ink-muted"
                  title={b.author ?? undefined}
                >
                  <AccountCell
                    ss58={b.author}
                    fallback={
                      b.author ? <CopyableCode value={b.author} className="max-w-full" /> : "—"
                    }
                  />
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {formatNumber(b.extrinsic_count ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {formatNumber(b.event_count ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={b.observed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      footer={footerNode}
    />
  );
}
