import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ProvidersSearch } from "./apis.providers";
import { useSuspenseQuery, useIsFetching } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { ProviderIndexDirectory } from "@/components/metagraphed/provider-index-directory";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { AsyncPanel, PanelSkeleton, QueryProgress } from "@/components/metagraphed/primitives";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ResetFiltersButton, SelectFilter } from "@/components/metagraphed/table-controls";
import {
  providersQuery,
  endpointsQuery,
  sourceHealthProvidersQuery,
  metagraphedQueryKey,
  type ProviderCounts,
} from "@/lib/metagraphed/queries";
import { classNames, isStaleFreshness } from "@/lib/metagraphed/format";
import { matchesQuery } from "@/lib/metagraphed/url-state";
import { matchesProviderAuthority } from "@/lib/metagraphed/providers-url-state";
import { BrandIcon, DataTable, prefetchBrandIcon, type SortState } from "@jsonbored/ui-kit";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { ProvidersPulseRail } from "@/components/metagraphed/providers-pulse-rail";
import type { Provider } from "@/lib/metagraphed/types";
import type { ProviderSortKey } from "./apis.providers";
import { providerSortKeys } from "./apis.providers";
import { ApisTabActions } from "./-apis-hub";
import { cancelIdle, requestIdle } from "@/lib/metagraphed/idle";

export function ProvidersPage() {
  const search = useSearch({ from: "/apis/providers" }) as ProvidersSearch;
  const navigate = useNavigate({ from: "/apis/providers" });
  const filtersActive = Boolean(
    search.q || search.kind || search.authority || (search.sort && search.sort !== "name"),
  );
  const onReset = () => navigate({ search: {}, replace: true });
  return (
    <>
      <ApisTabActions>
        <div className="mg-actions">
          <ResetFiltersButton active={filtersActive} onReset={onReset} bare />
        </div>
      </ApisTabActions>
      <AsyncPanel
        height="sm"
        context="providers pulse"
        retryQueryKeys={[metagraphedQueryKey("providers")]}
      >
        <ProvidersPulseRailLoader />
      </AsyncPanel>
      <AsyncPanel
        context="providers"
        fallback={<Skeleton className="h-80 w-full" />}
        retryQueryKeys={[
          metagraphedQueryKey("providers"),
          metagraphedQueryKey("source-health-providers"),
        ]}
      >
        <ProvidersTable />
      </AsyncPanel>
      {/* #11204: the list above renders every provider into the server-rendered
          HTML (`paginate={false}`), so no provider page is left without an
          internal link. This alphabetical directory is the second entry point —
          see the component for why it is not a duplicate of the table. */}
      <AsyncPanel
        context="provider index"
        fallback={<PanelSkeleton height="sm" className="mt-8" />}
        retryQueryKeys={[metagraphedQueryKey("providers")]}
      >
        <ProviderIndexDirectory />
      </AsyncPanel>
      <ApiSourceFooter
        paths={["/api/v1/providers", "/api/v1/source-health"]}
        artifacts={["/metagraph/providers.json"]}
      />
      {/* #11320: below the data on purpose -- see hub-prose.tsx. */}
      <HubSections path="/apis/providers" />
    </>
  );
}

function maskHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? null;
  }
}

function authorityTone(a?: string): string {
  switch (a) {
    case "official":
      return "border-curation-verified/40 bg-curation-verified/10 text-curation-verified";
    case "provider-claimed":
      return "border-curation-pilot/40 bg-curation-pilot/10 text-curation-pilot";
    case "community":
      return "border-curation-machine/40 bg-curation-machine/10 text-curation-machine";
    default:
      return "border-border bg-paper text-ink-muted";
  }
}

