import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { ChevronDown, Star } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  DensityToggle,
  MiniStack,
  type Density,
} from "@jsonbored/ui-kit";
import {
  AsyncPanel,
  PageMasthead,
  Panel,
  TableSkeleton,
} from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { formatNumber, isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { VALIDATOR_COLUMNS } from "@/components/metagraphed/validator-columns";
import {
  ValidatorsCompareDrawer,
  ValidatorCompareToggle,
} from "@/components/metagraphed/validators-compare-drawer";
import { SortHeader, ariaSort, SearchInput } from "@/components/metagraphed/table-controls";
import type { GlobalValidator } from "@/lib/metagraphed/types";

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
  const search = useSearch({ from: "/validators/" });
  const navigate = useNavigate({ from: "/validators/" });
  const density = search.density ?? "comfortable";
  // Mirror the sibling ranked-list pages (subnets/blocks/surfaces): export the
  // current view as CSV. DownloadCsvButton appends `format=csv`; the backend's
  // handleGlobalValidators already serves it (#5482).
  const validatorsCsvUrl = buildUrl("/api/v1/validators", {
    sort: "total_stake",
    limit: ALL_VALIDATORS_LIMIT,
  });
  const onDensityChange = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }) as never,
      replace: true,
    });
  return (
    <AppShell>
      <PageMasthead
        eyebrow="Directory"
        live
        title="Validators"
        description="Network-wide validator directory — every hotkey ranked across all Bittensor subnets, computed live from the chain-direct metagraph."
        actions={
          <>
            <ActionBar>
              <DownloadCsvButton url={validatorsCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      <ValidatorGuide />
      <AsyncPanel
        context="validators"
        fallback={<TableSkeleton rows={10} columns={8} />}
        retryQueryKeys={[
          validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT }).queryKey,
        ]}
      >
        <ValidatorsDirectory density={density} onDensityChange={onDensityChange} />
      </AsyncPanel>
      <ApiSourceFooter paths={["/api/v1/validators"]} />
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
  const search = useSearch({ from: "/validators/" });
  const navigate = useNavigate({ from: "/validators/" });
  const sort = search.sort || "total_stake_tao";
  const order = search.order ?? "desc";
  // One canonical fetch regardless of the URL's sort/filter state — the query
  // key never changes with UI state, so sorting/searching re-uses the cached
  // full set instead of refetching.
  const res = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT }),
  ).data;
  const all = res.data.validators;
  const generatedAt = res.meta?.generated_at ?? null;
  const compact = density === "compact";
  const watchlist = useWatchlist("validator");

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; no scroll-to-top per keystroke (#3691).
      resetScroll: false,
      replace: true,
    });

  const onSort = (field: string) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "desc" ? "asc" : "desc",
        }) as never,
      replace: true,
    });

  // Client-side search + sort over the full set. Watched rows pin to the top
  // within the current sort (stable partition, not a separate list).
  const rows = useMemo(() => {
    const filtered = all.filter(
      (v) =>
        matchesQuery([v.hotkey, v.coldkey, v.coldkey_identity?.name], search.q) &&
        (!search.watched || watchlist.isWatched(v.hotkey)),
    );
    const sorted = sortBy(filtered, sort, order, (row, key) => {
      const rec = row as unknown as Record<string, unknown>;
      return rec[key];
    });
    if (watchlist.count === 0) return sorted;
    const watched: GlobalValidator[] = [];
    const rest: GlobalValidator[] = [];
    for (const v of sorted) (watchlist.isWatched(v.hotkey) ? watched : rest).push(v);
    return [...watched, ...rest];
  }, [all, search.q, search.watched, sort, order, watchlist]);

  // #8251: virtualized table body — the same padding-row technique the
  // /subnets table established (#8314): only the visible slice mounts as real
  // in-flow `<tr>`s, with two spacer rows standing in for off-screen space,
  // so the sticky header and column alignment keep working.
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => (compact ? 33 : 41),
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  return (
    <div className="space-y-3">
      {isStaleFreshness(generatedAt) ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[
            validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT }).queryKey,
          ]}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search.q}
          onChange={(v) => setSearch({ q: v })}
          placeholder="Search by operator, hotkey, or coldkey"
          className="w-full sm:w-80"
        />
        {/* #8256: only offered once something is starred -- an always-visible
            filter that can only ever return nothing is furniture. */}
        {watchlist.count > 0 ? (
          <button
            type="button"
            onClick={() => setSearch({ watched: !search.watched })}
            aria-pressed={search.watched}
            className={classNames(
              "inline-flex min-h-9 items-center gap-1.5 rounded border px-2.5 py-1 mg-type-caption font-medium transition-colors",
              search.watched
                ? "border-accent/40 bg-accent/10 text-accent-text"
                : "border-border bg-card text-ink-muted hover:border-accent/40 hover:text-ink-strong",
            )}
          >
            <Star
              className={classNames("size-3.5", search.watched && "fill-accent text-accent")}
              aria-hidden
            />
            Watched · {watchlist.count}
          </button>
        ) : null}
        <span className="mg-type-data text-ink-muted">
          {formatNumber(rows.length)} of {formatNumber(all.length)} validators
        </span>
        <div className="ml-auto">
          <DensityToggle value={density} onChange={onDensityChange} />
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="hidden md:block rounded-md border border-border">
          <div ref={tableScrollRef} className="max-h-[70vh] overflow-auto">
            <table
              className={classNames(
                "w-full text-left text-sm",
                compact && "[&_td]:!py-1 [&_th]:!py-1",
              )}
            >
              <thead className="sticky top-0 z-[var(--mg-z-sticky)] bg-surface">
                <tr>
                  <th className="w-6 px-3 py-2" aria-label="Watch" />
                  <th className="w-6 px-3 py-2" aria-label="Compare" />
                  {VALIDATOR_COLUMNS.map((col) => (
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
                      {VALIDATOR_COLUMNS.map((col) => (
                        <td key={col.header} className={col.tdClassName}>
                          {col.cell(v)}
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
          className="grid gap-3 sm:grid-cols-2 md:hidden"
        />
      ) : null}

      <ConcentrationSection validators={all} />
    </div>
  );
}

// #8251: the concentration story, calmed. The old full-bleed flat-mint
// treemap (the loudest visual element on the site) retires; in its place, ONE
// accent moment — a top-10 stacked horizontal dominance bar — and the
// stake-intensity heatmap matrix survives behind a collapsed "Concentration
// detail" disclosure instead of rendering unconditionally.
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
  const segments = [
    ...top.map((v, i) => ({
      label: label(v),
      value: (v.stake_dominance ?? 0) * 100,
      // One accent moment: interpolate opacity down the ranking rather than
      // introducing a second hue.
      color: `color-mix(in oklab, var(--accent) ${100 - i * 8}%, var(--border))`,
    })),
    { label: "everyone else", value: rest * 100, color: "var(--border)" },
  ];

  return (
    <div id="validator-dominance" className="space-y-3 pt-3">
      <Panel as="div" dense>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="mg-type-micro text-ink-muted">
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
