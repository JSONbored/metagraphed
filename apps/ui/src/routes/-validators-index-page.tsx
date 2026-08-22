import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ValidatorsSearch } from "./validators.index";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { ChevronDown, Star } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  DataTableFrame,
  DensityToggle,
  DownloadCsvButton,
  ShareButton,
  type Density,
} from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  DataPageCanvas,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  FilterSheet,
  GhostButton,
  QueryBar,
  TableSkeleton,
} from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ValidatorIdentityDirectory } from "@/components/metagraphed/validator-identity-directory";
import { DirectoryModeTabs, type DirectoryMode } from "@/components/metagraphed/primitives";
import { ValidatorEconomicsRanking } from "@/components/metagraphed/validator-economics-ranking";
import { ValidatorStakeConcentration } from "@/components/metagraphed/validator-stake-concentration";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { groupByOperator } from "@/lib/metagraphed/group-validators";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
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

/** Compare is a per-key task, so the operator directory does not offer it. */
const VALIDATOR_MODES = [
  {
    value: "browse" as const,
    label: "Operators",
    hint: "Named operators ranked by stake. Expand one to see the keys it runs.",
  },
  {
    value: "research" as const,
    label: "All keys",
    hint: "Every validator key, with the full metric set and comparison.",
  },
];

