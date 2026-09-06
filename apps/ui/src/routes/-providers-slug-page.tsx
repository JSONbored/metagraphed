import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  BrandIcon,
  CopyableCode,
  DataTable,
  EntityHero,
  FactSentence,
  LoadMore,
  RankedRails,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { recordModifiedAt } from "@/lib/metagraphed/freshness";
import { formatAbsoluteTime, formatNumber } from "@/lib/metagraphed/format";
import {
  providerEndpointsQuery,
  providerQuery,
  surfacesInfiniteQuery,
} from "@/lib/metagraphed/queries";
import type { Endpoint } from "@/lib/metagraphed/types";
import {
  endpointRails,
  hostOf,
  initials,
  mergeSurfaceProbes,
  providerDetailFacts,
  providerSurfaces,
  publishedSurfaceCount,
  surfaceAuth,
  type ProviderSurfaceRow,
} from "@/components/metagraphed/providers/providers-logic";
import { Route } from "./providers.$slug";

const API_PATHS = [
  "/api/v1/providers/{slug}",
  "/api/v1/providers/{slug}/endpoints",
  "/api/v1/surfaces",
];

function ApiSources({ slug }: { slug: string }) {
  useRegisterApiSource(API_PATHS.map((path) => path.replace("{slug}", slug)));
  return null;
}

