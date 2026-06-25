import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo } from "react";
import { Network, Radio, Layers, Activity } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BrandIcon, prefetchBrandIcon } from "@/components/metagraphed/brand-icon";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
import { MiniStack } from "@/components/metagraphed/charts/stat-with-spark";
import { DensityToggle, type Density } from "@/components/metagraphed/density-toggle";
import { ViewModeToggle, type ViewMode } from "@/components/metagraphed/view-mode-toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ShareButton } from "@/components/metagraphed/share-button";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import {
  ariaSort,
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
import { SubnetsSavedViews } from "@/components/metagraphed/subnets-saved-views";
import {
  SubnetsCompareDrawer,
  CompareToggle,
} from "@/components/metagraphed/subnets-compare-drawer";
import {
  subnetsInfiniteQuery,
  coverageQuery,
  healthQuery,
  subnetHealthMapQuery,
} from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { joinHealth, matchesQuery, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import { API_BASE } from "@/lib/metagraphed/config";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/subnets/")({
  validateSearch: tableSearchSchema,
  head: () => ({
    meta: [
      { title: "Subnets — Metagraphed" },
      {
        name: "description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
      { property: "og:title", content: "Subnets — Metagraphed" },
      {
        property: "og:description",
        content:
          "Browse every active Bittensor Finney subnet with curation level, surfaces, health, and freshness.",
      },
    ],
  }),
  component: SubnetsPage,
});

function SubnetsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filtersActive =
    !!search.q || !!search.sort || !!search.curation || !!search.health || !!search.cursor;
  const onReset = () =>
    navigate({
      search: { limit: search.limit, view: search.view } as never,
      replace: true,
    });
  const setView = (v: ViewMode) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, view: v }) as never,
      replace: true,
    });
  const isMobile = useIsMobile();
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
        eyebrow="Registry"
        live
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        actions={
          <>
            <ViewModeToggle value={search.view} onChange={setView} />
            {search.view === "table" ? (
              <DensityToggle value={effectiveDensity} onChange={setDensity} />
            ) : null}
            <ResetFiltersButton active={filtersActive} onReset={onReset} />
            <ShareButton />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense
          fallback={
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          }
        >
          <SubnetsStatStrip />
        </Suspense>
      </QueryErrorBoundary>
      <SubnetsSavedViews />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SubnetsTable view={search.view} density={effectiveDensity} />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/subnets"]} artifacts={["/metagraph/subnets.json"]} />
      <SubnetsCompareDrawer />
    </AppShell>
  );
}

function SubnetsStatStrip() {
  const coverage = useSuspenseQuery(coverageQuery()).data.data ?? {};
  const health = useSuspenseQuery(healthQuery()).data.data ?? {};
  // Wired to the live /api/v1/coverage shape (same as CoverageFunnel): the older
  // netuids_active/netuids_total/adapter_backed fields are null on the live payload.
  const active =
    (coverage.netuids_active as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const total =
    (coverage.netuids_total as number | undefined) ??
    (coverage.chain_subnet_count as number | undefined);
  const adapter =
    (coverage.curation_level_counts as Record<string, number> | undefined)?.["adapter-backed"] ??
    (coverage.adapter_backed as number | undefined);
  // "Manifested surfaces" = total surfaces declared in the registry. The legacy
  // `manifested_count` is hard-0 on the live payload (deprecated) and `??` won't
  // skip a real 0, so it silently zeroed the tile; `surface_count` is the live
  // total. (`curated_overlay_count` is a subnet count — wrong unit for surfaces.)
  const manifested =
    (coverage.surface_count as number | undefined) ??
    (coverage.manifested_count as number | undefined) ??
    (coverage.surfaces_total as number | undefined);
  const ok = health.ok;
  const totalH = health.total;
  const healthyOk = ok != null && totalH != null && totalH > 0 && ok / totalH > 0.9;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <StatTile
        icon={Network}
        eyebrow="Active subnets"
        value={formatNumber(active)}
        hint={total ? `of ${formatNumber(total)}` : undefined}
      />
      <StatTile
        icon={Radio}
        eyebrow="Adapter-backed"
        value={formatNumber(adapter)}
        hint="pilots"
        tone="accent"
      />
      <StatTile icon={Layers} eyebrow="Manifested surfaces" value={formatNumber(manifested)} />
      <StatTile
        icon={Activity}
        eyebrow="Healthy"
        value={ok != null && totalH ? `${formatNumber(ok)}/${formatNumber(totalH)}` : "—"}
        tone={healthyOk ? "ok" : "default"}
      />
    </div>
  );
}

