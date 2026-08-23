import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AsyncPanel, QueryProgress } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { FixtureLookupPanel } from "@/components/metagraphed/registry-pipeline-panel";
import { StateBlock } from "@/components/metagraphed/states/state-block";
import { ApisTabActions } from "./-apis-hub";
import { EvidencePanel } from "@/components/metagraphed/evidence-panel";
import {
  TimeAgo,
  CurationChip,
  ReviewChip,
  ExternalLink,
  BrandIcon,
  DataTable,
  LoadMore,
  Provenance,
  SectionHead,
  type SortState,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  TimeRangeProvider,
  useTimeRange,
  RANGE_LABEL,
} from "@/components/metagraphed/analytics/time-range-context";
import { TimeRangeScrub } from "@/components/metagraphed/analytics/time-range-scrub";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import {
  surfacesInfiniteQuery,
  providersQuery,
  subnetsQuery,
  metagraphedQueryKey,
} from "@/lib/metagraphed/queries";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { sortBy } from "@/lib/metagraphed/url-state";
import { matchesSurfaceFilters } from "@/lib/metagraphed/surface-filters";
import type { Surface, Provider, Subnet } from "@/lib/metagraphed/types";

export function SurfacesPage() {
  const search = useSearch({ from: "/apis/" });
  const navigate = useNavigate({ from: "/apis/" });
  const filtersActive =
    !!search.q ||
    !!search.sort ||
    !!search.kind ||
    !!search.provider ||
    !!search.netuid ||
    !!search.public_safe ||
    !!search.auth ||
    !!search.rate_limited ||
    !!search.cursor;
  const onReset = () =>
    navigate({
      // Keep the page size on reset so the chosen fetch window survives.
      search: { limit: search.limit },
      replace: true,
    });
  return (
    <>
      <TimeRangeProvider defaultRange="7d">
        {/* Lifted off this page's own masthead — the hub owns title and
            description now (#8302). Above the tab content, never beside the tab
            strip: a shrink-0 sibling there starved profile-tabs to 196px on
            mobile (#8254). */}
        <ApisTabActions>
          <TimeRangeScrub />
          <div className="mg-actions">
            <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
          </div>
        </ApisTabActions>
        <AsyncPanel
          height="xl"
          context="surfaces"
          retryQueryKeys={[
            metagraphedQueryKey("surfaces-infinite"),
            metagraphedQueryKey("providers"),
            metagraphedQueryKey("subnets"),
          ]}
        >
          <SurfacesTable />
        </AsyncPanel>
        <section className="mt-section">
          <SectionHead name="Evidence & sources" />
          <EvidencePanel />
        </section>
        {/* #10300: /api/v1/fixtures/{surface_id} was published and rendered
            nowhere. An absent fixture is an ANSWER, not an error. */}
        <section className="mt-section">
          <FixtureLookupPanel />
        </section>
      </TimeRangeProvider>
      <ApiSourceFooter
        paths={["/api/v1/surfaces", "/api/v1/fixtures/{surface_id}"]}
        artifacts={["/metagraph/surfaces.json"]}
      />
      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis" />
    </>
  );
}