function ProvidersTable() {
  const search = useSearch({ from: "/apis/providers" }) as ProvidersSearch;
  const navigate = useNavigate({ from: "/apis/providers" });
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    });

  const { data: providersRes } = useSuspenseQuery(providersQuery());
  const rows = useMemo(() => (providersRes.data ?? []) as Provider[], [providersRes]);
  // The /api/v1/providers list already carries per-provider tallies
  // (endpoint_count / surface_count / subnet_count, normalized to the *_count
  // fields). Derive the counts map from those rows instead of re-fetching the
  // full surfaces + endpoints collections — the server computes these the same
  // way, so the rendered numbers are identical.
  const counts = useMemo<Record<string, ProviderCounts>>(() => {
    const out: Record<string, ProviderCounts> = {};
    for (const p of rows) {
      if (!p.slug) continue;
      out[p.slug] = {
        surfaces: p.surfaces_count ?? 0,
        endpoints: p.endpoints_count ?? 0,
        subnets: (p.subnet_count as number | undefined) ?? 0,
      };
    }
    return out;
  }, [rows]);
  const generatedAt = providersRes.meta?.generated_at;
  const stale = isStaleFreshness(generatedAt);

  const q = search.q;
  const kind = search.kind;
  const authority = search.authority;
  const sortKey: ProviderSortKey = search.sort ?? "name";

  const kinds = useMemo(
    () => Array.from(new Set(rows.map((p) => p.kind).filter(Boolean) as string[])).sort(),
    [rows],
  );
  const authorities = useMemo(
    () => Array.from(new Set(rows.map((p) => p.authority).filter(Boolean) as string[])).sort(),
    [rows],
  );

  const authorityOptions = useMemo(() => {
    const fromRows = authorities.filter((a) => a !== "high");
    return ["high", ...fromRows];
  }, [authorities]);

  const filtered = useMemo(() => {
    return rows.filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (!matchesProviderAuthority(p, authority)) return false;
      const host = maskHost(p.website ?? p.homepage) ?? "";
      return matchesQuery([p.name, p.slug, p.notes, host], q);
    });
  }, [rows, q, kind, authority]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortKey === "name")
        return String(a.name ?? a.slug).localeCompare(String(b.name ?? b.slug));
      if (sortKey === "updated") {
        const ta = String(a.updated_at ?? "");
        const tb = String(b.updated_at ?? "");
        return tb.localeCompare(ta);
      }
      const ca = counts[a.slug];
      const cb = counts[b.slug];
      const va = (ca?.[sortKey] as number | undefined) ?? 0;
      const vb = (cb?.[sortKey] as number | undefined) ?? 0;
      return vb - va;
    });
    return arr;
  }, [filtered, sortKey, counts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = requestIdle(() => {
      for (const p of sorted)
        prefetchBrandIcon(p.website ?? p.homepage, 36, {
          iconUrl: p.icon_url,
          repoUrl: p.repo,
          lookup: { providerSlug: p.slug },
        });
    });
    return () => cancelIdle(handle);
  }, [sorted]);

  // Hooks must run unconditionally before the early return below.
  const isFetchingProviders = useIsFetching({ queryKey: metagraphedQueryKey("providers") }) > 0;

  if (rows.length === 0)
    return (
      <EmptyState
        title="No providers tracked yet"
        description="Once provider entries are registered, they'll be listed here."
        action={{ label: "Browse all endpoints", href: "/apis/endpoints" }}
      />
    );

  const hasFilters = Boolean(q || kind || authority || (sortKey && sortKey !== "name"));

  // The route's sort is a bare key with no direction: names read A→Z and every
  // tally reads high→low. `sorted` above is already in that order, so the table
  // is handed rows it must not re-sort — passing `onSort` is what tells it so.
  const sortState: SortState = { key: sortKey, dir: sortKey === "name" ? "asc" : "desc" };
  const onSort = (next: SortState | null) =>
    setSearch({
      sort: (next && (providerSortKeys as readonly string[]).includes(next.key)
        ? next.key
        : "name") as ProviderSortKey,
    });

  return (
    <div className="space-y-3">
      {stale ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[providersQuery().queryKey, endpointsQuery({ limit: 1000 }).queryKey]}
        />
      ) : null}

      <SourceHealthRollup />

      <QueryProgress active={isFetchingProviders} position="sticky" />

      {/* `paginate={false}`: every provider ships in the server-rendered HTML,
          which is what tests/e2e/crawlable-subnet-index.spec.ts asserts. */}
      <DataTable
        rows={sorted}
        rowKey={(p) => p.slug}
        caption="Provider directory"
        source="providers"
        storageKey="providers"
        link={RouterLink}
        rowHref={(p) => `/providers/${encodeURIComponent(p.slug)}`}
        paginate={false}
        sort={sortState}
        onSort={onSort}
        search={{
          value: q,
          onChange: (value) => setSearch({ q: value }),
          placeholder: "Search providers, slugs, hosts…",
        }}
        filters={
          <>
            <SelectFilter
              label="Kind"
              value={kind}
              onChange={(v) => setSearch({ kind: v })}
              options={kinds.map((value) => ({ value, label: value }))}
            />
            <SelectFilter
              label="Authority"
              value={authority}
              onChange={(v) => setSearch({ authority: v })}
              options={authorityOptions.map((value) => ({
                value,
                label: value === "high" ? "Official + claimed" : value,
              }))}
            />
            <ResetFiltersButton
              active={hasFilters}
              onReset={() => setSearch({ q: "", kind: "", authority: "", sort: "name" })}
              bare
            />
          </>
        }
        empty={
          <EmptyState
            title="No providers match this filter"
            description="Try clearing filters or adjusting your search."
            action={{ label: "Browse all endpoints", href: "/apis/endpoints" }}
          />
        }
        columns={[
          {
            key: "name",
            label: "Provider",
            sortable: true,
            value: (p) => p.name ?? p.slug,
            render: (p) => (
              <span className="inline-flex min-w-0 items-center gap-2">
                <BrandIcon
                  url={p.website ?? p.homepage}
                  iconUrl={p.icon_url}
                  repoUrl={p.repo}
                  providerSlug={p.slug}
                  name={p.name ?? p.slug}
                  fallback={p.slug}
                  size={20}
                />
                {p.authority === "official" ? (
                  // #6423: see hero-subnet-chips -- role="img" so the
                  // colour-only badge announces its meaning. `mg-dot` is the
                  // one round element the design system allows, and it paints
                  // itself from `currentColor`.
                  <span role="img" aria-label="Official provider" className="mg-dot text-accent" />
                ) : null}
                <span className="truncate text-ink-strong">{p.name ?? p.slug}</span>
                <span className="truncate text-10 text-ink-muted">{p.slug}</span>
              </span>
            ),
          },
          { key: "kind", label: "Kind", sortable: true, value: (p) => p.kind ?? null },
          {
            key: "authority",
            label: "Authority",
            sortable: true,
            value: (p) => p.authority ?? null,
            render: (p) =>
              p.authority ? (
                <span
                  className={classNames(
                    "text-13 rounded border px-1.5 py-0.5",
                    authorityTone(p.authority),
                  )}
                >
                  {p.authority}
                </span>
              ) : (
                <span className="text-ink-muted">—</span>
              ),
          },
          {
            key: "host",
            label: "Host",
            sortable: true,
            value: (p) => maskHost(p.website ?? p.homepage),
          },
          {
            key: "subnets",
            label: "Subnets",
            kind: "number",
            sortable: true,
            value: (p) => counts[p.slug]?.subnets ?? 0,
          },
          {
            key: "surfaces",
            label: "Surfaces",
            kind: "number",
            sortable: true,
            value: (p) => counts[p.slug]?.surfaces ?? 0,
          },
          {
            key: "endpoints",
            label: "Endpoints",
            kind: "number",
            sortable: true,
            value: (p) => counts[p.slug]?.endpoints ?? 0,
          },
          {
            key: "updated",
            label: "Updated",
            kind: "time",
            sortable: true,
            align: "right",
            value: (p) => (typeof p.updated_at === "string" ? p.updated_at : null),
          },
        ]}
      />
    </div>
  );
}

