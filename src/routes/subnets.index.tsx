import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Suspense, useEffect } from "react";
import { zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BrandIcon, prefetchBrandIcon } from "@/components/metagraphed/brand-icon";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ShareButton } from "@/components/metagraphed/share-button";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
import { subnetsInfiniteQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import type { Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/subnets/")({
  validateSearch: zodValidator(tableSearchSchema),
  head: () => ({
    meta: [
      { title: "Subnets — Metagraphed" },
      {
        name: "description",
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
      search: { limit: search.limit } as never,
      replace: true,
    });
  return (
    <AppShell>
      <PageHeading
        eyebrow="Registry"
        title="Subnets"
        description="Every active Finney netuid — root and application — with curation level, surface count, health, and freshness."
        right={
          <>
            <ResetFiltersButton active={filtersActive} onReset={onReset} />
            <ShareButton />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SubnetsTable />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/subnets"]} artifacts={["/metagraph/subnets.json"]} />
    </AppShell>
  );
}

function SubnetsTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const baseParams = {
    q: search.q || undefined,
    sort: search.sort || undefined,
    order: search.sort ? search.order : undefined,
    limit: search.limit,
    curation: search.curation || undefined,
    health: search.health || undefined,
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

  const pages = data.pages as Array<
    (typeof data.pages)[number] & { cursorInvalid?: boolean }
  >;
  const lastPage = pages[pages.length - 1];
  const cursorInvalid = !!lastPage?.cursorInvalid;
  const all = pages.flatMap((p) => (p.data ?? []) as Subnet[]);
  const total = pages[0]?.meta?.pagination?.total ?? pages[0]?.meta?.total;

  // Mirror the most recently used cursor into the URL so refresh / sharing
  // restores the same starting page. `data.pageParams` is the canonical
  // record of which cursors fetched which pages.
  const lastPageParam = (data.pageParams[data.pageParams.length - 1] ?? "") as string;
  useEffect(() => {
    if (lastPageParam !== search.cursor) {
      navigate({
        search: (prev: Record<string, unknown>) =>
          ({ ...prev, cursor: lastPageParam }) as never,
        replace: true,
      });
    }
  }, [lastPageParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, ...patch, cursor: "" }) as never,
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

  const filtered = all.filter((s) => {
    if (!matchesQuery([s.netuid, s.name, s.symbol], search.q)) return false;
    if (search.curation && s.curation_level !== search.curation) return false;
    if (search.health && s.health !== search.health) return false;
    return true;
  });
  const rows = sortBy(filtered, search.sort, search.order, (row, key) =>
    (row as Record<string, unknown>)[key],
  );

  // Warm the favicon cache for visible rows during idle time so scrolling
  // feels instant. The browser dedupes the eventual <img> request.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1));
    const handle = ric(() => {
      for (const s of rows)
        prefetchBrandIcon(s.website, 32, {
          iconUrl: s.icon_url,
          lookup: { netuid: s.netuid },
        });
    });
    return () => {
      const cic =
        (window as unknown as { cancelIdleCallback?: (h: number) => void })
          .cancelIdleCallback ?? window.clearTimeout;
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

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      isStale={isFetching && !isFetchingNextPage}
      empty={
        <EmptyState
          title="No matching subnets"
          description="Try clearing filters or broadening the search."
        />
      }
      cards={rows.map((s) => (
        <Link
          key={s.netuid}
          to="/subnets/$netuid"
          params={{ netuid: String(s.netuid) }}
          className="block rounded border border-border bg-card p-3 min-h-11 active:bg-surface"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <BrandIcon
                url={s.website}
                iconUrl={s.icon_url}
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
            <span><TimeAgo at={s.updated_at ?? s.freshness} /></span>
          </div>
          <div className="mt-1.5"><CurationChip level={s.curation_level} /></div>
        </Link>
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className="px-4 py-2.5"><SortHeader label="UID" field="netuid" active={search.sort === "netuid"} order={search.order} onSort={onSort} /></th>
              <th className="px-4 py-2.5"><SortHeader label="Name" field="name" active={search.sort === "name"} order={search.order} onSort={onSort} /></th>
              <th className="px-4 py-2.5"><SortHeader label="Symbol" field="symbol" active={search.sort === "symbol"} order={search.order} onSort={onSort} /></th>
              <th className="px-4 py-2.5 text-right"><SortHeader label="Participants" field="participants" active={search.sort === "participants"} order={search.order} onSort={onSort} align="right" /></th>
              <th className="px-4 py-2.5"><SortHeader label="Curation" field="curation_level" active={search.sort === "curation_level"} order={search.order} onSort={onSort} /></th>
              <th className="px-4 py-2.5 text-right"><SortHeader label="Surfaces" field="surfaces_count" active={search.sort === "surfaces_count"} order={search.order} onSort={onSort} align="right" /></th>
              <th className="px-4 py-2.5">Health</th>
              <th className="px-4 py-2.5 text-right"><SortHeader label="Updated" field="updated_at" active={search.sort === "updated_at"} order={search.order} onSort={onSort} align="right" /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((s) => (
              <tr key={s.netuid} className="hover:bg-surface/40">
                <td className="px-4 py-2.5 font-mono text-[12px] text-ink-muted">
                  <Link to="/subnets/$netuid" params={{ netuid: String(s.netuid) }} className="hover:text-ink-strong">
                    {String(s.netuid).padStart(3, "0")}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Link to="/subnets/$netuid" params={{ netuid: String(s.netuid) }} className="inline-flex items-center gap-2 font-medium text-ink-strong hover:underline">
                    <BrandIcon
                      url={s.website}
                      iconUrl={s.icon_url}
                      name={s.name}
                      fallback={s.netuid}
                      size={20}
                    />
                    <span className="truncate">{s.name ?? `Subnet ${s.netuid}`}</span>
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">{s.symbol ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px]">{formatNumber(s.participants)}</td>
                <td className="px-4 py-2.5"><CurationChip level={s.curation_level} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px]">{s.surfaces_count ?? "—"}</td>
                <td className="px-4 py-2.5"><HealthPill state={s.health} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted"><TimeAgo at={s.updated_at ?? s.freshness} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      footer={
        <LoadMore
          shown={rows.length}
          total={total}
          hasMore={!!hasNextPage}
          isLoading={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          error={isFetchNextPageError ? (error as Error) : null}
          cursorInvalid={cursorInvalid}
        />
      }
    />
  );
}
