import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { CurationChip } from "@/components/metagraphed/chips";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { ShareButton } from "@/components/metagraphed/share-button";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
  SortHeader,
} from "@/components/metagraphed/table-controls";
import { ListShell, LoadMore } from "@/components/metagraphed/list-shell";
import { surfacesInfiniteQuery } from "@/lib/metagraphed/queries";
import { formatRelative } from "@/lib/metagraphed/format";
import { matchesQuery, sortBy, tableSearchSchema } from "@/lib/metagraphed/url-state";
import type { Surface } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/surfaces")({
  validateSearch: zodValidator(tableSearchSchema),
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
      search: { limit: search.limit } as never,
      replace: true,
    });
  return (
    <AppShell>
      <PageHero
        eyebrow="Registry"
        live
        title="Surfaces"
        description="Verified public interfaces across subnets — filter by kind, provider, and netuid."
        actions={
          <>
            <ResetFiltersButton active={filtersActive} onReset={onReset} />
            <ShareButton />
          </>
        }
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <SurfacesTable />
        </Suspense>
      </QueryErrorBoundary>
      <section className="mt-section">
        <SectionHeading title="Evidence & sources" />
        <EvidencePanel />
      </section>
      <ApiSourceFooter paths={["/api/v1/surfaces"]} artifacts={["/metagraph/surfaces.json"]} />
    </AppShell>
  );
}

function SurfacesTable() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

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

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      isStale={isFetching && !isFetchingNextPage}
      empty={<EmptyState title="No matching surfaces" />}
      cards={rows.map((s) => (
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
          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-muted">
            <span>
              {s.netuid != null ? (
                <Link to="/subnets/$netuid" params={{ netuid: s.netuid }}>
                  #{String(s.netuid).padStart(3, "0")}
                </Link>
              ) : (
                "—"
              )}
              {" · "}
              {s.provider_slug ? (
                <Link to="/providers/$slug" params={{ slug: s.provider_slug }}>
                  {s.provider ?? s.provider_slug}
                </Link>
              ) : (
                (s.provider ?? "—")
              )}
            </span>
            <span>
              <TimeAgo at={s.updated_at} />
            </span>
          </div>
        </div>
      ))}
      table={
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
              <tr key={s.id} className="hover:bg-surface/40">
                <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                  {s.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: s.netuid }}
                      className="hover:text-ink-strong"
                    >
                      {String(s.netuid).padStart(3, "0")}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{s.kind ?? "—"}</td>
                <td className="px-3 py-2 font-medium text-ink-strong">
                  <span className="inline-flex items-center gap-2">
                    <BrandIcon
                      url={s.url}
                      providerSlug={s.provider_slug}
                      name={s.name ?? s.provider}
                      fallback={s.netuid}
                      size={18}
                      className="shrink-0"
                    />
                    <span className="truncate">{s.name ?? "—"}</span>
                  </span>
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
                <td className="px-3 py-2 text-[12px]">
                  {s.provider_slug ? (
                    <Link
                      to="/providers/$slug"
                      params={{ slug: s.provider_slug }}
                      className="hover:underline"
                    >
                      {s.provider ?? s.provider_slug}
                    </Link>
                  ) : (
                    (s.provider ?? "—")
                  )}
                </td>
                <td className="px-3 py-2">
                  <CurationChip level={s.curation_level} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={s.updated_at} />
                </td>
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