export function ValidatorsPage() {
  const search = useSearch({ from: "/validators/" }) as ValidatorsSearch;
  const navigate = useNavigate({ from: "/validators/" });
  const density = search.density ?? "comfortable";
  const onDensityChange = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }),
      replace: true,
    });
  const mode: DirectoryMode = search.mode === "research" ? "research" : "browse";
  // The strip only offers the two this route implements, so anything else is
  // narrowed away rather than written into a URL the schema would reject.
  const setMode = (next: DirectoryMode) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        mode: next === "research" ? "research" : "browse",
      }),
      replace: true,
      resetScroll: false,
    });
  // Shared by both modes, so a query typed while browsing operators survives
  // the switch to the key table and keeps filtering there.
  const setQuery = (q: string) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, q }),
      replace: true,
      resetScroll: false,
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
          {/* Before the list, the shape. Reading 149 ranked rows tells you who
              is largest; it does not tell you that ten operators hold most of
              the network, because past the first few rows a linear rail has
              nothing left to draw. Same cached query as the directory. */}
          <DataPageModule
            title="Concentration."
            caption="How the network's validation stake divides between operators."
          >
            <AsyncPanel context="validator stake concentration" fallback={<Skeleton />}>
              <ValidatorStakeConcentration />
            </AsyncPanel>
          </DataPageModule>
          <DataPageModule title="Directory." caption="Who runs the network, and what they charge.">
            <DirectoryModeTabs
              mode={mode}
              onChange={setMode}
              modes={VALIDATOR_MODES}
              ariaLabel="Validator directory mode"
            />
            {mode === "browse" ? (
              <>
                {/* #11522 asks for search to reach the results at 375px. The
                    operator directory has always ACCEPTED a query — it filters
                    on `search.q` — but nothing ever rendered a box to type it
                    into, so 149 operators were reachable only by scrolling.
                    The filter existed; the input did not. */}
                <QueryBar className="min-h-11 lg:min-h-0" ariaLabel="Search operators">
                  <QueryBar.Search
                    value={search.q}
                    onChange={setQuery}
                    placeholder="Search operators by name"
                    debounceMs={200}
                  />
                </QueryBar>
                <AsyncPanel
                  context="validator operators"
                  fallback={<TableSkeleton rows={8} columns={3} />}
                >
                  <ValidatorIdentityDirectory query={search.q} />
                </AsyncPanel>
              </>
            ) : (
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
            )}
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

      {rows.length > 0 ? (
        <DataTableFrame
          className="mg-directory-table hidden md:block"
          title="Validators"
          countLabel={
            rows.length === all.length
              ? `(${formatNumber(all.length)})`
              : `(${formatNumber(rows.length)} of ${formatNumber(all.length)})`
          }
          controls={
            <>
              <QueryBar className="min-h-9 w-[22rem] max-w-full" ariaLabel="Search validators">
                <QueryBar.Search
                  value={search.q}
                  onChange={(v) => setSearch({ q: v })}
                  placeholder="Search operator, hotkey, or coldkey"
                  debounceMs={150}
                />
              </QueryBar>
              <FilterSheet label="Filters" activeCount={activeFilterCount}>
                {directoryRefinements}
              </FilterSheet>
            </>
          }
          status={
            <>
              <span className="mg-live-dot" aria-hidden="true" />
              <span>
                Live validator set, ranked by {sort === "total_stake_tao" ? "total stake" : sort}.
              </span>
              <span aria-hidden="true">·</span>
              <span>Every column sorts; hover a header for what it measures.</span>
            </>
          }
          footer={
            <>
              <span>
                {formatNumber(rows.length)} of {formatNumber(all.length)} validators
                {activeFilterCount > 0 ? ` · ${activeFilterCount} filter applied` : ""}
              </span>
              {search.watched ? (
                <button
                  type="button"
                  onClick={() => setSearch({ watched: false })}
                  className="mg-focus-ring text-ink-muted hover:text-ink-strong"
                >
                  Clear watchlist filter
                </button>
              ) : null}
            </>
          }
        >
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
                // 960, not 1,100. The old floor was sized for the nine-column
                // set and never revisited when the set changed, so at 1280 the
                // table was pinned 14px wider than its own container and the
                // last column sat permanently off the right edge — clipped by
                // a constant, not by its contents. The floor still exists: it
                // is what makes the table scroll on a narrow screen instead of
                // crushing nine columns into 375px.
                "mg-data-table w-full min-w-[960px] table-fixed text-left",
                compact && "[&_td]:!py-1 [&_th]:!py-1",
              )}
            >
              {/* Pins the column tracks so they cannot be re-derived from
                  whichever virtualized rows happen to be mounted. */}
              <TableColGroup widths={[64, ...visibleColumns.map((c) => c.width)]} />
              <thead className="mg-table-head-pinned">
                <tr>
                  {/* ONE leading control cell, not two. Watch and compare each
                      had a column of their own, so every row opened with two
                      near-empty icon cells before the first piece of data —
                      the reference leads with a single control and gets to the
                      name immediately. */}
                  <th className="px-3 py-2" aria-label="Row actions" />
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
                          help={col.help}
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
                      colSpan={VALIDATOR_COLUMNS.length + 1}
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
                        <span className="flex items-center gap-0.5">
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
                          <ValidatorCompareToggle hotkey={v.hotkey} />
                        </span>
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
                      colSpan={VALIDATOR_COLUMNS.length + 1}
                      style={{ height: virtualPaddingBottom }}
                    />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </DataTableFrame>
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
          className="grid gap-3 sm:grid-cols-2 md:hidden"
        />
      ) : null}

      <ConcentrationSection />
    </div>
  );
}

/**
 * The per-subnet stake heatmap, behind its own disclosure.
 *
 * This used to open with a second concentration bar, ranked by per-KEY
 * dominance while the directory above it ranks operators. The two disagreed in
 * public — the same page said the top ten hold 63.3% and 59.1% — because one
 * grouped an operator's keys and the other did not, and an operator running
 * two keys in the top ten could appear twice in the same chart. One question
 * gets one answer, so the bar is gone and `Concentration.` at the top of the
 * page is it: same primitive as every other composition on the site, same
 * operator grouping as the directory it sits above.
 */
function ConcentrationSection() {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div id="validator-dominance" className="space-y-3 pt-3">
      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        className="inline-flex items-center gap-1.5 mg-type-data text-ink-muted hover:text-ink-strong"
      >
        <ChevronDown
          className={classNames("size-3.5 transition-transform", showDetail && "rotate-180")}
        />
        {showDetail ? "Hide stake by subnet" : "Stake by subnet"}
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
