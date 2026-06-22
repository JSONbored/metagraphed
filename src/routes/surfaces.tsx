import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CurationChip } from "@/components/metagraphed/chips";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { Skeleton } from "@/components/metagraphed/states";
import { RegistryEmpty } from "@/components/metagraphed/states/registry-empty";
import { PageHero } from "@/components/metagraphed/page-hero";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { ShareButton } from "@/components/metagraphed/share-button";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
import { ViewModeToggle } from "@/components/metagraphed/view-mode-toggle";
import {
  TimeRangeProvider,
  useTimeRange,
  RANGE_LABEL,
} from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
import { surfacesInfiniteQuery, providersQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { matchesQuery, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import type { Surface, Provider, Subnet } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/surfaces")({
  validateSearch: tableSearchSchema,
  head: () => ({
    meta: [
      { title: "Surfaces — Metagraphed" },
      {
        name: "description",
        content:
          "Verified public interfaces across Bittensor subnets: APIs, docs, dashboards, repos, SDKs.",
      },
      { property: "og:title", content: "Surfaces — Metagraphed" },
      {
        property: "og:description",
        content:
          "Verified public interfaces across Bittensor subnets: APIs, docs, dashboards, repos, SDKs.",
      },
    ],
  }),
  component: SurfacesPage,
});

function SurfacesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filtersActive =
    !!search.q || !!search.sort || !!search.kind || !!search.provider || !!search.cursor;
  const onReset = () =>
    navigate({
      // Keep page size and view on reset so the chosen layout survives.
      search: { limit: search.limit, view: search.view } as never,
      replace: true,
    });
  const viewMode: "table" | "grid" = search.view === "grid" ? "grid" : "table";
  return (
    <AppShell>
      <TimeRangeProvider defaultRange="7d">
        <PageHero
          eyebrow="Registry"
          live
          title="Surfaces"
          description="Verified public interfaces across subnets — filter by kind, provider, and netuid."
          actions={
            <>
              <TimeRangeScrub />
              <ViewModeToggle
                value={viewMode}
                options={["table", "grid"]}
                onChange={(v) =>
                  navigate({
                    search: (prev: Record<string, unknown>) => ({ ...prev, view: v }) as never,
                    replace: true,
                  })
                }
              />
              <ResetFiltersButton active={filtersActive} onReset={onReset} />
              <ShareButton />
            </>
          }
        />
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <SurfacesTable view={viewMode} />
          </Suspense>
        </QueryErrorBoundary>
        <section className="mt-section">
          <SectionHeading title="Evidence & sources" />
          <EvidencePanel />
        </section>
      </TimeRangeProvider>
      <ApiSourceFooter paths={["/api/v1/surfaces"]} artifacts={["/metagraph/surfaces.json"]} />
    </AppShell>
  );
}