/** Provider identity and usable services, followed by independent probe diagnostics. */
export function ProviderDetail() {
  const { slug } = Route.useParams();
  const providerResult = useSuspenseQuery(providerQuery(slug));
  const provider = providerResult.data.data;
  const endpoints = useQuery({ ...providerEndpointsQuery(slug), retry: 0 });
  // Services are the primary reading and start independently of endpoint health.
  const surfaces = useInfiniteQuery({
    ...surfacesInfiniteQuery({ provider: slug, limit: 500 }),
    retry: 0,
  });

  // Memoised, not inlined: `?? []` builds a fresh array on every render and
  // the rail's useMemo below would recompute every time.
  const endpointList = useMemo(() => (endpoints.data?.data ?? []) as Endpoint[], [endpoints.data]);
  const surfaceList = useMemo(
    () => providerSurfaces((surfaces.data?.pages ?? []).flatMap((page) => page.data)),
    [surfaces.data],
  );
  const rails = useMemo(() => endpointRails(endpointList), [endpointList]);
  const mergedSurfaces = useMemo(
    () => mergeSurfaceProbes(surfaceList, endpointList),
    [surfaceList, endpointList],
  );
  const summary = provider?.endpoint_summary;
  const surfaceCount = publishedSurfaceCount(provider);
  const pagination = surfaces.data?.pages[0]?.meta?.pagination as { total?: unknown } | undefined;
  const total =
    typeof pagination?.total === "number" &&
    Number.isSafeInteger(pagination.total) &&
    pagination.total >= 0
      ? pagination.total
      : undefined;
  const cursorInvalid = surfaces.data?.pages.some((page) => page.cursorInvalid) ?? false;

  const host =
    (typeof provider?.website === "string" ? provider.website : null) ??
    (typeof provider?.homepage === "string" ? provider.homepage : null);

  /**
   * ONE column set over the merged list.
   *
   * The name leads and links to the surface; the probe columns are filled for
   * the surfaces the prober watches and em-dashed for the ones it does not.
   * Two tables of the same 156 rows became one (#11696).
   */
  const surfaceColumns: DataTableColumn<ProviderSurfaceRow>[] = [
    {
      key: "name",
      label: "Surface",
      kind: "link",
      width: 280,
      lead: true,
      value: (row) => row.name ?? hostOf(row.url) ?? null,
      href: (row) => row.url,
    },
    { key: "kind", label: "Kind", kind: "status", width: 140, value: (row) => row.kind ?? null },
    {
      key: "auth",
      label: "Auth",
      kind: "text",
      width: 100,
      value: (row) => surfaceAuth(row.auth_required),
    },
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 100,
      value: (row) => row.netuid ?? null,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    {
      key: "status",
      label: "Status",
      kind: "status",
      width: 110,
      value: (row) => row.probeStatus,
    },
    {
      key: "latency",
      label: "Latency",
      kind: "number",
      align: "right",
      width: 125,
      value: (row) => row.probeLatencyMs,
      format: (value) => (typeof value === "number" ? `${formatNumber(value)} ms` : "—"),
    },
    {
      key: "probed",
      label: "Last probe",
      kind: "time",
      width: 140,
      demote: true,
      value: (row) => row.probedAt,
    },
    {
      key: "authority",
      label: "Authority",
      demote: true,
      kind: "status",
      width: 150,
      value: (row) => (typeof row.authority === "string" ? row.authority : null),
    },
  ];

  const surfaceDetail = (row: ProviderSurfaceRow) => (
    <dl className="[&>.mg-raw-row]:grid-cols-1! [&>.mg-raw-row]:gap-1! sm:[&>.mg-raw-row]:grid-cols-[180px_minmax(0,1fr)]!">
      {row.url ? (
        <div className="mg-raw-row">
          <dt>URL</dt>
          <dd className="min-w-0">
            <CopyableCode
              value={row.url}
              label="service URL"
              truncate={false}
              className="min-h-11 [&>span:first-child]:sr-only"
            />
          </dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Auth</dt>
        <dd>{surfaceAuth(row.auth_required)}</dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last verified</dt>
        <dd>
          {row.last_verified_at
            ? formatAbsoluteTime(row.last_verified_at)
            : "no verification recorded"}
        </dd>
      </div>
    </dl>
  );

  const name = (typeof provider?.name === "string" && provider.name) || slug;
  const rawRows: RawRow[] = [
    { label: "slug", value: slug },
    ...API_PATHS.map((path) => {
      const resolved = path.replace("{slug}", slug);
      return {
        label: resolved.replace("/api/v1/", ""),
        value: `${API_BASE}${resolved}`,
        href: `${API_BASE}${resolved}`,
      };
    }),
  ];

  return (
    <AppShell>
      <ApiSources slug={slug} />
      <EntityHero
        className="mg-hero--entity"
        crumbs={[
          { label: "APIs", href: "/apis" },
          { label: "Providers", href: "/apis/providers" },
        ]}
        name={name}
        avatar={
          <BrandIcon
            iconUrl={typeof provider?.icon_url === "string" ? provider.icon_url : undefined}
            name={name}
            providerSlug={slug}
            fallback={initials(name)}
            size={40}
          />
        }
        action={
          host ? (
            <a href={host} className="mg-hero-action min-h-11" rel="noreferrer">
              Open host
            </a>
          ) : undefined
        }
        sentence={
          <FactSentence>
            {typeof provider?.kind === "string" ? provider.kind : "provider"} at{" "}
            {hostOf(host) ?? "no published host"}.
          </FactSentence>
        }
        // A STRIP, not chips (#11696). The sentence keeps the provider's
        // IDENTITY -- what kind of operator, at which host -- and the counts
        // move to cells, where a number that frames two tables is not set
        // smaller than the tables' own rows.
        cells={
          factCells(
            providerDetailFacts(provider, summary, surfaceCount, {
              count: formatNumber,
            }),
          ) ?? undefined
        }
        live={{
          updatedAt: recordModifiedAt(providerResult.data.meta) ?? null,
          source: "registry",
          onRefresh: () => {
            const reads: Promise<unknown>[] = [
              providerResult.refetch(),
              endpoints.refetch(),
              surfaces.refetch(),
            ];
            void Promise.all(reads);
          },
          refreshing: providerResult.isFetching || endpoints.isFetching || surfaces.isFetching,
        }}
      />

      <AnalyticsSection
        id="surfaces"
        name="Services"
        question="Registered interfaces, their access requirements and latest probe."
        visual={
          <>
            {providerResult.isRefetchError ? (
              <ErrorState
                error={providerResult.error}
                onRetry={() => void providerResult.refetch()}
                context="provider registry refresh"
              />
            ) : null}
            {endpoints.isError ? (
              <ErrorState
                error={endpoints.error}
                onRetry={() => void endpoints.refetch()}
                context="provider endpoint probes"
              />
            ) : null}
            {surfaces.isError && !surfaces.isFetchNextPageError ? (
              <ErrorState
                error={surfaces.error}
                onRetry={() => void surfaces.refetch()}
                context="provider surfaces"
              />
            ) : null}
            <DataTable
              id="surfaces"
              rows={mergedSurfaces}
              columns={surfaceColumns}
              rowKey={(row) => row.id}
              caption={`${name} surfaces`}
              link={RouterLink}
              source="provider-surface"
              storageKey="mg-provider-surfaces-columns"
              className="max-lg:[&_.mg-dt-expansion>td]:px-4! [&_td[data-mobile-lead=true]]:before:hidden [&_.mg-dt-status]:self-start [&_.mg-dt-disclosure]:min-h-11 [&_.mg-dt-disclosure]:min-w-11 [&_.mg-dt-menu-trigger]:min-h-11 [&_.mg-dt-menu-trigger]:min-w-11"
              mobile="cards"
              expand={surfaceDetail}
              loading={surfaces.isPending}
              paginate={false}
              empty={
                surfaces.isError
                  ? "Registered services are temporarily unavailable."
                  : "No surfaces are registered for this provider."
              }
            />
          </>
        }
        legend={
          surfaces.hasNextPage || surfaces.isFetchNextPageError || cursorInvalid ? (
            <div className="[&_button]:min-h-11">
              <LoadMore
                hasMore={surfaces.hasNextPage}
                isLoading={surfaces.isFetchingNextPage}
                onLoadMore={() => void surfaces.fetchNextPage()}
                shown={mergedSurfaces.length}
                total={total}
                error={surfaces.isFetchNextPageError ? surfaces.error : null}
                cursorInvalid={cursorInvalid}
              />
            </div>
          ) : undefined
        }
        footnote={
          surfaces.isPending
            ? "Loading registered services · registry"
            : `${formatNumber(mergedSurfaces.length)} services loaded${total == null ? "" : ` of ${formatNumber(total)} catalog results`} · registry` +
              (surfaces.isError
                ? " · service read failed; previously loaded rows remain visible"
                : "") +
              (endpoints.isPending
                ? " · probe readings loading"
                : endpoints.isError
                  ? " · probe readings unavailable"
                  : " · latest probes joined only where identity matches")
        }
      />

      <AnalyticsSection
        id="latency"
        name="Latency"
        question="How long each endpoint took on its last probe."
        visual={
          endpoints.isPending ? (
            <RankedRails
              items={[]}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "Latency", name: "Kind · host", track: "Last probe" }}
              ariaLabel={`${name} endpoint latency`}
              source="provider-latency"
              loading
              loadingRows={10}
            />
          ) : rails.length > 0 ? (
            <RankedRails
              items={rails}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "Latency", name: "Kind · host", track: "Last probe" }}
              ariaLabel={`${name} endpoint latency`}
              source="provider-latency"
            />
          ) : (
            <p className="text-13 text-ink-muted">
              No measured latency is available in the loaded probe records.
            </p>
          )
        }
        legend={
          endpoints.isError ? (
            <ErrorState
              error={endpoints.error}
              onRetry={() => void endpoints.refetch()}
              context="endpoint latency"
            />
          ) : undefined
        }
        // One probe, not a series: no per-endpoint history route exists, and a
        // "p50 over time" chart drawn from a single reading would be a line
        // between one point and itself.
        footnote={
          endpoints.isPending
            ? "Loading endpoint probe readings · probe-derived"
            : endpoints.isError
              ? "Endpoint probe readings are temporarily unavailable · probe-derived"
              : `${formatNumber(endpointList.length)} endpoint records loaded · latest probe per endpoint · up to 20 measured endpoints shown · probe-derived`
        }
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
