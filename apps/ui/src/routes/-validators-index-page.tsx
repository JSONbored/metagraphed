import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ValidatorsSearch } from "./validators.index";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { ChevronDown, Star } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  ShareButton,
  DownloadCsvButton,
  DensityToggle,
  MiniStack,
  type Density,
} from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  DataPageCanvas,
  DataPageDisclosure,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  FilterSheet,
  GhostButton,
  Panel,
  QueryBar,
  TableSkeleton,
} from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ValidatorEconomicsRanking } from "@/components/metagraphed/validator-economics-ranking";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { groupByOperator } from "@/lib/metagraphed/group-validators";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { VALIDATOR_COLUMNS } from "@/components/metagraphed/validator-columns";
import { ColumnCustomizer, useColumnVisibility } from "@jsonbored/ui-kit";
import {
  ValidatorsCompareDrawer,
  ValidatorCompareToggle,
} from "@/components/metagraphed/validators-compare-drawer";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import { TableColGroup } from "@jsonbored/ui-kit";
import type { GlobalValidator } from "@/lib/metagraphed/types";
import { useMeasuredRowHeight } from "@/hooks/use-measured-row-height";
import { readKey } from "@/lib/metagraphed/read-key";

// #8251: one request for the FULL directory (~1,014 validators live; the API
// cap was raised 100 -> 2000 in the same change) — the table body is
// virtualized client-side, so there is no pagination tier and every row is
// searchable/sortable locally.
// Exported so the homepage's Watched module can request the identical query
// (same sort + limit = same cache key) and read from cache rather than firing
// a second 2000-row fetch (#8256).
export const ALL_VALIDATORS_LIMIT = 2000;
const CONCENTRATION_TOP_N = 10;

export function ValidatorsPage() {
  const search = useSearch({ from: "/validators/" }) as ValidatorsSearch;
  const navigate = useNavigate({ from: "/validators/" });
  const density = search.density ?? "comfortable";
  const onDensityChange = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }),
      replace: true,
    });
  return (
    <AppShell>
      <DataPageStage>
        <DataPageHero
          id="validators-title"
          eyebrow="Network operators"
          live
          title="Validators."
          description="Search the live validator set by operator or key."
        />
        <DataPageCanvas>
          <DataPageModule title="Directory." caption="Stake, ownership, and on-chain economics.">
            <AsyncPanel
              context="validators"
              fallback={<TableSkeleton rows={10} columns={8} />}
              retryQueryKeys={[
                validatorsQuery({
                  sort: "total_stake",
                  limit: ALL_VALIDATORS_LIMIT,
                  subnets: false,
                }).queryKey,
              ]}
            >
              <ValidatorsDirectory density={density} onDensityChange={onDensityChange} />
            </AsyncPanel>
            <DataPageDisclosure label="How to read this directory">
              <ValidatorGuide />
            </DataPageDisclosure>
          </DataPageModule>
          <DataPageModule
            title="Entry economics."
            caption="Current stake thresholds across the network."
          >
            <ValidatorEconomicsRanking />
          </DataPageModule>
        </DataPageCanvas>
        <ApiSourceFooter paths={["/api/v1/validators", "/api/v1/validators/economics"]} />
        <HubSections path="/validators" />
      </DataPageStage>
      <ValidatorsCompareDrawer />
    </AppShell>
  );
}

