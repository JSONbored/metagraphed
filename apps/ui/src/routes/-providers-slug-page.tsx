import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  BrandIcon,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  RankedRails,
  Raw,
  type DataTableColumn,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  providerEndpointsQuery,
  providerQuery,
  surfacesInfiniteQuery,
} from "@/lib/metagraphed/queries";
import type { Endpoint, Surface } from "@/lib/metagraphed/types";
import {
  endpointRails,
  hostOf,
  initials,
  providerDetailFacts,
  providerSurfaces,
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
  const provider = useSuspenseQuery(providerQuery(slug)).data.data;
  const endpoints = useQuery({ ...providerEndpointsQuery(slug), retry: 0 });
  // The provider's surfaces, server-filtered: /api/v1/surfaces takes
  // `provider`, so this asks for one provider's rows rather than paging the
  // 3,391-row catalogue and discarding 99% of it.
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
  const summary = provider?.endpoint_summary;

  const host =
    (typeof provider?.website === "string" ? provider.website : null) ??
    (typeof provider?.homepage === "string" ? provider.homepage : null);

  const endpointColumns: DataTableColumn<Endpoint>[] = [
    { key: "kind", label: "Kind", kind: "status", width: 150, value: (row) => row.kind ?? null },
    {
      key: "url",
      label: "URL",
      kind: "link",
      value: (row) => row.url ?? null,
      href: (row) => row.url,
      format: (value) => (typeof value === "string" ? value.replace(/^https?:\/\//, "") : "—"),
    },
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 110,
      value: (row) => (typeof row.netuid === "number" ? (row.netuid as number) : null),
      href: (row) =>
        typeof row.netuid === "number" ? `/subnets/${row.netuid as number}` : undefined,
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    {
      key: "status",
      label: "Status",
      kind: "status",
      width: 120,
      value: (row) => (typeof row.status === "string" ? row.status : null),
    },
    {
      key: "latency",
      label: "p50",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => (typeof row.latency_ms === "number" ? row.latency_ms : null),
      format: (value) => (typeof value === "number" ? `${formatNumber(value)} ms` : "—"),
    },
    {
      key: "probed",
      label: "Last probe",
      kind: "time",
      width: 130,
      value: (row) => (typeof row.last_checked === "string" ? row.last_checked : null),
    },
    {
      key: "ok",
      label: "Last ok",
      kind: "time",
      width: 130,
      demote: true,
      value: (row) => (typeof row.last_ok === "string" ? row.last_ok : null),
    },
  ];

  const surfaceColumns: DataTableColumn<Surface>[] = [
    {
      key: "subnet",
      label: "Subnet",
      kind: "link",
      width: 110,
      value: (row) => row.netuid ?? null,
      href: (row) => (row.netuid == null ? undefined : `/subnets/${row.netuid}`),
      format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
    },
    { key: "kind", label: "Kind", kind: "status", width: 150, value: (row) => row.kind ?? null },
    { key: "name", label: "Name", value: (row) => row.name ?? null },
    {
      key: "url",
      label: "URL",
      kind: "link",
      value: (row) => row.url ?? null,
      href: (row) => row.url,
      format: (value) => (typeof value === "string" ? value.replace(/^https?:\/\//, "") : "—"),
    },
    {
      key: "authority",
      label: "Authority",
      kind: "status",
      width: 170,
      value: (row) => (typeof row.authority === "string" ? row.authority : null),
    },
    {
      key: "verified",
      label: "Last verified",
      kind: "time",
      width: 130,
      demote: true,
      value: (row) => row.last_verified_at ?? null,
    },
  ];

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
            {hostOf(host) ?? "no published host"}.{" "}
            {providerDetailFacts(provider, summary, surfaceList.length, {
              count: formatNumber,
            }).map((fact) => (
              <Fact key={fact.key}>
                {fact.label} {fact.value}
              </Fact>
            ))}
          </FactSentence>
        }
        live={{
          updatedAt: (provider?.generated_at as string | undefined) ?? null,
          source: "registry",
        }}
      />

      <AnalyticsSection
        id="latency"
        name="Latency"
        question="How long each endpoint took on its last probe."
        visual={
          rails.length > 0 ? (
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
        footnote="most recent probe · measured endpoints only · probe-derived"
      />

      <AnalyticsSection
        id="endpoints"
        name="Endpoints"
        question="Everything this provider runs, and how it answered."
        visual={
          <DataTable
            id="endpoints"
            rows={endpointList}
            columns={endpointColumns}
            rowKey={(row) => row.id}
            caption={`${name} endpoints`}
            link={RouterLink}
            source="provider-endpoint"
            loading={endpoints.isPending}
            paginate={false}
            empty="No endpoints are registered for this provider."
          />
        }
        footnote={
          summary?.by_status
            ? Object.entries(summary.by_status)
                .map(([status, n]) => `${formatNumber(n)} ${status}`)
                .join(" · ") + " · probe-derived"
            : "probe-derived"
        }
      />

      <AnalyticsSection
        id="surfaces"
        name="Surfaces"
        question="What this provider publishes, per subnet."
        visual={
          <DataTable
            id="surfaces"
            rows={surfaceList}
            columns={surfaceColumns}
            rowKey={(row) => row.id}
            caption={`${name} surfaces`}
            link={RouterLink}
            source="provider-surface"
            loading={surfaces.isPending}
            paginate={false}
            empty="No surfaces are registered for this provider."
          />
        }
        footnote={`${formatNumber(surfaceList.length)} surfaces · registry`}
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}