function SurfacesTable() {
  const search = useSearch({ from: "/apis/" });
  const navigate = useNavigate({ from: "/apis/" });
  const { range } = useTimeRange();
  const windowLabel = `${RANGE_LABEL[range]} window · latest snapshot`;

  const baseParams = {
    q: search.q || undefined,
    sort: search.sort || undefined,
    order: search.sort ? search.order : undefined,
    limit: search.limit,
    kind: search.kind || undefined,
    provider: search.provider || undefined,
    // Sent to the API, not applied over the loaded page. These were
    // client-side, which meant ?auth=required filtered the 25 rows the first
    // page happened to contain -- 6 of the 1,184 surfaces that actually match.
    // A filter that silently under-reports by 99% reads as a working filter.
    auth_required:
      search.auth === "required" ? "true" : search.auth === "none" ? "false" : undefined,
    public_safe: search.public_safe ? "true" : undefined,
    rate_limited: search.rate_limited ? "true" : undefined,
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

  const netuidOptions = useMemo(() => {
    const set = new Set<number>();
    for (const s of all) if (s.netuid != null) set.add(s.netuid);
    return Array.from(set)
      .sort((a, b) => a - b)
      .map((v) => ({ value: String(v), label: String(v) }));
  }, [all]);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch, cursor: "" }),
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  // The sort is a server parameter as well as a client ordering, so it stays in
  // the URL; clearing it (DataTable's third click) drops the parameter entirely.
  const onSort = (next: SortState | null) =>
    navigate({
      search: (prev: { sort?: string; order?: "asc" | "desc" }) => ({
        ...prev,
        sort: next?.key ?? "",
        order: next?.dir ?? "asc",
        cursor: "",
      }),
    });

  const filtered = all.filter((s) => matchesSurfaceFilters(s, search));
  const rows = sortBy(
    filtered,
    search.sort,
    search.order,
    (row, key) => (row as Record<string, unknown>)[key],
  );

  const filtersActive = Boolean(
    search.q ||
    search.kind ||
    search.provider ||
    search.netuid ||
    search.public_safe ||
    search.auth ||
    search.rate_limited,
  );

  const emptyNode = (
    <StateBlock
      kind="registry"
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
                onClick: () =>
                  setSearch({
                    q: "",
                    kind: "",
                    provider: "",
                    netuid: "",
                    public_safe: "",
                    auth: "",
                    rate_limited: "",
                  }),
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

  return (
    <div id="surfaces-list" className="relative">
      <QueryProgress active={isFetching && !isFetchingNextPage} position="sticky" />
      {/* `paginate={false}`: the query is cursor-paged against the API, so the
          table shows everything loaded so far and `LoadMore` below fetches the
          next server page — one paging concept, not two. */}
      <DataTable
        rows={rows}
        rowKey={(s) => s.id}
        caption="Surfaces"
        source="surfaces"
        storageKey="surfaces"
        link={RouterLink}
        paginate={false}
        total={total}
        sort={search.sort ? { key: search.sort, dir: search.order } : null}
        onSort={onSort}
        search={{
          value: search.q,
          onChange: (v) => setSearch({ q: v }),
          placeholder: "Search by name, URL, provider, or netuid",
        }}
        filters={
          <>
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
            <SelectFilter
              label="netuid"
              value={search.netuid}
              onChange={(v) => setSearch({ netuid: v })}
              options={netuidOptions}
            />
          </>
        }
        empty={emptyNode}
        columns={[
          {
            key: "netuid",
            label: "Netuid",
            sortable: true,
            value: (s) => s.netuid ?? null,
            render: (s) => renderSubnetCell(s.netuid),
          },
          { key: "kind", label: "Kind", sortable: true, value: (s) => s.kind ?? null },
          { key: "name", label: "Name", sortable: true, value: (s) => s.name ?? null },
          {
            key: "url",
            label: "URL",
            value: (s) => s.url ?? null,
            render: (s) =>
              s.url ? (
                <ExternalLink
                  href={s.url}
                  authRequired={s.auth_required}
                  publicSafe={s.public_safe ?? true}
                >
                  {s.url}
                </ExternalLink>
              ) : (
                "—"
              ),
          },
          {
            key: "provider",
            label: "Provider",
            value: (s) => s.provider ?? s.provider_slug ?? null,
            render: renderProviderCell,
          },
          {
            key: "curation",
            label: "Curation",
            value: (s) => s.curation_level ?? null,
            render: (s) => (
              <span className="inline-flex items-center gap-1.5">
                <CurationChip level={s.curation_level} />
                <ReviewChip state={s.review?.state} />
              </span>
            ),
          },
          {
            key: "last_verified_at",
            label: "Last verified",
            kind: "time",
            sortable: true,
            align: "right",
            value: (s) => s.last_verified_at ?? null,
            render: (s) => (
              <Provenance
                metric="Surface verification"
                source="/api/v1/surfaces"
                windowLabel={windowLabel}
                updatedAt={s.last_verified_at ?? undefined}
                staleness="Re-verified on every registry build; unverified rows have never been probed."
              >
                <TimeAgo at={s.last_verified_at} fallback="never verified" />
              </Provenance>
            ),
          },
        ]}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <PageSizeSelect value={search.limit} onChange={(n) => setSearch({ limit: n })} />
        <LoadMore
          shown={rows.length}
          total={total}
          hasMore={!!hasNextPage}
          isLoading={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          error={isFetchNextPageError ? (error as Error) : null}
          cursorInvalid={cursorInvalid}
        />
      </div>
    </div>
  );
}