function ValidatorsDirectory({
  density,
  onDensityChange,
}: {
  density: Density;
  onDensityChange: (d: Density) => void;
}) {
  const search = useSearch({ from: "/validators/" }) as ValidatorsSearch;
  const navigate = useNavigate({ from: "/validators/" });
  const sort = search.sort || "total_stake_tao";
  const order = search.order ?? "desc";
  const grouped = search.grouped ?? true;
  // One canonical fetch regardless of the URL's sort/filter state — the query
  // key never changes with UI state, so sorting/searching re-uses the cached
  // full set instead of refetching.
  const res = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT, subnets: false }),
  ).data;
  const all = res.data.validators;
  const generatedAt = res.meta?.generated_at ?? null;
  const compact = density === "compact";
  const watchlist = useWatchlist("validator");
  // Every column is opt-in/out, with a core set on by default -- the API
  // returns far more per validator than the table used to show (emission,
  // trust, realized returns, the root/alpha stake split), and hiding them
  // permanently was the wrong default.
  const columns = useColumnVisibility("validators", VALIDATOR_COLUMNS);
  const visibleColumns = VALIDATOR_COLUMNS.filter((c) => columns.isVisible(c.id));
  // Keep the route-level actions local to the directory instrument. The hero
  // names the page; the command rail is where a reader searches, adjusts the
  // table, exports, or shares the exact view they are looking at.
  const validatorsCsvUrl = buildUrl("/api/v1/validators", {
    sort: "total_stake",
    limit: ALL_VALIDATORS_LIMIT,
  });
  const activeFilterCount = search.watched ? 1 : 0;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; no scroll-to-top per keystroke (#3691).
      resetScroll: false,
      replace: true,
    });

  const onSort = (field: string) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        sort: field,
        order: prev.sort === field && prev.order === "desc" ? "asc" : "desc",
      }),
      replace: true,
    });

  // Client-side search + sort over the full set. Watched rows pin to the top
  // within the current sort (stable partition, not a separate list).
  const sortedRows = useMemo(() => {
    const filtered = all.filter(
      (v) =>
        matchesQuery([v.hotkey, v.coldkey, v.coldkey_identity?.name], search.q) &&
        (!search.watched || watchlist.isWatched(v.hotkey)),
    );
    const sorted = sortBy(filtered, sort, order, (row, key) => {
      return readKey(row, key);
    });
    if (watchlist.count === 0) return sorted;
    const watched: GlobalValidator[] = [];
    const rest: GlobalValidator[] = [];
    for (const v of sorted) (watchlist.isWatched(v.hotkey) ? watched : rest).push(v);
    return [...watched, ...rest];
  }, [all, search.q, search.watched, sort, order, watchlist]);

  // Cluster an operator's keys adjacent under its best-ranked row (default on):
  // one "Ventura Labs ×3" entry instead of the same name repeated at three
  // ranks. Per-key rows survive untouched — nothing is summed across keys.
  const { rows, groupInfo } = useMemo(() => {
    if (!grouped) return { rows: sortedRows, groupInfo: null };
    const { list, info } = groupByOperator(sortedRows);
    return { rows: list, groupInfo: info };
  }, [sortedRows, grouped]);

  // #8251: virtualized table body — the same padding-row technique the
  // /subnets table established (#8314): only the visible slice mounts as real
  // in-flow `<tr>`s, with two spacer rows standing in for off-screen space,
  // so the sticky header and column alignment keep working.
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useMeasuredRowHeight(tableScrollRef, compact ? 33 : 41);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableScrollRef.current,
    // Measured, not guessed -- see use-measured-row-height.ts. The literal
    // here is only the pre-measurement seed; it read 41 against real 39px
    // rows, which shrank the scroll height by ~492px as the reader scrolled.
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  const directoryRefinements = (
    <>
      <div className="flex flex-col gap-2">
        <span className="mg-type-label uppercase text-ink-muted">Directory</span>
        <GhostButton
          onClick={() => setSearch({ grouped: !grouped })}
          aria-pressed={grouped}
          title="Cluster an operator's validator keys under one entry"
          tone={grouped ? "accent" : "default"}
          appearance="terminal"
          className="w-full justify-between"
        >
          Group by operator
        </GhostButton>
        {watchlist.count > 0 ? (
          <GhostButton
            onClick={() => setSearch({ watched: !search.watched })}
            aria-pressed={search.watched}
            tone={search.watched ? "accent" : "default"}
            appearance="terminal"
            className="w-full justify-between"
            icon={
              <Star
                className={classNames("size-3.5", search.watched && "fill-accent text-accent")}
                aria-hidden
              />
            }
          >
            Watched · {watchlist.count}
          </GhostButton>
        ) : null}
      </div>

      <div className="hidden flex-col gap-2 border-t border-border pt-4 lg:flex">
        <span className="mg-type-label uppercase text-ink-muted">Table</span>
        <DensityToggle
          value={density}
          onChange={onDensityChange}
          className="w-full [&>div]:w-full [&>div>button]:flex-1 [&>div>button>span]:inline"
        />
        <ColumnCustomizer
          columns={VALIDATOR_COLUMNS}
          isVisible={columns.isVisible}
          onToggle={columns.toggle}
          onReset={columns.reset}
          className="[&>button]:w-full [&>button]:justify-between"
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className="mg-type-label uppercase text-ink-muted">Export &amp; share</span>
        <div className="grid grid-cols-2 gap-2">
          <DownloadCsvButton
            url={validatorsCsvUrl}
            className="w-full justify-center rounded [&>span]:!inline"
          />
          <ShareButton className="w-full justify-center rounded [&>span]:!inline" />
        </div>
      </div>
    </>
  );

  return (
    <div className="space-y-3">
      {isStaleFreshness(generatedAt) ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[
            validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT, subnets: false })
              .queryKey,
          ]}
        />
      ) : null}

      <div className="mg-directory-toolbar flex w-full flex-col gap-0 min-w-0">
        <div className="flex w-full items-center gap-2 min-w-0">
          <QueryBar className="min-h-11 lg:min-h-0" ariaLabel="Search validators">
            <QueryBar.Search
              value={search.q}
              onChange={(v) => setSearch({ q: v })}
              placeholder="Search operator, hotkey, or coldkey"
              debounceMs={150}
              className="min-h-11 lg:min-h-0"
            />
          </QueryBar>
          <FilterSheet
            className="shrink-0 [&>button]:min-h-11 lg:[&>button]:min-h-9"
            label="Controls"
            activeCount={activeFilterCount}
          >
            {directoryRefinements}
          </FilterSheet>
        </div>
        <QueryBar.MetaRow
          count={rows.length}
          total={all.length}
          noun="validators"
          activeCount={activeFilterCount}
          onReset={search.watched ? () => setSearch({ watched: false }) : undefined}
        />
      </div>

      {rows.length > 0 ? (
        <div className="mg-directory-table hidden lg:block border border-border">
          {/* ONE scroll container carrying BOTH sets of styling.
              This was split into single-axis wrappers (#8314) because a
              combined overflow-auto div left the extra columns
              (Nominators/Dominance/Total stake/30d Δ) scrollable but
              undiscoverable at tablet widths -- no fade, no affordance. That
              diagnosis was right; the remedy was not. Splitting cannot work,
              because `overflow-y: auto` coerces `overflow-x` to `auto` too
              (CSS Overflow 3 §3), so the inner div took the horizontal axis
              anyway and the outer .mg-table-scroll -- the one carrying the
              fade and the thin scrollbar -- was left unable to scroll at all.
              The affordance was on the wrong element the whole time.
              Measured on a sibling route: inner scrolled x at 958 > 708 while
              the outer could not move, with a 15px default scrollbar inside
              the bounded region.
              Putting .mg-table-scroll ON the scroller is what actually
              delivers the affordance the original comment wanted. */}
          <div ref={tableScrollRef} className="mg-table-scroll mg-list-viewport">
            <table
              className={classNames(
                "w-full min-w-[1100px] table-fixed text-left text-sm",
                compact && "[&_td]:!py-1 [&_th]:!py-1",
              )}
            >
              {/* Pins the column tracks so they cannot be re-derived from
                  whichever virtualized rows happen to be mounted. */}
              <TableColGroup widths={[46, 40, ...visibleColumns.map((c) => c.width)]} />
              <thead className="mg-table-head-pinned">
                <tr>
                  <th className="w-6 px-3 py-2" aria-label="Watch" />
                  <th className="w-6 px-3 py-2" aria-label="Compare" />
                  {visibleColumns.map((col) => (
                    <th
                      key={col.header}
                      className={col.thClassName}
                      aria-sort={col.sortKey ? ariaSort(sort === col.sortKey, order) : undefined}
                    >
                      {col.sortKey ? (
                        <SortHeader
                          label={col.header}
                          field={col.sortKey}
                          active={sort === col.sortKey}
                          order={order}
                          onSort={onSort}
                          align={col.thClassName.includes("text-right") ? "right" : "left"}
                        />
                      ) : (
                        col.header
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {virtualPaddingTop > 0 ? (
                  <tr aria-hidden>
                    <td
                      colSpan={VALIDATOR_COLUMNS.length + 2}
                      style={{ height: virtualPaddingTop }}
                    />
                  </tr>
                ) : null}
                {virtualRows.map((vRow) => {
                  const v = rows[vRow.index];
                  return (
                    <tr
                      key={v.hotkey}
                      data-index={vRow.index}
                      ref={rowVirtualizer.measureElement}
                      className="hover:bg-surface/40"
                    >
                      <td className="px-3 py-2 align-middle">
                        <button
                          type="button"
                          onClick={() => watchlist.toggle(v.hotkey)}
                          aria-pressed={watchlist.isWatched(v.hotkey)}
                          aria-label={
                            watchlist.isWatched(v.hotkey)
                              ? "Remove from watchlist"
                              : "Add to watchlist"
                          }
                          className="mg-tap-target flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong"
                        >
                          <Star
                            className={classNames(
                              "size-3.5",
                              watchlist.isWatched(v.hotkey) && "fill-accent text-accent",
                            )}
                          />
                        </button>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <ValidatorCompareToggle hotkey={v.hotkey} />
                      </td>
                      {visibleColumns.map((col) => (
                        <td key={col.header} className={col.tdClassName}>
                          {col.cell(v, { group: groupInfo?.get(v.hotkey) })}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {virtualPaddingBottom > 0 ? (
                  <tr aria-hidden>
                    <td
                      colSpan={VALIDATOR_COLUMNS.length + 2}
                      style={{ height: virtualPaddingBottom }}
                    />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          title={search.q ? "No validators match this search" : "No validators indexed yet"}
          description={
            search.q
              ? "Try a different operator name, hotkey, or coldkey."
              : "The global validator directory is empty for this window."
          }
          action={
            search.q
              ? undefined
              : {
                  label: "Open /api/v1/validators",
                  href: `${API_BASE}/api/v1/validators`,
                  external: true,
                }
          }
        />
      )}

      {rows.length > 0 ? (
        <ValidatorCardList
          validators={rows.slice(0, 50)}
          className="grid gap-3 sm:grid-cols-2 lg:hidden"
        />
      ) : null}

      <ConcentrationSection validators={all} />
    </div>
  );
}

// #8251: the concentration story stays calm, but each top operator needs a
// stable categorical color. Mint remains an interface/focus signal; a single
// mint stack for ten different operators makes the chart impossible to scan.
// The stake-intensity heatmap remains behind an explicit disclosure.
function ConcentrationSection({ validators }: { validators: GlobalValidator[] }) {
  const [showDetail, setShowDetail] = useState(false);
  const ranked = useMemo(
    () =>
      [...validators]
        .filter((v) => v.stake_dominance != null && v.stake_dominance > 0)
        .sort((a, b) => (b.stake_dominance ?? 0) - (a.stake_dominance ?? 0)),
    [validators],
  );
  const top = ranked.slice(0, CONCENTRATION_TOP_N);
  if (top.length === 0) return null;
  const topShare = top.reduce((sum, v) => sum + (v.stake_dominance ?? 0), 0);
  const rest = Math.max(0, 1 - topShare);
  const label = (v: GlobalValidator) =>
    v.coldkey_identity?.has_identity && v.coldkey_identity.name
      ? v.coldkey_identity.name
      : (v.hotkey.slice(0, 6) ?? "validator");
  const seriesColors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
    "var(--chart-7)",
    "var(--chart-8)",
    "var(--chart-9)",
    "var(--chart-10)",
  ];
  const segments = [
    ...top.map((v, i) => ({
      label: label(v),
      value: (v.stake_dominance ?? 0) * 100,
      color: seriesColors[i % seriesColors.length]!,
    })),
    { label: "everyone else", value: rest * 100, color: "var(--border)" },
  ];

  return (
    <div id="validator-dominance" className="space-y-3 pt-3">
      <Panel as="div" dense>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="mg-type-caption text-ink-muted">
            Stake concentration · top {top.length} operators
          </span>
          <span className="mg-type-data-sm text-ink-muted">
            {(topShare * 100).toFixed(1)}% of network stake
          </span>
        </div>
        <MiniStack segments={segments} height={14} />
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {top.slice(0, 5).map((v) => (
            <span key={v.hotkey} className="mg-type-data-sm text-ink-muted">
              {label(v)} · {((v.stake_dominance ?? 0) * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      </Panel>

      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        className="inline-flex items-center gap-1.5 mg-type-data text-ink-muted hover:text-ink-strong"
      >
        <ChevronDown
          className={classNames("size-3.5 transition-transform", showDetail && "rotate-180")}
        />
        {showDetail ? "Hide concentration detail" : "Concentration detail"}
      </button>
      {showDetail ? (
        <div id="validator-subnet-heatmap">
          <AsyncPanel
            context="validator subnet heatmap"
            fallback={<Skeleton className="h-64 w-full" />}
          >
            <ValidatorSubnetHeatmap />
          </AsyncPanel>
        </div>
      ) : null}
    </div>
  );
}
