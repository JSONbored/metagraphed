import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AsyncPanel, PanelSkeleton } from "@/components/metagraphed/primitives";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import {
  EntityHero,
  FactSentence,
  TimeAgo,
  CopyableCode,
  BackToTop,
  FactStrip,
  FactCell,
  DataTable,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ResetFiltersButton } from "@/components/metagraphed/table-controls";
import { LiveBlockRail } from "@/components/metagraphed/blocks/live-block-rail";
import { CadenceTrend } from "@/components/metagraphed/blocks/cadence-trend";
import { AuthorSharePanel } from "@/components/metagraphed/blocks/author-share-panel";
import { blocksQuery, blocksSummaryQuery, metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Block } from "@/lib/metagraphed/types";
import type { BlocksSearch } from "./chain.blocks";

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

/**
 * The chain-hub layout used to supply this page's shell: `AppShell`, the
 * `EntityHero` and the nine-tab strip all rendered once in chain.tsx, and
 * every stream page returned a bare fragment into its `<Outlet />`. #11619
 * emptied that layout -- four of the tabs are sections of /chain now, and a
 * tab strip whose tabs are anchors on the page below it is two navigations
 * for one destination -- so each remaining stream page owns its own shell.
 *
 * Self-contained rather than a smaller shared layout on purpose: three pages
 * is not enough shape to name a layer, and a layout that exists only to hold
 * a heading is the thing that just came out. The crumb back to /chain is the
 * whole of what the tab strip was actually load-bearing for.
 */
