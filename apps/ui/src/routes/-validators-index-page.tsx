import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ValidatorsSearch } from "./validators.index";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Star } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  DataTable,
  EntityHero,
  FactSentence,
  type CellValue,
  type DataTableColumn,
  type SortState,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ValidatorEconomicsRanking } from "@/components/metagraphed/validator-economics-ranking";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy } from "@/lib/metagraphed/url-state";
import { groupByOperator } from "@/lib/metagraphed/group-validators";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { ValidatorSubnetCoverage } from "@/components/metagraphed/charts/validator-subnet-coverage";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { VALIDATOR_COLUMNS } from "@/components/metagraphed/validator-columns";
import {
  ValidatorsCompareDrawer,
  ValidatorCompareToggle,
} from "@/components/metagraphed/validators-compare-drawer";
import { HubSections, hubLede } from "@/components/metagraphed/hub-prose";
import type { GlobalValidator } from "@/lib/metagraphed/types";
import { readKey } from "@/lib/metagraphed/read-key";

// #8251: one request for the FULL directory (~1,014 validators live; the API
// cap was raised 100 -> 2000 in the same change) — the table sorts and
// searches the whole set locally and pages it 50 rows at a time, so there is
// no server pagination tier.
// Exported so the homepage's Watched module can request the identical query
// (same sort + limit = same cache key) and read from cache rather than firing
// a second 2000-row fetch (#8256).
export const ALL_VALIDATORS_LIMIT = 2000;
const CONCENTRATION_TOP_N = 10;
const VALIDATORS_PAGE_SIZE = 50;

export function ValidatorsPage() {
  return (
    <AppShell>
      <EntityHero
        name="Validators"
        sentence={<FactSentence>{hubLede("/validators")}</FactSentence>}
      />
      <ValidatorGuide />
      <AsyncPanel
        context="validators"
        fallback={<Skeleton className="h-80 w-full" />}
        retryQueryKeys={[
          validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT, subnets: false })
            .queryKey,
        ]}
      >
        <ValidatorsDirectory />
      </AsyncPanel>
      {/* #10300: the cross-subnet "where is it cheapest to start validating"
          ranking was published and rendered nowhere. */}
      <section className="mt-8">
        <ValidatorEconomicsRanking />
      </section>
      <ApiSourceFooter paths={["/api/v1/validators", "/api/v1/validators/economics"]} />
      <ValidatorsCompareDrawer />
      {/* Below the table on purpose -- see hub-prose.tsx. */}
      <HubSections path="/validators" />
    </AppShell>
  );
}

/** A dynamic row field narrowed to what the table can sort and export. */
function cellValue(row: object, key: string | undefined): CellValue {
  if (!key) return null;
  const raw = readKey(row, key);
  return typeof raw === "number" || typeof raw === "string" ? raw : null;
}

