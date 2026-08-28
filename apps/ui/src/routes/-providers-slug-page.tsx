import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  BrandIcon,
  DataTable,
  EntityHero,
  FactSentence,
  RankedRails,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { factCells } from "@/lib/metagraphed/facts";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
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

/**
 * One provider (#11624) — hero, three sections, `Raw`.
 *
 * What went: a five-section page behind a `TabStrip`, and the tab param with
 * it. The tabs were Endpoints, Surfaces and three panels of the same counts
 * the hero now carries.
 *
 * The issue asked for a 90-day uptime rail and a p50 series over time.
 * Neither is published: /api/v1/providers/{slug}/endpoints carries ONE probe
 * per endpoint -- `latency_ms`, `status`, `last_checked`, `last_ok` -- and no
 * history route exists for either reading. The Latency section ranks that one
 * probe and says which probe it is; the Health section states the status split
 * the summary does publish, next to the endpoints it describes.
 */
export function ProviderDetail() {
  const { slug } = Route.useParams();
  const providerResult = useSuspenseQuery(providerQuery(slug));
  const provider = providerResult.data.data;
  const endpoints = useQuery({ ...providerEndpointsQuery(slug), retry: 0 });
  const { ref: surfacesRef, nearViewport: surfacesNearViewport } = useNearViewport("0px 0px");
  // The provider's surfaces, server-filtered: /api/v1/surfaces takes
  // `provider`, so this asks for one provider's rows rather than paging the
  // 3,391-row catalogue and discarding 99% of it. It is still a potentially
  // large table, though, and the published provider record already carries
  // the count the hero needs. Start this evidence only as its section comes
  // into view, rather than making it compete with the identity and latency
  // reading on a cold route.
  const surfaces = useInfiniteQuery({
    ...surfacesInfiniteQuery({ provider: slug, limit: 500 }),
    enabled: surfacesNearViewport,
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
  const surfaceCount =
    surfaceList.length > 0
      ? surfaceList.length
      : typeof provider?.surfaces_count === "number"
        ? provider.surfaces_count
        : 0;

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
      width: 340,
      value: (row) => row.name ?? hostOf(row.url) ?? null,
      href: (row) => row.url,
    },
    { key: "kind", label: "Kind", kind: "status", width: 140, value: (row) => row.kind ?? null },
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
      label: "p50",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => row.probeLatencyMs,
      format: (value) => (typeof value === "number" ? `${formatNumber(value)} ms` : "—"),
    },
    { key: "probed", label: "Last probe", kind: "time", width: 120, value: (row) => row.probedAt },
    {
      key: "authority",
      label: "Authority",
      kind: "status",
      width: 150,
      value: (row) => (typeof row.authority === "string" ? row.authority : null),
    },
  ];

  const surfaceDetail = (row: ProviderSurfaceRow) => (
    <dl>
      {row.url ? (
        <div className="mg-raw-row">
          <dt>URL</dt>
          <dd>{row.url}</dd>
        </div>
      ) : null}
      <div className="mg-raw-row">
        <dt>Auth</dt>
        <dd>
          {row.auth_required == null ? "—" : row.auth_required ? "a key is required" : "open"}
        </dd>
      </div>
      <div className="mg-raw-row">
        <dt>Last verified</dt>
        <dd>{row.last_verified_at ? formatAbsoluteTime(row.last_verified_at) : "not verified"}</dd>
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
            <a href={host} className="mg-hero-action" rel="noreferrer">
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
          updatedAt: (provider?.generated_at as string | undefined) ?? null,
          source: "registry",
          onRefresh: () => {
            const reads: Promise<unknown>[] = [providerResult.refetch(), endpoints.refetch()];
            if (surfacesNearViewport) reads.push(surfaces.refetch());
            void Promise.all(reads);
          },
          refreshing: providerResult.isFetching || endpoints.isFetching || surfaces.isFetching,
        }}
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
              columns={{ value: "p50", name: "Kind · host", track: "Last probe" }}
              ariaLabel={`${name} endpoint latency`}
              source="provider-latency"
              loading
              loadingRows={10}
            />
          ) : endpoints.isError ? (
            <ErrorState
              error={endpoints.error}
              onRetry={() => void endpoints.refetch()}
              context="endpoint latency"
            />
          ) : rails.length > 0 ? (
            <RankedRails
              items={rails}
              formatValue={(value: number) => `${formatNumber(value)} ms`}
              scale="sqrt"
              columns={{ value: "p50", name: "Kind · host", track: "Last probe" }}
              ariaLabel={`${name} endpoint latency`}
              source="provider-latency"
            />
          ) : null
        }
        // One probe, not a series: no per-endpoint history route exists, and a
        // "p50 over time" chart drawn from a single reading would be a line
        // between one point and itself.
        footnote={
          endpoints.isPending
            ? "Loading endpoint probe readings · probe-derived"
            : endpoints.isError
              ? "Endpoint probe readings are temporarily unavailable · probe-derived"
              : "most recent probe · measured endpoints only · probe-derived"
        }
      />

      <AnalyticsSection
        id="surfaces"
        name="Surfaces"
        question="Everything this provider publishes, and how it answered."
        visualRef={surfacesRef}
        visual={
          !surfacesNearViewport ? (
            <p className="mg-section-empty">Surface evidence loads as this section approaches.</p>
          ) : surfaces.isError ? (
            <ErrorState
              error={surfaces.error}
              onRetry={() => void surfaces.refetch()}
              context="provider surfaces"
            />
          ) : (
            <>
              {endpoints.isError ? (
                <ErrorState
                  error={endpoints.error}
                  onRetry={() => void endpoints.refetch()}
                  context="provider endpoint probes"
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
                expand={surfaceDetail}
                loading={surfaces.isPending || endpoints.isPending}
                paginate={false}
                empty="No surfaces are registered for this provider."
              />
            </>
          )
        }
        footnote={
          !surfacesNearViewport
            ? "deferred below the fold · provider surfaces load as this section approaches"
            : surfaces.isPending || endpoints.isPending
              ? "Loading provider surfaces and probe records · registry"
              : surfaces.isError
                ? "Provider surfaces are temporarily unavailable · registry"
                : endpoints.isError
                  ? "Endpoint probe readings are temporarily unavailable · probe-derived"
                  : summary?.by_status
                    ? `${formatNumber(mergedSurfaces.length)} surfaces · ` +
                      Object.entries(summary.by_status)
                        .map(([status, n]) => `${formatNumber(n)} ${status}`)
                        .join(" · ") +
                      " · probe-derived"
                    : `${formatNumber(mergedSurfaces.length)} surfaces · registry`
        }
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
