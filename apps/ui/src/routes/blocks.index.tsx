import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Timer, Activity, Users } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  AsyncPanel,
  TableSkeleton,
  PagerFooter,
  MetricGrid,
  PanelSkeleton,
  QueryBar,
  FilterSheet,
  FilterChipRow,
  type FilterChipItem,
  PageMasthead,
} from "@/components/metagraphed/primitives";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState } from "@/components/metagraphed/states";
import { AccountAddress } from "@/components/metagraphed/account-address";
import {
  TimeAgo,
  ListShell,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  StatTile,
  CopyButton,
  CopyableCode,
  BackToTop,
} from "@jsonbored/ui-kit";
import { PageSizeSelect } from "@/components/metagraphed/table-controls";
import { LiveBlockRail } from "@/components/metagraphed/blocks/live-block-rail";
import { CadenceHeatmap } from "@/components/metagraphed/blocks/cadence-heatmap";
import { AuthorSharePanel } from "@/components/metagraphed/blocks/author-share-panel";
import { RuntimeTimeline } from "@/components/metagraphed/blocks/runtime-timeline";
import { blocksQuery, blocksSummaryQuery, metagraphedQueryKey } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
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
      <PageMasthead
        eyebrow="Explorer"
        live
        title="Blocks"
        description="Recent Bittensor blocks indexed directly from the chain — newest first, with author, extrinsic, and event counts."
        actions={
          <ActionBar>
            <DownloadCsvButton url={blocksCsvUrl} bare />
            <ShareButton bare />
          </ActionBar>
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
        context="Runtime upgrades"
        retryQueryKeys={[metagraphedQueryKey("runtime-version-history")]}
        fallback={<PanelSkeleton height="sm" className="mb-6" />}
      >
        <RuntimeTimeline />
      </AsyncPanel>
      <AsyncPanel
        context="Blocks table"
        retryQueryKeys={[metagraphedQueryKey("blocks")]}
        fallback={<TableSkeleton rows={10} columns={6} />}
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
  const nakamotoStatTone = nakamotoTone(nakamoto);
  return (
    <MetricGrid cols={{ base: 1, sm: 2, md: 3 }} gap="md" className="mb-8">
      <StatTile
        icon={Timer}
        eyebrow="Inter-block time"
        value={blockTime ? humaniseSeconds(blockTime.mean_ms / 1000) : "—"}
        hint={blockTime ? `p90 ${humaniseSeconds(blockTime.p90_ms / 1000)}` : undefined}
      />
      <StatTile
        icon={Activity}
        eyebrow="Throughput"
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
    </MetricGrid>
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

  // Per-page maxima drive the inline activity bars in the Extrinsics/Events
  // cells so scanning "which blocks were busy" is a visual, not numeric, task.
  const maxExt = Math.max(1, ...rows.map((b) => b.extrinsic_count ?? 0));
  const maxEvt = Math.max(1, ...rows.map((b) => b.event_count ?? 0));

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

  const secondaryFilterCount =
    (search.spec_version ? 1 : 0) +
    (search.block_start ? 1 : 0) +
    (search.block_end ? 1 : 0) +
    (search.min_extrinsics ? 1 : 0) +
    (search.min_events ? 1 : 0);
  const activeCount = (search.author ? 1 : 0) + secondaryFilterCount;

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

  const chipItems: FilterChipItem[] = [];
  if (search.author)
    chipItems.push({
      id: "author",
      label: "Author",
      value: shortHash(search.author) ?? search.author,
    });
  if (search.spec_version)
    chipItems.push({ id: "spec_version", label: "Spec", value: search.spec_version });
  if (search.block_start || search.block_end)
    chipItems.push({
      id: "range",
      label: "Range",
      value: `${search.block_start || "…"} → ${search.block_end || "…"}`,
    });
  if (search.min_extrinsics)
    chipItems.push({ id: "min_extrinsics", label: "Min ext", value: `≥ ${search.min_extrinsics}` });
  if (search.min_events)
    chipItems.push({ id: "min_events", label: "Min evt", value: `≥ ${search.min_events}` });

  const removeChip = (id: string) => {
    switch (id) {
      case "author":
        setSearch({ author: "", offset: 0 });
        break;
      case "spec_version":
        setSearch({ spec_version: "", offset: 0 });
        break;
      case "range":
        setSearch({ block_start: "", block_end: "", offset: 0 });
        break;
      case "min_extrinsics":
        setSearch({ min_extrinsics: "", offset: 0 });
        break;
      case "min_events":
        setSearch({ min_events: "", offset: 0 });
        break;
    }
  };

  const numericInputCls =
    "w-full rounded border border-border bg-paper px-2 py-1.5 font-mono text-sm text-ink-strong placeholder:text-ink-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-ring transition-colors";

  const filters = (
    <div className="flex w-full flex-col gap-0 min-w-0">
      <div className="flex w-full items-center gap-2 min-w-0">
        <QueryBar className="flex-1 min-w-0">
          <QueryBar.Search
            value={search.author}
            onChange={(v) => setSearch({ author: v, offset: 0 })}
            placeholder="Search by author ss58…"
            shortcut
            debounceMs={200}
          />
          <QueryBar.Divider />
          <QueryBar.Utility className="ml-auto">
            <span
              className="hidden sm:inline mg-type-micro text-ink-muted"
              title="Blocks are always listed newest first"
            >
              ↓ Newest
            </span>
            <PageSizeSelect
              value={search.limit}
              onChange={(n) => setSearch({ limit: n, offset: 0 })}
              options={[10, 25, 50, 100]}
            />
          </QueryBar.Utility>
        </QueryBar>
        <FilterSheet label="Filters" activeCount={secondaryFilterCount}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="mg-type-micro text-ink-muted">Spec version</span>
              <input
                type="text"
                inputMode="numeric"
                value={search.spec_version}
                onChange={(e) =>
                  setSearch({ spec_version: e.target.value.replace(/[^0-9]/g, ""), offset: 0 })
                }
                placeholder="e.g. 268"
                className={numericInputCls}
              />
            </label>
            <div className="hidden sm:block" aria-hidden />
            <label className="flex flex-col gap-1.5">
              <span className="mg-type-micro text-ink-muted">Block from</span>
              <input
                type="text"
                inputMode="numeric"
                value={search.block_start}
                onChange={(e) =>
                  setSearch({ block_start: e.target.value.replace(/[^0-9]/g, ""), offset: 0 })
                }
                placeholder="e.g. 6000000"
                className={numericInputCls}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="mg-type-micro text-ink-muted">Block to</span>
              <input
                type="text"
                inputMode="numeric"
                value={search.block_end}
                onChange={(e) =>
                  setSearch({ block_end: e.target.value.replace(/[^0-9]/g, ""), offset: 0 })
                }
                placeholder="e.g. 6100000"
                className={numericInputCls}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="mg-type-micro text-ink-muted">Min extrinsics</span>
              <input
                type="text"
                inputMode="numeric"
                value={search.min_extrinsics}
                onChange={(e) =>
                  setSearch({ min_extrinsics: e.target.value.replace(/[^0-9]/g, ""), offset: 0 })
                }
                placeholder="e.g. 5"
                className={numericInputCls}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="mg-type-micro text-ink-muted">Min events</span>
              <input
                type="text"
                inputMode="numeric"
                value={search.min_events}
                onChange={(e) =>
                  setSearch({ min_events: e.target.value.replace(/[^0-9]/g, ""), offset: 0 })
                }
                placeholder="e.g. 20"
                className={numericInputCls}
              />
            </label>
          </div>
          {secondaryFilterCount > 0 ? (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() =>
                  setSearch({
                    spec_version: "",
                    block_start: "",
                    block_end: "",
                    min_extrinsics: "",
                    min_events: "",
                    offset: 0,
                  })
                }
                className="rounded border border-border bg-card px-2.5 py-1 mg-type-label uppercase text-ink-muted hover:border-accent/40 hover:text-ink-strong transition-colors"
              >
                Clear numeric filters
              </button>
            </div>
          ) : null}
        </FilterSheet>
      </div>
      <QueryBar.MetaRow
        count={rows.length}
        noun="blocks"
        activeCount={activeCount}
        onReset={filtersActive ? resetAll : undefined}
      />
      <FilterChipRow
        items={chipItems}
        onRemove={removeChip}
        onClearAll={activeCount > 1 ? resetAll : undefined}
      />
    </div>
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
    <div className="px-4 py-2">
      <PagerFooter
        summary={
          rows.length
            ? `${formatNumber(search.offset + 1)}–${formatNumber(search.offset + rows.length)}`
            : "0"
        }
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={goPrev}
        onNext={goNext}
      />
    </div>
  );

  return (
    <>
      {rows.length > 0 ? (
        <>
          <CadenceHeatmap rows={rows} />
          <AuthorSharePanel rows={rows} />
        </>
      ) : null}
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
              {rows.map((b, i) => {
                // Gap = seconds since the previous (older) block was produced.
                // Rows are newest-first, so the older neighbor is at i+1.
                const nextOlder = rows[i + 1];
                const gapMs =
                  b.observed_at && nextOlder?.observed_at
                    ? Date.parse(b.observed_at) - Date.parse(nextOlder.observed_at)
                    : null;
                const gapSec = gapMs != null && Number.isFinite(gapMs) ? gapMs / 1000 : null;
                const gapTone =
                  gapSec == null
                    ? "text-ink-subtle"
                    : gapSec > 48
                      ? "text-health-down"
                      : gapSec > 24
                        ? "text-health-warn-text"
                        : "text-ink-subtle";
                // Free decentralization tell: count how often this author appears
                // on the current page. A repeat on a short window is worth flagging.
                const authorRepeat = b.author
                  ? rows.reduce((n, r) => (r.author === b.author ? n + 1 : n), 0)
                  : 0;
                return (
                  <tr
                    key={b.block_hash || b.block_number}
                    className="group mg-row-accent odd:bg-surface/30 hover:bg-surface/60"
                  >
                    <td className="px-4 py-2.5 font-mono text-[12px] align-top">
                      <Link
                        to="/blocks/$ref"
                        params={{ ref: String(b.block_number) }}
                        className="font-medium text-ink-strong hover:underline"
                      >
                        #{formatNumber(b.block_number)}
                      </Link>
                      {gapSec != null ? (
                        <div
                          className={classNames("mt-0.5 text-[10px]", gapTone)}
                          title="Seconds since previous block"
                        >
                          +{humaniseSeconds(gapSec)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted align-top">
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <Link
                          to="/blocks/$ref"
                          params={{ ref: b.block_hash || String(b.block_number) }}
                          className="hover:text-ink-strong truncate"
                          title={b.block_hash}
                        >
                          {shortHash(b.block_hash)}
                        </Link>
                        {b.block_hash ? (
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyButton value={b.block_hash} label="block hash" compact />
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td
                      className="px-4 py-2.5 font-mono text-[11px] text-ink-muted align-top"
                      title={b.author ?? undefined}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <AccountAddress
                          ss58={b.author}
                          compact
                          fallback={
                            b.author ? (
                              <CopyableCode value={b.author} className="max-w-full" />
                            ) : (
                              "—"
                            )
                          }
                        />
                        {authorRepeat > 1 ? (
                          <span
                            className="mg-chip h-4 px-1.5 text-[9px] text-accent-text border-accent/40"
                            title={`Produced ${authorRepeat} blocks on this page`}
                          >
                            ×{authorRepeat}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink align-top">
                      <ActivityCell value={b.extrinsic_count ?? 0} max={maxExt} tone="accent" />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink align-top">
                      <ActivityCell value={b.event_count ?? 0} max={maxEvt} tone="ink" />
                    </td>
                    <td
                      className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted align-top"
                      title={b.observed_at ?? undefined}
                    >
                      <TimeAgo at={b.observed_at} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }
        footer={footerNode}
      />
    </>
  );
}

/**
 * Right-aligned number with a thin horizontal bar underneath, normalized
 * against the page-max so busy blocks are visually obvious at a glance.
 * `tone="accent"` (extrinsics) uses mint; `tone="ink"` (events) uses ink.
 */
function ActivityCell({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone: "accent" | "ink";
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const barCls = tone === "accent" ? "bg-accent/70" : "bg-ink-strong/40";
  return (
    <span className="inline-flex flex-col items-end gap-1 min-w-[3.5rem]">
      <span>{formatNumber(value)}</span>
      <span aria-hidden className="block h-[3px] w-full rounded-full bg-border/50 overflow-hidden">
        <span
          className={classNames("block h-full rounded-full transition-[width]", barCls)}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