function ValidatorsDirectory() {
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
  const watchlist = useWatchlist("validator");
  const { isWatched, toggle: toggleWatch, count: watchedCount } = watchlist;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      // Patch in-page search/filter state only; no scroll-to-top per keystroke (#3691).
      resetScroll: false,
      replace: true,
    });

  // Client-side search + sort over the full set. Watched rows pin to the top
  // within the current sort (stable partition, not a separate list).
  const sortedRows = useMemo(() => {
    const filtered = all.filter(
      (v) =>
        matchesQuery([v.hotkey, v.coldkey, v.coldkey_identity?.name], search.q) &&
        (!search.watched || isWatched(v.hotkey)),
    );
    const sorted = sortBy(filtered, sort, order, (row, key) => {
      return readKey(row, key);
    });
    if (watchedCount === 0) return sorted;
    const watched: GlobalValidator[] = [];
    const rest: GlobalValidator[] = [];
    for (const v of sorted) (isWatched(v.hotkey) ? watched : rest).push(v);
    return [...watched, ...rest];
  }, [all, search.q, search.watched, sort, order, isWatched, watchedCount]);

  // Cluster an operator's keys adjacent under its best-ranked row (default on):
  // one "Ventura Labs ×3" entry instead of the same name repeated at three
  // ranks. Per-key rows survive untouched — nothing is summed across keys.
  const { rows, groupInfo } = useMemo(() => {
    if (!grouped) return { rows: sortedRows, groupInfo: null };
    const { list, info } = groupByOperator(sortedRows);
    return { rows: list, groupInfo: info };
  }, [sortedRows, grouped]);

  // ~1,000 rows, so the directory pages rather than mounting all of them.
  // The page is owned here, not by the table: the table's own page state does
  // not reset when a search narrows the set, which strands the reader on an
  // empty page whose pager has disappeared with it. Clamping is the safety
  // net; resetting on a filter change is the behaviour a reader expects.
  const [pageState, setPageState] = useState(1);
  const filterKey = `${search.q}|${search.watched}|${grouped}|${sort}|${order}`;
  useEffect(() => {
    setPageState(1);
  }, [filterKey]);
  const pageTotal = Math.max(1, Math.ceil(rows.length / VALIDATORS_PAGE_SIZE));
  const page = Math.min(pageState, pageTotal);
  const pageRows = useMemo(
    () => rows.slice((page - 1) * VALIDATORS_PAGE_SIZE, page * VALIDATORS_PAGE_SIZE),
    [rows, page],
  );

  // The directory's own column set, plus the two per-row controls that used to
  // sit outside it. Memoized because DataTable re-reads its stored column
  // selection whenever the column set changes identity.
  const columns = useMemo<Array<DataTableColumn<GlobalValidator>>>(
    () => [
      {
        key: "watch",
        label: "Watch",
        width: 46,
        value: (v) => (isWatched(v.hotkey) ? "watched" : ""),
        render: (v) => (
          <button
            type="button"
            onClick={() => toggleWatch(v.hotkey)}
            aria-pressed={isWatched(v.hotkey)}
            aria-label={isWatched(v.hotkey) ? "Remove from watchlist" : "Add to watchlist"}
            className="mg-tap-target flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong"
          >
            <Star
              className={classNames("size-3.5", isWatched(v.hotkey) && "fill-accent text-accent")}
            />
          </button>
        ),
      },
      {
        key: "compare",
        label: "Compare",
        width: 40,
        value: () => null,
        render: (v) => <ValidatorCompareToggle hotkey={v.hotkey} />,
      },
      ...VALIDATOR_COLUMNS.map((col): DataTableColumn<GlobalValidator> => ({
        key: col.id,
        label: col.header,
        width: col.width,
        demote: !col.defaultVisible,
        sortable: Boolean(col.sortKey),
        align: col.thClassName.includes("text-right") ? "right" : "left",
        // The operator column has no sortable field of its own, but its name
        // is what a CSV of this table has to carry.
        value: (v) =>
          col.id === "operator"
            ? (v.coldkey_identity?.name ?? v.hotkey)
            : cellValue(v, col.sortKey),
        render: (v) => col.cell(v, { group: groupInfo?.get(v.hotkey) }),
      })),
    ],
    [isWatched, toggleWatch, groupInfo],
  );

  const sortedColumn = VALIDATOR_COLUMNS.find((c) => c.sortKey === sort);
  const sortState: SortState | null = sortedColumn ? { key: sortedColumn.id, dir: order } : null;

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

      <DataTable
        caption="Validators"
        rows={pageRows}
        total={rows.length}
        page={page}
        onPage={setPageState}
        pageSize={VALIDATORS_PAGE_SIZE}
        columns={columns}
        rowKey={(v) => v.hotkey}
        link={RouterLink}
        storageKey="validators"
        source="validator"
        sort={sortState}
        onSort={(next) => {
          const column = next ? VALIDATOR_COLUMNS.find((c) => c.id === next.key) : undefined;
          setSearch({
            sort: column?.sortKey ?? "total_stake_tao",
            order: column && next ? next.dir : "desc",
          });
        }}
        search={{
          value: search.q,
          onChange: (v) => setSearch({ q: v }),
          placeholder: "Operator, hotkey, or coldkey",
        }}
        filters={
          <>
            <button
              type="button"
              onClick={() => setSearch({ grouped: !grouped })}
              aria-pressed={grouped}
              title="Cluster an operator's validator keys under one entry"
              className={classNames(
                "inline-flex min-h-7 items-center gap-1.5 rounded border px-2 py-1 text-13 transition-colors",
                grouped
                  ? "border-accent/40 bg-accent/10 text-accent-text"
                  : "border-border bg-card text-ink-muted hover:border-accent/40 hover:text-ink-strong",
              )}
            >
              Group
            </button>
            {/* #8256: only offered once something is starred -- an always-visible
                filter that can only ever return nothing is furniture. */}
            {watchedCount > 0 ? (
              <button
                type="button"
                onClick={() => setSearch({ watched: !search.watched })}
                aria-pressed={search.watched}
                className={classNames(
                  "inline-flex min-h-7 items-center gap-1.5 rounded border px-2 py-1 text-13 transition-colors",
                  search.watched
                    ? "border-accent/40 bg-accent/10 text-accent-text"
                    : "border-border bg-card text-ink-muted hover:border-accent/40 hover:text-ink-strong",
                )}
              >
                <Star
                  className={classNames("size-3.5", search.watched && "fill-accent text-accent")}
                  aria-hidden
                />
                {watchedCount}
              </button>
            ) : null}
          </>
        }
        empty={
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
        }
      />

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
  const label = (v: GlobalValidator) =>
    v.coldkey_identity?.has_identity && v.coldkey_identity.name
      ? v.coldkey_identity.name
      : (v.hotkey.slice(0, 6) ?? "validator");
  return (
    <div id="validator-dominance" className="space-y-3 pt-3">
      <Panel>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-13 text-ink-muted">
            Stake concentration · top {top.length} operators
          </span>
          <span className="text-10 text-ink-muted">
            {(topShare * 100).toFixed(1)}% of network stake
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {top.slice(0, 5).map((v) => (
            <span key={v.hotkey} className="text-10 text-ink-muted">
              {label(v)} · {((v.stake_dominance ?? 0) * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      </Panel>

      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        className="inline-flex items-center gap-1.5 text-11 text-ink-muted hover:text-ink-strong"
      >
        <ChevronDown
          className={classNames("size-3.5 transition-transform", showDetail && "rotate-180")}
        />
        {showDetail ? "Hide concentration detail" : "Concentration detail"}
      </button>
      {showDetail ? (
        <div id="validator-subnet-coverage">
          <AsyncPanel
            context="validator subnet coverage"
            fallback={<Skeleton className="h-64 w-full" />}
          >
            <ValidatorSubnetCoverage />
          </AsyncPanel>
        </div>
      ) : null}
    </div>
  );
}