function SubnetsTable({ view, density = "comfortable" }: { view: ViewMode; density?: Density }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // /api/v1/subnets supports only q + cursor/limit. `sort` returns HTTP 400, and
  // `curation`/`health` are ignored server-side — so those are applied
  // client-side (filtered/sorted over the fetched pages) and must NOT be sent.
  const baseParams = {
    q: search.q || undefined,
    limit: search.limit,
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error,
    isFetching,
  } = useSuspenseInfiniteQuery(subnetsInfiniteQuery(baseParams, search.cursor));

  // Per-subnet probe health (the list rows don't carry it; join it from
  // /api/v1/health so the Health + Updated columns and the health filter work).
  // Key the `?? {}` fallback off the raw query value so `healthMap` keeps a
  // stable reference across renders — otherwise a fresh `{}` each render would
  // defeat the `all` memo below.
  const healthMapRaw = useSuspenseQuery(subnetHealthMapQuery()).data.data;
  const healthMap = useMemo(() => healthMapRaw ?? {}, [healthMapRaw]);

  const pages = data.pages as Array<(typeof data.pages)[number] & { cursorInvalid?: boolean }>;
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!lastPage?.cursorInvalid;
  // Join the fetched pages with per-subnet probe health. Memoized on its real
  // inputs (the page set + the health map) so a keystroke/hover that only
  // re-renders the route doesn't re-flatten and re-clone every row.
  const all = useMemo(
    () =>
      joinHealth(
        pages.flatMap((p) => (p.data ?? []) as Subnet[]),
        healthMap,
      ),
    [pages, healthMap],
  );
  const total = pages[0]?.meta?.pagination?.total ?? pages[0]?.meta?.total;

  // Treat the URL cursor as the immutable starting point for this infinite query.
  // Updating it after fetching more pages changes the query key and drops already
  // accumulated pages.

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }) as never,
    });

  const onSort = (field: string) =>
    navigate({
      search: (prev: { sort?: string; order?: "asc" | "desc" }) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "asc" ? "desc" : "asc",
          cursor: "",
        }) as never,
    });

  const filtersActive = !!(search.q || search.curation || search.health || search.sort);

  // Client-side filter + sort (the list API only honors q + cursor/limit).
  // Both are memoized on the joined rows and the exact search params they read,
  // so they only recompute when one of those actually changes — not on every
  // keystroke-driven re-render.
  const filtered = useMemo(
    () =>
      all.filter((s) => {
        if (!matchesQuery([s.netuid, s.name, s.symbol], search.q)) return false;
        if (search.curation && s.curation_level !== search.curation) return false;
        if (search.health && s.health !== search.health) return false;
        return true;
      }),
    [all, search.q, search.curation, search.health],
  );
  const rows = useMemo(
    () =>
      sortBy(
        filtered,
        search.sort,
        search.order,
        (row, key) => (row as Record<string, unknown>)[key],
      ),
    [filtered, search.sort, search.order],
  );

  // Warm the favicon cache for visible rows during idle time so scrolling
  // feels instant. The browser dedupes the eventual <img> request. `rows` is
  // memoized above, so this effect only re-runs when the visible row set
  // actually changes — not on every keystroke/hover-driven re-render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const handle = ric(() => {
      for (const s of rows)
        prefetchBrandIcon(s.website, 32, {
          iconUrl: s.icon_url,
          repoUrl: s.repo,
          lookup: { netuid: s.netuid },
        });
    });
    return () => {
      const cic =
        (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback ??
        window.clearTimeout;
      cic(handle as number);
    };
  }, [rows]);

  const filters = (
    <>
      <SearchInput
        value={search.q}
        onChange={(v) => setSearch({ q: v })}
        placeholder="Search by netuid, name, or symbol"
      />
      <SelectFilter
        label="curation"
        value={search.curation}
        onChange={(v) => setSearch({ curation: v })}
        options={[
          { value: "native", label: "native" },
          { value: "candidate-discovered", label: "candidate" },
          { value: "machine-verified", label: "machine" },
          { value: "maintainer-reviewed", label: "reviewed" },
          { value: "adapter-backed", label: "adapter" },
        ]}
      />
      <SelectFilter
        label="health"
        value={search.health}
        onChange={(v) => setSearch({ health: v })}
        options={[
          { value: "ok", label: "ok" },
          { value: "warn", label: "warn" },
          { value: "down", label: "down" },
          { value: "unknown", label: "unknown" },
        ]}
      />
      <PageSizeSelect value={search.limit} onChange={(n) => setSearch({ limit: n })} />
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No subnets match these filters"
      description={
        filtersActive
          ? "Try clearing one or more filters, or broaden the search."
          : "The registry returned no subnets — the source artifact may be temporarily unavailable."
      }
      action={
        filtersActive
          ? { label: "Reset filters", href: "/subnets" }
          : {
              label: "Open /api/v1/subnets",
              href: `${API_BASE}/api/v1/subnets`,
              external: true,
            }
      }
    />
  );

  const footerNode = (
    <LoadMore
      shown={rows.length}
      total={total}
      hasMore={!!hasNextPage}
      isLoading={isFetchingNextPage}
      onLoadMore={() => fetchNextPage()}
      error={isFetchNextPageError ? (error as Error) : null}
      cursorInvalid={cursorInvalid}
    />
  );

  // Grid / matrix views skip ListShell so they're not boxed in a table card.
  if (view === "grid" || view === "matrix") {
    return (
      <div>
        <div className="sticky top-14 z-20 -mx-4 md:mx-0 mb-3 bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80 border-b border-border md:border md:rounded md:bg-card px-3 py-2 md:p-2.5">
          <div className="flex flex-wrap items-center gap-2">{filters}</div>
        </div>
        {rows.length === 0 && !hasNextPage ? (
          emptyNode
        ) : view === "grid" ? (
          <SubnetGrid rows={rows} />
        ) : (
          <SubnetMatrix rows={rows} />
        )}
        <div className="mt-3">{footerNode}</div>
      </div>
    );
  }

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0 && !hasNextPage}
      isStale={isFetching && !isFetchingNextPage}
      empty={emptyNode}
      cards={rows.map((s) => (
        <Link
          key={s.netuid}
          to="/subnets/$netuid"
          params={{ netuid: s.netuid }}
          className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <BrandIcon
                url={s.website}
                repoUrl={s.repo}
                iconUrl={s.icon_url}
                netuid={s.netuid}
                name={s.name}
                fallback={s.netuid}
                size={32}
              />
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-ink-muted">
                  #{String(s.netuid).padStart(3, "0")}
                  {s.symbol ? ` · ${s.symbol}` : ""}
                </div>
                <div className="font-medium text-ink-strong truncate">
                  {s.name ?? `Subnet ${s.netuid}`}
                </div>
              </div>
            </div>
            <HealthPill state={s.health} />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-muted">
            <span>{formatNumber(s.participants)} participants</span>
            <span>{s.surfaces_count ?? 0} surfaces</span>
            <span>
              <TimeAgo at={s.updated_at ?? s.freshness} />
            </span>
          </div>
          <div className="mt-1.5">
            <CurationChip level={s.curation_level} />
          </div>
        </Link>
      ))}
      table={(() => {
        const compact = density === "compact";
        const cellPad = compact ? "px-3 py-1.5" : "px-4 py-2.5";
        const firstPad = compact ? "pl-3 pr-1 py-1.5" : "pl-4 pr-1 py-2.5";
        const monoSize = compact ? "text-[11px]" : "text-[12px]";
        return (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-sticky-offset z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
              <tr>
                <th className={classNames(firstPad, "w-6")} aria-label="Compare" />
                <th
                  className={cellPad}
                  aria-sort={ariaSort(search.sort === "netuid", search.order)}
                >
                  <SortHeader
                    label="UID"
                    field="netuid"
                    active={search.sort === "netuid"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th className={cellPad} aria-sort={ariaSort(search.sort === "name", search.order)}>
                  <SortHeader
                    label="Name"
                    field="name"
                    active={search.sort === "name"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th
                  className={cellPad}
                  aria-sort={ariaSort(search.sort === "symbol", search.order)}
                >
                  <SortHeader
                    label="Symbol"
                    field="symbol"
                    active={search.sort === "symbol"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(search.sort === "participants", search.order)}
                >
                  <SortHeader
                    label="Participants"
                    field="participants"
                    active={search.sort === "participants"}
                    order={search.order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={cellPad}
                  aria-sort={ariaSort(search.sort === "curation_level", search.order)}
                >
                  <SortHeader
                    label="Curation"
                    field="curation_level"
                    active={search.sort === "curation_level"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(search.sort === "surfaces_count", search.order)}
                >
                  <SortHeader
                    label="Surfaces"
                    field="surfaces_count"
                    active={search.sort === "surfaces_count"}
                    order={search.order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th className={cellPad}>Health</th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(search.sort === "updated_at", search.order)}
                >
                  <SortHeader
                    label="Updated"
                    field="updated_at"
                    active={search.sort === "updated_at"}
                    order={search.order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((s) => (
                <tr key={s.netuid} className="mg-row-accent hover:bg-surface/40">
                  <td className={classNames(firstPad, "align-middle")}>
                    <CompareToggle netuid={s.netuid} />
                  </td>
                  <td className={classNames(cellPad, "font-mono text-ink-muted", monoSize)}>
                    <EntityHoverCard kind="subnet" netuid={s.netuid}>
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: s.netuid }}
                        className="hover:text-ink-strong"
                      >
                        {String(s.netuid).padStart(3, "0")}
                      </Link>
                    </EntityHoverCard>
                  </td>
                  <td className={cellPad}>
                    <EntityHoverCard kind="subnet" netuid={s.netuid}>
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: s.netuid }}
                        className="inline-flex items-center gap-2 font-medium text-ink-strong hover:underline"
                      >
                        <BrandIcon
                          url={s.website}
                          repoUrl={s.repo}
                          iconUrl={s.icon_url}
                          netuid={s.netuid}
                          name={s.name}
                          fallback={s.netuid}
                          size={compact ? 18 : 20}
                        />
                        <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
                      </Link>
                    </EntityHoverCard>
                  </td>
                  <td className={classNames(cellPad, "font-mono text-[11px] text-ink-muted")}>
                    {s.symbol ?? "—"}
                  </td>
                  <td className={classNames(cellPad, "text-right")}>
                    <ParticipantsCell
                      value={s.participants}
                      density={density}
                      updatedAt={s.updated_at ?? s.freshness}
                    />
                  </td>
                  <td className={cellPad}>
                    <CurationChip level={s.curation_level} />
                  </td>
                  <td className={classNames(cellPad, "text-right")}>
                    <SurfacesCell subnet={s} density={density} />
                  </td>
                  <td className={cellPad}>
                    <HealthPill state={s.health} />
                  </td>
                  <td
                    className={classNames(
                      cellPad,
                      "text-right font-mono text-[11px] text-ink-muted",
                    )}
                  >
                    <TimeAgo at={s.updated_at ?? s.freshness} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
      footer={footerNode}
    />
  );
}

/* ---------- Grid view ---------- */

function SubnetGrid({ rows }: { rows: Subnet[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((s) => (
        <Link
          key={s.netuid}
          to="/subnets/$netuid"
          params={{ netuid: s.netuid }}
          className="group relative flex flex-col gap-3 rounded border border-border bg-card p-4 mg-hover-lift mg-fade-in"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <BrandIcon
                url={s.website}
                iconUrl={s.icon_url}
                netuid={s.netuid}
                name={s.name}
                fallback={s.netuid}
                size={36}
              />
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  #{String(s.netuid).padStart(3, "0")}
                  {s.symbol ? ` · ${s.symbol}` : ""}
                </div>
                <div className="font-display font-semibold text-ink-strong truncate">
                  {s.name ?? `Subnet ${s.netuid}`}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <CompareToggle netuid={s.netuid} />
              <HealthPill state={s.health} />
            </div>
          </div>

          {(s as { description?: string }).description ? (
            <p className="text-[12px] text-ink-muted leading-relaxed line-clamp-2">
              {(s as { description?: string }).description}
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-border/70">
            <CurationChip level={s.curation_level} />
            <div className="flex items-center gap-3 font-mono text-[10px] text-ink-muted">
              <span title="Participants">{formatNumber(s.participants)}</span>
              <span title="Surfaces">{s.surfaces_count ?? 0} surf</span>
              <TimeAgo at={s.updated_at ?? s.freshness} />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/* ---------- Matrix view ---------- */

const HEALTH_BG: Record<string, string> = {
  ok: "bg-health-ok/90 hover:bg-health-ok",
  warn: "bg-health-warn/80 hover:bg-health-warn",
  down: "bg-health-down/85 hover:bg-health-down",
  unknown: "bg-health-unknown/40 hover:bg-health-unknown/70",
};

function SubnetMatrix({ rows }: { rows: Subnet[] }) {
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Health matrix · {rows.length} subnets
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-ink-muted">
          <Legend color="bg-health-ok" label="ok" />
          <Legend color="bg-health-warn" label="warn" />
          <Legend color="bg-health-down" label="down" />
          <Legend color="bg-health-unknown" label="unknown" />
        </div>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(2.25rem, 1fr))" }}
      >
        {rows.map((s) => (
          <EntityHoverCard key={s.netuid} kind="subnet" netuid={s.netuid}>
            <Link
              to="/subnets/$netuid"
              params={{ netuid: s.netuid }}
              aria-label={`Subnet ${s.netuid}${s.name ? ` — ${s.name}` : ""}`}
              title={`#${s.netuid}${s.name ? ` · ${s.name}` : ""} · ${s.health ?? "unknown"}`}
              className={classNames(
                "mg-pulse-cell flex aspect-square items-center justify-center rounded-sm font-mono text-[10px] font-medium text-white/95 transition-transform",
                HEALTH_BG[s.health ?? "unknown"] ?? HEALTH_BG.unknown,
              )}
            >
              {s.netuid}
            </Link>
          </EntityHoverCard>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={classNames("size-2 rounded-sm", color)} />
      {label}
    </span>
  );
}

/* ---------- Row visualization cells ---------- */

const SURFACE_KIND_COLORS: Record<string, string> = {
  api: "var(--accent)",
  openapi: "var(--accent)",
  docs: "var(--health-ok)",
  repo: "var(--ink-strong)",
  dashboard: "var(--health-warn)",
  data: "var(--ink-muted)",
  sdk: "var(--accent)",
  example: "var(--health-ok)",
  sse: "var(--health-warn)",
  rpc: "var(--ink-strong)",
};

function ParticipantsCell({
  value,
  density = "comfortable",
  updatedAt,
}: {
  value?: number;
  density?: Density;
  updatedAt?: string | null;
}) {
  const n = typeof value === "number" ? value : 0;
  const pct = Math.max(0, Math.min(1, n / 256));
  const compact = density === "compact";
  return (
    <SparkLegend
      metric="Participant density"
      source="Live participant count from the on-chain metagraph, scaled against the 256-slot subnet cap."
      windowLabel="live"
      updatedAt={updatedAt ?? null}
      staleness="Reflects the most recent block snapshot; bar disappears when the count is zero or unknown."
      side="left"
    >
      <span className="inline-flex flex-col items-end gap-0.5 min-w-[64px]">
        <span
          className={classNames(
            "font-mono tabular-nums text-ink",
            compact ? "text-[11px]" : "text-[12px]",
          )}
        >
          {formatNumber(value)}
        </span>
        <span
          className={classNames(
            "overflow-hidden rounded-full bg-border/50 w-14",
            compact ? "h-0.5" : "h-1",
          )}
          aria-hidden
        >
          <span className="block h-full bg-accent/70" style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
    </SparkLegend>
  );
}

function SurfacesCell({ subnet, density = "comfortable" }: { subnet: Subnet; density?: Density }) {
  const count = subnet.surfaces_count ?? 0;
  const rec = subnet as unknown as Record<string, unknown>;
  const num = (k: string) => (typeof rec[k] === "number" ? (rec[k] as number) : 0);
  const byKind = (rec.surfaces_by_kind ?? rec.surface_kinds) as Record<string, number> | undefined;
  // Prefer a real per-kind breakdown if the list API ever exposes one; otherwise
  // show the surface-trust composition (official / registry-observed / other) —
  // the list API always carries these counts, so the bar is a meaningful
  // breakdown instead of a flat single-segment placeholder.
  const TRUST_COLORS: Record<string, string> = {
    official: "var(--accent)",
    observed: "var(--ink-muted)",
    other: "var(--border)",
  };
  const official = num("official_surface_count");
  const observed = num("registry_observed_count");
  const trust = [
    { label: "official", value: official },
    { label: "observed", value: observed },
    { label: "other", value: Math.max(0, count - official - observed) },
  ];
  const segments = (
    byKind
      ? Object.entries(byKind).map(([k, v]) => ({
          label: k,
          value: typeof v === "number" ? v : 0,
          color: SURFACE_KIND_COLORS[k.toLowerCase()] ?? "var(--ink-muted)",
        }))
      : trust.map((t) => ({ ...t, color: TRUST_COLORS[t.label] }))
  ).filter((s) => s.value > 0);
  const compact = density === "compact";
  const summary = (
    byKind ? Object.entries(byKind) : (trust.map((t) => [t.label, t.value]) as [string, number][])
  )
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

  return (
    <SparkLegend
      metric={byKind ? "Surface kinds" : "Surface trust"}
      source={`Verified public surfaces for SN${subnet.netuid}${byKind ? ", grouped by kind" : ", by trust tier (official / registry-observed)"}.${summary ? ` — ${summary}` : ""}`}
      windowLabel="latest snapshot"
      updatedAt={subnet.updated_at ?? subnet.freshness ?? null}
      staleness="Unverified candidates are excluded from the count; the bar shows the trust composition of manifested surfaces."
      side="top"
    >
      <span
        className={classNames("flex items-center gap-2", compact ? "min-w-[72px]" : "min-w-[88px]")}
      >
        <span
          className={classNames(
            "font-mono tabular-nums text-ink w-6 text-right",
            compact ? "text-[11px]" : "text-[12px]",
          )}
        >
          {count || "—"}
        </span>
        <span className={classNames("flex-1", compact ? "max-w-[64px]" : "max-w-[80px]")}>
          <MiniStack segments={segments} height={compact ? 4 : 6} />
        </span>
      </span>
    </SparkLegend>
  );
}
