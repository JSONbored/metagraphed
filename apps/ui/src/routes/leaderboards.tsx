import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Scale, UserMinus } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  PageHero,
  BrandIcon,
  TimeAgo,
  StatTile,
  DensityToggle,
  ShareButton,
  type Density,
} from "@jsonbored/ui-kit";
import { ariaSort, SearchInput, SortHeader } from "@/components/metagraphed/table-controls";
import { LeaderboardsSavedViews } from "@/components/metagraphed/leaderboards-saved-views";
import {
  chainDeregistrationsQuery,
  chainWeightsQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Subnet } from "@/lib/metagraphed/types";

const WEIGHTS_SORT = ["netuid", "weight_sets", "distinct_setters", "sets_per_setter"] as const;
const DEREG_SORT = [
  "netuid",
  "deregistrations",
  "distinct_deregistered_hotkeys",
  "deregistrations_per_hotkey",
] as const;

const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
  q: fallback(z.string(), "").default(""),
  density: fallback(z.enum(["comfortable", "compact"]), "comfortable").default("comfortable"),
  // Exclusive saved-view focus so Weights·7d and Dereg·7d don't both light up
  // when both boards sit on their default sorts (#5344).
  focus: fallback(z.enum(["", "weights", "deregistrations"]), "").default(""),
  weightsSort: fallback(z.enum(WEIGHTS_SORT), "weight_sets").default("weight_sets"),
  weightsOrder: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  deregSort: fallback(z.enum(DEREG_SORT), "deregistrations").default("deregistrations"),
  deregOrder: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
});

type LeaderboardWindow = z.infer<typeof leaderboardsSearchSchema>["window"];
type WeightsSort = (typeof WEIGHTS_SORT)[number];
type DeregSort = (typeof DEREG_SORT)[number];

export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor leaderboards — validator weight-setting activity and neuron deregistrations ranked by subnet over 7d and 30d windows.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide Bittensor leaderboards — validator weight-setting activity and neuron deregistrations ranked by subnet over 7d and 30d windows.",
      },
    ],
  }),
  component: LeaderboardsPage,
});

const WINDOW_BTN_ACTIVE =
  "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent";
const WINDOW_BTN =
  "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30";

// Every board on this route ranks the same 7d/30d window, so the window control lives at the page
// level and governs both sections rather than each board owning a duplicate toggle.
function LeaderboardsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isMobile = useIsMobile();
  const win = search.window as LeaderboardWindow;
  const q = typeof search.q === "string" ? search.q : "";
  const weightsSort = (search.weightsSort as WeightsSort) ?? "weight_sets";
  const weightsOrder = search.weightsOrder === "asc" ? "asc" : "desc";
  const deregSort = (search.deregSort as DeregSort) ?? "deregistrations";
  const deregOrder = search.deregOrder === "asc" ? "asc" : "desc";
  const effectiveDensity: Density =
    search.density === "compact" || search.density === "comfortable"
      ? search.density
      : isMobile
        ? "compact"
        : "comfortable";

  const setDensity = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }) as never,
      replace: true,
    });

  return (
    <AppShell>
      <PageHero
        className="mb-6 md:mb-10"
        eyebrow="Explorer"
        live
        title="Leaderboards"
        description="Network-wide chain activity boards — ranked by subnet from live chain-direct analytics."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DensityToggle value={effectiveDensity} onChange={setDensity} />
            <ShareButton />
          </div>
        }
      />
      <LeaderboardsSavedViews />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          value={q}
          onChange={(v) =>
            navigate({
              search: (prev: Record<string, unknown>) => ({ ...prev, q: v }) as never,
              replace: true,
              resetScroll: false,
            })
          }
          placeholder="Filter by subnet name or netuid…"
          className="w-full min-w-0 sm:max-w-xs sm:flex-1"
        />
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Window
          </span>
          {(["7d", "30d"] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) => ({ ...prev, window: w }) as never,
                })
              }
              className={w === win ? WINDOW_BTN_ACTIVE : WINDOW_BTN}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-12">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <WeightSettingLeaderboard
              win={win}
              q={q}
              density={effectiveDensity}
              sort={weightsSort}
              order={weightsOrder}
            />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <DeregistrationsLeaderboard
              win={win}
              q={q}
              density={effectiveDensity}
              sort={deregSort}
              order={deregOrder}
            />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter paths={["/api/v1/chain/weights", "/api/v1/chain/deregistrations"]} />
    </AppShell>
  );
}

// Shared subnet lookup so a board row can render the brand icon + name for its netuid. subnetsQuery
// is cached per key, so both boards mounting it is a single shared fetch, not a waterfall.
function useSubnetById(): Map<number, Subnet> {
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  return useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
}