export function BlocksPage() {
  return (
    <AppShell>
      <EntityHero
        crumbs={[{ label: "Chain", href: "/chain" }]}
        name="Blocks"
        sentence={
          <FactSentence>
            Recent blocks indexed directly from the chain — newest first, with author, extrinsic and
            event counts.
          </FactSentence>
        }
      />
      <AsyncPanel
        context="Live block rail"
        retryQueryKeys={[metagraphedQueryKey("blocks"), metagraphedQueryKey("chain-activity")]}
        fallback={<PanelSkeleton height="sm" className="mb-3" />}
      >
        <LiveBlockRail />
      </AsyncPanel>
      <AsyncPanel
        context="Block production"
        retryQueryKeys={[metagraphedQueryKey("blocks-summary")]}
        fallback={
          <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-3">
            <PanelSkeleton height="sm" />
            <PanelSkeleton height="sm" />
            <PanelSkeleton height="sm" />
          </div>
        }
      >
        <BlockProductionHeader />
      </AsyncPanel>
      <AsyncPanel
        context="Blocks table"
        retryQueryKeys={[metagraphedQueryKey("blocks")]}
        fallback={<Skeleton className="h-80 w-full" />}
      >
        <BlocksTable />
      </AsyncPanel>
      <ApiSourceFooter
        paths={["/api/v1/blocks", "/api/v1/blocks/summary", "/api/v1/chain/activity"]}
        artifacts={["/metagraph/blocks.json", "/metagraph/blocks/summary.json"]}
      />
      <BackToTop />
    </AppShell>
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
  return (
    <FactStrip variant="grid">
      <FactCell
        label="Inter-block time"
        value={blockTime ? humaniseSeconds(blockTime.mean_ms / 1000) : "—"}
        hint={blockTime ? `p90 ${humaniseSeconds(blockTime.p90_ms / 1000)}` : undefined}
      />
      <FactCell
        label="Throughput"
        value={throughput ? formatNumber(throughput.mean_extrinsics_per_block) : "—"}
        hint={
          throughput
            ? `ext/block · ${formatNumber(throughput.mean_events_per_block)} events/block`
            : undefined
        }
      />
      <FactCell
        label="Author decentralization"
        value={nakamoto != null ? formatNumber(nakamoto) : "—"}
        hint="Nakamoto coefficient"
      />
    </FactStrip>
  );
}

/**
 * One block row in card form — block #, age, hash, author, ext/evt counts.
 * Used by any bounded preview that reuses this row shape (metagraphed#8359);
 * the full table renders its own narrow-screen cards from the table markup.
 */
export function BlockCard({ block }: { block: Block }) {
  return (
    <Link
      to="/blocks/$ref"
      params={{ ref: String(block.block_number) }}
      className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-13 font-medium text-ink-strong">
          #{formatNumber(block.block_number)}
        </div>
        <span className="text-11 text-ink-muted">
          <TimeAgo at={block.observed_at} />
        </span>
      </div>
      <div className="mt-1 text-11 text-ink-muted truncate">{shortHash(block.block_hash)}</div>
      <div className="mt-2 flex items-center justify-between text-11 text-ink-muted">
        <span>{shortHash(block.author) ?? "no author"}</span>
        <span>{formatNumber(block.extrinsic_count ?? 0)} ext</span>
        <span>{formatNumber(block.event_count ?? 0)} evt</span>
      </div>
    </Link>
  );
}

/**
 * Local mirror of a URL-backed text filter, debounced by 200ms: without that,
 * every keystroke rewrites the URL, changes the query key and re-suspends the
 * table mid-word.
 */
function useDebouncedFilter(
  value: string,
  commit: (next: string) => void,
  delayMs = 200,
): [string, (next: string) => void] {
  const [text, setText] = useState(value);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  // A reset button or a back navigation changes the URL from outside; the
  // input follows it rather than fighting it.
  useEffect(() => {
    setText(value);
  }, [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = window.setTimeout(() => commitRef.current(text), delayMs);
    return () => window.clearTimeout(timer);
  }, [text, value, delayMs]);
  return [text, setText];
}

function BlocksTable() {
  const search = useSearch({ from: "/chain/blocks" }) as BlocksSearch;
  const navigate = useNavigate({ from: "/blocks/" });

  // Only send filters the user actually set, so an empty bar is the plain feed.
  const queryParams = blocksQueryParams(search);

  // Blocks turn over fast (~12s/block) — poll the first page only, so paging
  // through older blocks (offset > 0) isn't yanked or reflowed mid-read.
  const refetchInterval = useRefetchInterval(15_000, search.offset === 0);
  const pageData = useSuspenseQuery({ ...blocksQuery(queryParams), refetchInterval }).data.data;
  // Stable identity: the column set below derives its per-page maxima and
  // inter-block gaps from these rows, so a fresh `[]` each render would make
  // the table re-read its stored column selection on every render.
  const rows = useMemo(() => (pageData ?? []) as Block[], [pageData]);

  // Offset pagination: the API returns newest-first pages with no total. A full
  // page (rows === limit) implies more may exist; a short page is the tail.
  const hasNext = rows.length === search.limit;
  const page = Math.floor(search.offset / search.limit) + 1;
  // No count comes back with the feed, so the pager gets the smallest total
  // consistent with what we know: everything read so far, plus one more page
  // while a full page says there may be one.
  const total = search.offset + rows.length + (hasNext ? search.limit : 0);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const [authorText, setAuthorText] = useDebouncedFilter(search.author, (next) =>
    setSearch({ author: next, offset: 0 }),
  );

  const filtersActive = Boolean(
    search.author ||
    search.spec_version ||
    search.block_start ||
    search.block_end ||
    search.min_extrinsics ||
    search.min_events,
  );

  const resetAll = () =>
    setSearch({
      author: "",
      spec_version: "",
      block_start: "",
      block_end: "",
      min_extrinsics: "",
      min_events: "",
      offset: 0,
    });

  // The five range/threshold filters, rendered inline in the table's own
  // caption row rather than behind a sheet.
  const numericFilters = [
    {
      key: "spec_version",
      label: "Spec version",
      value: search.spec_version,
      placeholder: "e.g. 268",
    },
    {
      key: "block_start",
      label: "Block from",
      value: search.block_start,
      placeholder: "e.g. 6000000",
    },
    { key: "block_end", label: "Block to", value: search.block_end, placeholder: "e.g. 6100000" },
    {
      key: "min_extrinsics",
      label: "Min extrinsics",
      value: search.min_extrinsics,
      placeholder: "e.g. 5",
    },
    { key: "min_events", label: "Min events", value: search.min_events, placeholder: "e.g. 20" },
  ];

  const numericInputCls =
    "w-24 min-w-0 rounded bg-transparent font-mono text-13 text-ink-strong placeholder:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  const columns = useMemo<Array<DataTableColumn<Block>>>(() => {
    // Per-page maxima drive the tinted Extrinsics/Events cells so scanning
    // "which blocks were busy" is a visual, not a numeric, task.
    const maxExt = Math.max(1, ...rows.map((b) => b.extrinsic_count ?? 0));
    const maxEvt = Math.max(1, ...rows.map((b) => b.event_count ?? 0));
    // Gap = seconds since the previous (older) block was produced. Rows are
    // newest-first, so the older neighbour is the next one along.
    const gaps = new Map<number, number>();
    rows.forEach((b, i) => {
      const older = rows[i + 1];
      if (!b.observed_at || !older?.observed_at) return;
      const gapMs = Date.parse(b.observed_at) - Date.parse(older.observed_at);
      if (Number.isFinite(gapMs)) gaps.set(b.block_number, gapMs / 1000);
    });
    // Free decentralization tell: how often an author appears on this page.
    const authorRuns = new Map<string, number>();
    for (const b of rows) {
      if (!b.author) continue;
      authorRuns.set(b.author, (authorRuns.get(b.author) ?? 0) + 1);
    }
    return [
      {
        key: "block",
        label: "Block",
        width: 150,
        value: (b) => b.block_number,
        render: (b) => {
          const gapSec = gaps.get(b.block_number);
          const gapTone =
            gapSec == null
              ? "text-ink-subtle"
              : gapSec > 48
                ? "text-health-down"
                : gapSec > 24
                  ? "text-health-warn-text"
                  : "text-ink-subtle";
          return (
            <>
              <span className="font-mono text-ink-strong">#{formatNumber(b.block_number)}</span>
              {gapSec == null ? null : (
                <span className={classNames("ml-2 text-10", gapTone)}>
                  +{humaniseSeconds(gapSec)}
                </span>
              )}
            </>
          );
        },
      },
      {
        key: "hash",
        label: "Hash",
        kind: "identifier",
        width: 180,
        value: (b) => b.block_hash ?? null,
      },
      {
        key: "author",
        label: "Author",
        value: (b) => b.author ?? null,
        render: (b) => {
          const repeat = b.author ? (authorRuns.get(b.author) ?? 0) : 0;
          return (
            <span className="flex items-center gap-1.5 min-w-0">
              <AddressDisplay
                ss58={b.author}
                compact
                fallback={b.author ? <CopyableCode value={b.author} className="max-w-full" /> : "—"}
              />
              {repeat > 1 ? (
                <span className="mg-chip h-4 px-1.5 text-10 text-accent-text border-accent/40">
                  ×{repeat}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: "extrinsics",
        label: "Extrinsics",
        kind: "tint",
        width: 120,
        value: (b) => b.extrinsic_count ?? 0,
        tint: (b) => (b.extrinsic_count ?? 0) / maxExt,
        format: (value) => formatNumber(typeof value === "number" ? value : null),
      },
      {
        key: "events",
        label: "Events",
        kind: "tint",
        width: 110,
        value: (b) => b.event_count ?? 0,
        tint: (b) => (b.event_count ?? 0) / maxEvt,
        format: (value) => formatNumber(typeof value === "number" ? value : null),
      },
      {
        key: "observed",
        label: "Observed",
        kind: "time",
        align: "right",
        width: 120,
        value: (b) => b.observed_at ?? null,
      },
    ];
  }, [rows]);

  return (
    <>
      {rows.length > 0 ? (
        <>
          <CadenceTrend rows={rows} />
          <AuthorSharePanel rows={rows} />
        </>
      ) : null}
      <DataTable
        caption="Blocks"
        rows={rows}
        columns={columns}
        rowKey={(b) => b.block_hash || String(b.block_number)}
        rowHref={(b) => `/blocks/${b.block_number}`}
        link={RouterLink}
        storageKey="blocks"
        source="block"
        total={total}
        page={page}
        onPage={(next) => setSearch({ offset: Math.max(0, (next - 1) * search.limit) })}
        pageSize={search.limit}
        search={{
          value: authorText,
          onChange: setAuthorText,
          placeholder: "Author ss58…",
        }}
        filters={
          <>
            <ResetFiltersButton active={filtersActive} onReset={resetAll} />
            <div className="flex flex-wrap items-center gap-2">
              {numericFilters.map((filter) => (
                <label
                  key={filter.key}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-13"
                >
                  <span className="shrink-0 text-ink-muted">{filter.label}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={filter.value}
                    onChange={(e) =>
                      setSearch({
                        [filter.key]: e.target.value.replace(/[^0-9]/g, ""),
                        offset: 0,
                      })
                    }
                    placeholder={filter.placeholder}
                    className={numericInputCls}
                  />
                </label>
              ))}
            </div>
          </>
        }
        empty={
          <EmptyState
            title="No blocks indexed yet"
            description="The chain poller fills this every few minutes — check back shortly, or open the API directly."
            action={{
              label: "Open /api/v1/blocks",
              href: `${API_BASE}/api/v1/blocks`,
              external: true,
            }}
          />
        }
      />
    </>
  );
}