function SurfacesTable({ view }: { view: "table" | "grid" }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { range } = useTimeRange();
  const windowLabel = `${RANGE_LABEL[range]} window · latest snapshot`;

  const baseParams = {
    q: search.q || undefined,
    sort: search.sort || undefined,
    order: search.sort ? search.order : undefined,
    limit: search.limit,
    kind: search.kind || undefined,
    provider: search.provider || undefined,
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error,
    isFetching,
  } = useSuspenseInfiniteQuery(surfacesInfiniteQuery(baseParams, search.cursor));

  // Lookup maps for inline subnet + provider logos (BrandIcon resolves
  // icon_url → brand override → favicon → monogram).
  const { data: provRes } = useSuspenseQuery(providersQuery());
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  const providerById = useMemo(() => {
    const m = new Map<string, Provider>();
    for (const p of (provRes.data ?? []) as Provider[]) m.set(p.slug, p);
    return m;
  }, [provRes]);
  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);

  const pages = data.pages as Array<(typeof data.pages)[number] & { cursorInvalid?: boolean }>;
  const cursorInvalid = !!pages[pages.length - 1]?.cursorInvalid;
  const all = pages.flatMap((p) => (p.data ?? []) as Surface[]);
  const total = pages[0]?.meta?.pagination?.total ?? pages[0]?.meta?.total;

  // The URL cursor is the immutable starting point for this infinite query —
  // surfacesInfiniteQuery keys on `initialCursor`, so mirroring the advancing
  // cursor back into the URL would change the query key on every "load more"
  // and drop the already-accumulated pages. Deliberately not done.

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) if (s.kind) set.add(s.kind);
    return Array.from(set)
      .sort()
      .map((v) => ({ value: v, label: v }));
  }, [all]);

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) {
      const p = s.provider_slug ?? s.provider;
      if (p) set.add(p);
    }
    return Array.from(set)
      .sort()
      .map((v) => ({ value: v, label: v }));
  }, [all]);

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

  const filtered = all.filter((s) => {
    if (!matchesQuery([s.name, s.url, s.provider, s.provider_slug, s.netuid], search.q))
      return false;
    if (search.kind && s.kind !== search.kind) return false;
    if (search.provider && (s.provider_slug ?? s.provider) !== search.provider) return false;
    return true;
  });
  const rows = sortBy(
    filtered,
    search.sort,
    search.order,
    (row, key) => (row as Record<string, unknown>)[key],
  );

  const filters = (
    <>
      <SearchInput
        value={search.q}
        onChange={(v) => setSearch({ q: v })}
        placeholder="Search by name, URL, provider, or netuid"
      />
      <SelectFilter
        label="kind"
        value={search.kind}
        onChange={(v) => setSearch({ kind: v })}
        options={kindOptions}
      />
      <SelectFilter
        label="provider"
        value={search.provider}
        onChange={(v) => setSearch({ provider: v })}
        options={providerOptions}
      />
      <PageSizeSelect value={search.limit} onChange={(n) => setSearch({ limit: n })} />
    </>
  );

  const filtersActive = !!(search.q || search.kind || search.provider);

  const emptyNode = (
    <RegistryEmpty
      variant="empty"
      title={filtersActive ? "No surfaces match these filters" : "No surfaces yet"}
      description={
        filtersActive
          ? "Loosen or remove a filter to see more rows. Surfaces are curated public interfaces — APIs, docs, dashboards, repos, and SDKs."
          : "Once a subnet's public interfaces are verified they appear here with provider attribution and a freshness stamp."
      }
      freshnessHint="Surface records refresh on every registry build. Source-of-truth lives in the published artifact."
      evidenceHref="/metagraph/surfaces.json"
      actions={
        filtersActive
          ? [
              {
                label: "Reset filters",
                onClick: () => setSearch({ q: "", kind: "", provider: "" }),
                primary: true,
              },
              { label: "Open API", href: "/api/v1/surfaces", external: true },
            ]
          : [
              { label: "Browse subnets", to: "/subnets", primary: true },
              {
                label: "Suggest a surface",
                href: "https://github.com/metagraphed",
                external: true,
              },
            ]
      }
    />
  );

  const renderProviderCell = (s: Surface) => {
    const slug = s.provider_slug;
    const p = slug ? providerById.get(slug) : undefined;
    const name = s.provider ?? p?.name ?? slug ?? "—";
    if (!slug) return <span className="text-ink-muted">{name}</span>;
    return (
      <Link
        to="/providers/$slug"
        params={{ slug }}
        className="inline-flex items-center gap-1.5 hover:underline min-w-0"
      >
        <BrandIcon
          url={p?.website ?? p?.homepage}
          iconUrl={p?.icon_url}
          repoUrl={p?.repo}
          providerSlug={slug}
          name={p?.name ?? name}
          fallback={slug}
          size={16}
        />
        <span className="truncate">{name}</span>
      </Link>
    );
  };

  const renderSubnetCell = (netuid: number | undefined | null) => {
    if (netuid == null) return <span className="text-ink-muted">—</span>;
    const sn = subnetById.get(netuid);
    return (
      <Link
        to="/subnets/$netuid"
        params={{ netuid }}
        className="inline-flex items-center gap-1.5 hover:text-ink-strong min-w-0"
      >
        <BrandIcon
          url={sn?.website}
          iconUrl={sn?.icon_url}
          netuid={netuid}
          name={sn?.name}
          fallback={netuid}
          size={16}
        />
        <span className="font-mono">{String(netuid).padStart(3, "0")}</span>
      </Link>
    );
  };

  const cardFor = (s: Surface) => (
    <div key={s.id} className="rounded border border-border bg-card p-3 min-h-11">
      <div className="flex items-center justify-between gap-2">
        <span className="mg-label">{s.kind ?? "surface"}</span>
        <CurationChip level={s.curation_level} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <BrandIcon
          url={s.url}
          providerSlug={s.provider_slug}
          name={s.name ?? s.provider}
          fallback={s.netuid}
          size={20}
          className="shrink-0"
        />
        <span className="font-medium text-ink-strong truncate">{s.name ?? "—"}</span>
      </div>
      {s.url ? (
        <div className="mt-1 text-[12px] truncate">
          <ExternalLink
            href={s.url}
            authRequired={s.auth_required}
            publicSafe={s.public_safe ?? true}
          >
            {s.url}
          </ExternalLink>
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] font-mono text-ink-muted">
        <span className="inline-flex items-center gap-2 min-w-0">
          {renderSubnetCell(s.netuid)}
          <span aria-hidden>·</span>
          {renderProviderCell(s)}
        </span>
        <SparkLegend
          metric="Surface verification"
          source="/api/v1/surfaces"
          windowLabel={windowLabel}
          updatedAt={s.last_verified_at ?? undefined}
          staleness="Re-verified on every registry build; unverified rows have never been probed."
        >
          <TimeAgo at={s.last_verified_at} fallback="never verified" />
        </SparkLegend>
      </div>
    </div>
  );

  // The user-selectable grid view renders the cards at every breakpoint, so it
  // is passed as the single `table` body (no mobile-only `cards` duplication).
  // The table view keeps ListShell's responsive cards↔table split.
  const gridBody = (
    <div className="grid gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3">{rows.map(cardFor)}</div>
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      isStale={isFetching && !isFetchingNextPage}
      empty={emptyNode}
      cards={view === "grid" ? undefined : rows.map(cardFor)}
      table={
        view === "grid" ? (
          gridBody
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/50">
              <tr>
                <th className="px-3 py-2">
                  <SortHeader
                    label="Netuid"
                    field="netuid"
                    active={search.sort === "netuid"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th className="px-3 py-2">
                  <SortHeader
                    label="Kind"
                    field="kind"
                    active={search.sort === "kind"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th className="px-3 py-2">
                  <SortHeader
                    label="Name"
                    field="name"
                    active={search.sort === "name"}
                    order={search.order}
                    onSort={onSort}
                  />
                </th>
                <th className="px-3 py-2">URL</th>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">Curation</th>
                <th className="px-3 py-2 text-right">
                  <SortHeader
                    label="Last verified"
                    field="last_verified_at"
                    active={search.sort === "last_verified_at"}
                    order={search.order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((s) => (
                <tr key={s.id} className="mg-row-accent hover:bg-surface/40">
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                    {renderSubnetCell(s.netuid)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{s.kind ?? "—"}</td>
                  <td className="px-3 py-2 font-medium text-ink-strong">
                    <span className="truncate">{s.name ?? "—"}</span>
                  </td>
                  <td className="px-3 py-2 text-[12px]">
                    {s.url ? (
                      <ExternalLink
                        href={s.url}
                        authRequired={s.auth_required}
                        publicSafe={s.public_safe ?? true}
                      >
                        {s.url}
                      </ExternalLink>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px]">{renderProviderCell(s)}</td>
                  <td className="px-3 py-2">
                    <CurationChip level={s.curation_level} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                    <SparkLegend
                      metric="Surface verification"
                      source="/api/v1/surfaces"
                      windowLabel={windowLabel}
                      updatedAt={s.last_verified_at ?? undefined}
                      staleness="Re-verified on every registry build; unverified rows have never been probed."
                    >
                      <TimeAgo at={s.last_verified_at} fallback="never verified" />
                    </SparkLegend>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
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