function matchesSubnetFilter(netuid: number, subnet: Subnet | undefined, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (String(netuid).includes(needle)) return true;
  const name = (subnet?.name ?? "").toLowerCase();
  const slug = (typeof subnet?.slug === "string" ? subnet.slug : "").toLowerCase();
  return name.includes(needle) || slug.includes(needle);
}

function cmpNum(a: number | null | undefined, b: number | null | undefined, order: "asc" | "desc") {
  const av = a ?? Number.NEGATIVE_INFINITY;
  const bv = b ?? Number.NEGATIVE_INFINITY;
  return order === "asc" ? av - bv : bv - av;
}

function WeightSettingLeaderboard({
  win,
  q,
  density,
  sort,
  order,
}: {
  win: LeaderboardWindow;
  q: string;
  density: Density;
  sort: WeightsSort;
  order: "asc" | "desc";
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: boardRes } = useSuspenseQuery(chainWeightsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const dist = board.intensity_distribution;
  const compact = density === "compact";
  const cellPad = compact ? "px-3 py-1.5" : "px-4 py-2.5";
  const monoSize = compact ? "text-[10px]" : "text-[11px]";

  const onSort = (field: string) => {
    if (!(WEIGHTS_SORT as readonly string[]).includes(field)) return;
    navigate({
      search: (prev: { weightsSort?: string; weightsOrder?: "asc" | "desc" }) =>
        ({
          ...prev,
          weightsSort: field,
          weightsOrder: prev.weightsSort === field && prev.weightsOrder === "desc" ? "asc" : "desc",
        }) as never,
      replace: true,
    });
  };

  const rows = useMemo(() => {
    const filtered = board.subnets.filter((row) =>
      matchesSubnetFilter(row.netuid, subnetById.get(row.netuid), q),
    );
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case "netuid":
          return cmpNum(a.netuid, b.netuid, order);
        case "distinct_setters":
          return cmpNum(a.distinct_setters, b.distinct_setters, order);
        case "sets_per_setter":
          return cmpNum(a.sets_per_setter, b.sets_per_setter, order);
        case "weight_sets":
        default:
          return cmpNum(a.weight_sets, b.weight_sets, order);
      }
    });
    return sorted;
  }, [board.subnets, subnetById, q, sort, order]);

  return (
    <div id="weights-board" className="space-y-8 scroll-mt-20">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Weight-setting activity
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Validator consensus effort ranked by subnet — raw WeightsSet events over the selected
          window.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Scale}
          eyebrow="Weight-sets"
          value={formatNumber(network.weight_sets)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={Scale}
          eyebrow="Distinct setters"
          value={formatNumber(network.distinct_setters)}
          hint="network-wide unique validators"
        />
        <StatTile
          icon={Scale}
          eyebrow="Per setter"
          value={network.sets_per_setter != null ? network.sets_per_setter.toFixed(2) : "—"}
          hint="network intensity"
        />
      </div>

      {dist ? (
        <p className="text-xs text-ink-muted">
          Update intensity across {formatNumber(dist.count)} subnets — median{" "}
          {dist.median.toFixed(2)}, p90 {dist.p90.toFixed(2)}, max {dist.max.toFixed(2)} sets per
          validator.
        </p>
      ) : null}

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No weight-setting activity in this window"
          description="The chain poller has not indexed any WeightsSet events for this window yet, or no validators set weights."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No subnets match this filter"
          description={`No weight-setting rows for “${q.trim()}”.`}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(rows.length)}
              {q.trim() ? ` of ${formatNumber(board.subnet_count)}` : ""} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          {/* < md: the 5-column table clips its trailing columns behind an
              undiscoverable horizontal scroll, so narrow viewports get a
              stacked card per subnet instead — mirrors the cards/desktop-only
              split the explorer leaderboards use for the same static boards. */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.sets_per_setter != null
                        ? `${row.sets_per_setter.toFixed(2)} / setter`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.weight_sets)} weight-sets</span>
                    <span>{formatNumber(row.distinct_setters)} setters</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className={cellPad}>Rank</th>
                  <th className={cellPad} aria-sort={ariaSort(sort === "netuid", order)}>
                    <SortHeader
                      label="Subnet"
                      field="netuid"
                      active={sort === "netuid"}
                      order={order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "weight_sets", order)}
                  >
                    <SortHeader
                      label="Weight-sets"
                      field="weight_sets"
                      active={sort === "weight_sets"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "distinct_setters", order)}
                  >
                    <SortHeader
                      label="Distinct setters"
                      field="distinct_setters"
                      active={sort === "distinct_setters"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "sets_per_setter", order)}
                  >
                    <SortHeader
                      label="Per setter"
                      field="sets_per_setter"
                      active={sort === "sets_per_setter"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="mg-row-accent hover:bg-surface/40">
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {i + 1}
                      </td>
                      <td className={cellPad}>
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={compact ? 16 : 18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-strong",
                          monoSize,
                        )}
                      >
                        {formatNumber(row.weight_sets)}
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {formatNumber(row.distinct_setters)}
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {row.sets_per_setter != null ? row.sets_per_setter.toFixed(2) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DeregistrationsLeaderboard({
  win,
  q,
  density,
  sort,
  order,
}: {
  win: LeaderboardWindow;
  q: string;
  density: Density;
  sort: DeregSort;
  order: "asc" | "desc";
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: boardRes } = useSuspenseQuery(chainDeregistrationsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const compact = density === "compact";
  const cellPad = compact ? "px-3 py-1.5" : "px-4 py-2.5";
  const monoSize = compact ? "text-[10px]" : "text-[11px]";

  const onSort = (field: string) => {
    if (!(DEREG_SORT as readonly string[]).includes(field)) return;
    navigate({
      search: (prev: { deregSort?: string; deregOrder?: "asc" | "desc" }) =>
        ({
          ...prev,
          deregSort: field,
          deregOrder: prev.deregSort === field && prev.deregOrder === "desc" ? "asc" : "desc",
        }) as never,
      replace: true,
    });
  };

  const rows = useMemo(() => {
    const filtered = board.subnets.filter((row) =>
      matchesSubnetFilter(row.netuid, subnetById.get(row.netuid), q),
    );
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "netuid":
          return cmpNum(a.netuid, b.netuid, order);
        case "distinct_deregistered_hotkeys":
          return cmpNum(a.distinct_deregistered_hotkeys, b.distinct_deregistered_hotkeys, order);
        case "deregistrations_per_hotkey":
          return cmpNum(a.deregistrations_per_hotkey, b.deregistrations_per_hotkey, order);
        case "deregistrations":
        default:
          return cmpNum(a.deregistrations, b.deregistrations, order);
      }
    });
  }, [board.subnets, subnetById, q, sort, order]);

  return (
    <div id="deregistrations-board" className="space-y-8 scroll-mt-20">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Deregistrations
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Neuron evictions ranked by subnet — raw NeuronDeregistered events over the selected
          window.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={UserMinus}
          eyebrow="Deregistrations"
          value={formatNumber(network.deregistrations)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Distinct hotkeys"
          value={formatNumber(network.distinct_deregistered_hotkeys)}
          hint="network-wide unique"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Per hotkey"
          value={
            network.deregistrations_per_hotkey != null
              ? network.deregistrations_per_hotkey.toFixed(2)
              : "—"
          }
          hint="network intensity"
        />
      </div>

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No deregistrations in this window"
          description="The chain poller has not indexed any NeuronDeregistered events for this window yet, or eviction activity was zero."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No subnets match this filter"
          description={`No deregistration rows for “${q.trim()}”.`}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(rows.length)}
              {q.trim() ? ` of ${formatNumber(board.subnet_count)}` : ""} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          {/* < md: card fallback per subnet (see the weight-setting board). */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.deregistrations_per_hotkey != null
                        ? `${row.deregistrations_per_hotkey.toFixed(2)} / hotkey`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.deregistrations)} deregistrations</span>
                    <span>{formatNumber(row.distinct_deregistered_hotkeys)} hotkeys</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className={cellPad}>Rank</th>
                  <th className={cellPad} aria-sort={ariaSort(sort === "netuid", order)}>
                    <SortHeader
                      label="Subnet"
                      field="netuid"
                      active={sort === "netuid"}
                      order={order}
                      onSort={onSort}
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "deregistrations", order)}
                  >
                    <SortHeader
                      label="Deregistrations"
                      field="deregistrations"
                      active={sort === "deregistrations"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "distinct_deregistered_hotkeys", order)}
                  >
                    <SortHeader
                      label="Distinct hotkeys"
                      field="distinct_deregistered_hotkeys"
                      active={sort === "distinct_deregistered_hotkeys"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                  <th
                    className={classNames(cellPad, "text-right")}
                    aria-sort={ariaSort(sort === "deregistrations_per_hotkey", order)}
                  >
                    <SortHeader
                      label="Per hotkey"
                      field="deregistrations_per_hotkey"
                      active={sort === "deregistrations_per_hotkey"}
                      order={order}
                      onSort={onSort}
                      align="right"
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="mg-row-accent hover:bg-surface/40">
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {i + 1}
                      </td>
                      <td className={cellPad}>
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={compact ? 16 : 18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-strong",
                          monoSize,
                        )}
                      >
                        {formatNumber(row.deregistrations)}
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {formatNumber(row.distinct_deregistered_hotkeys)}
                      </td>
                      <td
                        className={classNames(
                          cellPad,
                          "text-right font-mono tabular-nums text-ink-muted",
                          monoSize,
                        )}
                      >
                        {row.deregistrations_per_hotkey != null
                          ? row.deregistrations_per_hotkey.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