// #3353: compact source-health status-mix rollup for the /providers page — the
// summary-level companion to the full sortable provider table on /status, from
// the same /api/v1/source-health query already wired for that page. Suspends
// within the ProvidersGrid boundary alongside ProviderOverview.
function SourceHealthRollup() {
  const summary = useSuspenseQuery(sourceHealthProvidersQuery()).data.data.summary;
  const status = summary.status_counts;
  return (
    <Panel
      className="mt-3"
      bodyClassName="flex flex-wrap items-center gap-4 font-mono text-13 tabular-nums"
    >
      <span className="text-10 text-ink-muted">Source health</span>
      <span className="text-health-ok">{status.ok ?? 0} ok</span>
      <span className="text-health-warn">{status.degraded ?? 0} degraded</span>
      <span className="text-health-down">{status.failed ?? 0} failed</span>
      <span className="text-ink-muted">{status.unknown ?? 0} unknown</span>
      <span className="ml-auto text-ink-muted">
        {summary.provider_count ?? 0} providers · {summary.endpoint_count ?? 0} endpoints
      </span>
    </Panel>
  );
}

function ProvidersPulseRailLoader() {
  const { data } = useSuspenseQuery(providersQuery());
  const providers = (data.data ?? []) as Provider[];
  return <ProvidersPulseRail providers={providers} />;
}
