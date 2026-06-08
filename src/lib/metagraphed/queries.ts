import { queryOptions } from "@tanstack/react-query";
import { apiFetch, type QueryParams } from "./client";
import type {
  AdapterSnapshot,
  Candidate,
  Coverage,
  Endpoint,
  EndpointIncident,
  EvidenceItem,
  Freshness,
  Gap,
  HealthSummary,
  Provider,
  RpcPool,
  SchemaInfo,
  Subnet,
  SubnetProfile,
  Surface,
} from "./types";

const STALE_SHORT = 30_000;
const STALE_MED = 60_000;
const STALE_LONG = 5 * 60_000;

const k = (...parts: unknown[]) => ["metagraphed", ...parts];

export const coverageQuery = () =>
  queryOptions({
    queryKey: k("coverage"),
    queryFn: ({ signal }) => apiFetch<Coverage>("/api/v1/coverage", { signal }),
    staleTime: STALE_MED,
  });

export const freshnessQuery = () =>
  queryOptions({
    queryKey: k("freshness"),
    queryFn: ({ signal }) => apiFetch<Freshness>("/api/v1/freshness", { signal }),
    staleTime: STALE_SHORT,
  });

export const healthQuery = () =>
  queryOptions({
    queryKey: k("health"),
    queryFn: ({ signal }) => apiFetch<HealthSummary>("/api/v1/health", { signal }),
    staleTime: STALE_SHORT,
  });

export const sourceHealthQuery = () =>
  queryOptions({
    queryKey: k("source-health"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ name: string; ok?: boolean; last_seen?: string }>>(
        "/api/v1/source-health",
        { signal },
      ),
    staleTime: STALE_MED,
  });

export const subnetsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("subnets", params ?? {}),
    queryFn: ({ signal }) => apiFetch<Subnet[]>("/api/v1/subnets", { signal, params }),
    staleTime: STALE_MED,
  });

export const subnetQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet", netuid),
    queryFn: ({ signal }) => apiFetch<Subnet>(`/api/v1/subnets/${netuid}`, { signal }),
    staleTime: STALE_MED,
  });

export const subnetProfileQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-profile", netuid),
    queryFn: ({ signal }) =>
      apiFetch<SubnetProfile>(`/api/v1/subnets/${netuid}/profile`, { signal }),
    staleTime: STALE_MED,
  });

export const subnetSurfacesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-surfaces", netuid),
    queryFn: ({ signal }) =>
      apiFetch<Surface[]>(`/api/v1/subnets/${netuid}/surfaces`, { signal }),
    staleTime: STALE_MED,
  });

export const subnetEndpointsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-endpoints", netuid),
    queryFn: ({ signal }) =>
      apiFetch<Endpoint[]>(`/api/v1/subnets/${netuid}/endpoints`, { signal }),
    staleTime: STALE_MED,
  });

export const subnetHealthQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-health", netuid),
    queryFn: ({ signal }) =>
      apiFetch<HealthSummary>(`/api/v1/subnets/${netuid}/health`, { signal }),
    staleTime: STALE_SHORT,
  });

export const subnetCandidatesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-candidates", netuid),
    queryFn: ({ signal }) =>
      apiFetch<Candidate[]>(`/api/v1/subnets/${netuid}/candidates`, { signal }),
    staleTime: STALE_LONG,
  });

export const surfacesQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("surfaces", params ?? {}),
    queryFn: ({ signal }) => apiFetch<Surface[]>("/api/v1/surfaces", { signal, params }),
    staleTime: STALE_MED,
  });

export const endpointsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("endpoints", params ?? {}),
    queryFn: ({ signal }) => apiFetch<Endpoint[]>("/api/v1/endpoints", { signal, params }),
    staleTime: STALE_MED,
  });

export const rpcEndpointsQuery = () =>
  queryOptions({
    queryKey: k("rpc-endpoints"),
    queryFn: ({ signal }) => apiFetch<Endpoint[]>("/api/v1/rpc/endpoints", { signal }),
    staleTime: STALE_MED,
  });

export const rpcPoolsQuery = () =>
  queryOptions({
    queryKey: k("rpc-pools"),
    queryFn: ({ signal }) => apiFetch<RpcPool[]>("/api/v1/rpc/pools", { signal }),
    staleTime: STALE_MED,
  });

export const endpointPoolsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-pools"),
    queryFn: ({ signal }) => apiFetch<RpcPool[]>("/api/v1/endpoint-pools", { signal }),
    staleTime: STALE_MED,
  });

export const endpointIncidentsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-incidents"),
    queryFn: ({ signal }) =>
      apiFetch<EndpointIncident[]>("/api/v1/endpoint-incidents", { signal }),
    staleTime: STALE_SHORT,
  });

export const providersQuery = () =>
  queryOptions({
    queryKey: k("providers"),
    queryFn: ({ signal }) => apiFetch<Provider[]>("/api/v1/providers", { signal }),
    staleTime: STALE_MED,
  });

export const providerQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider", slug),
    queryFn: ({ signal }) => apiFetch<Provider>(`/api/v1/providers/${slug}`, { signal }),
    staleTime: STALE_MED,
  });

export const providerEndpointsQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider-endpoints", slug),
    queryFn: ({ signal }) =>
      apiFetch<Endpoint[]>(`/api/v1/providers/${slug}/endpoints`, { signal }),
    staleTime: STALE_MED,
  });

export const gapsQuery = () =>
  queryOptions({
    queryKey: k("gaps"),
    queryFn: ({ signal }) => apiFetch<Gap[]>("/api/v1/gaps", { signal }),
    staleTime: STALE_LONG,
  });

export const reviewProfileCompletenessQuery = () =>
  queryOptions({
    queryKey: k("review-profile-completeness"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ netuid: number; completeness: number; missing?: string[] }>>(
        "/api/v1/review/profile-completeness",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const reviewAdapterCandidatesQuery = () =>
  queryOptions({
    queryKey: k("review-adapter-candidates"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ netuid: number; reason?: string; score?: number }>>(
        "/api/v1/review/adapter-candidates",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const reviewEnrichmentQueueQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-queue"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ id: string; netuid?: number; priority?: string; note?: string }>>(
        "/api/v1/review/enrichment-queue",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const schemasQuery = () =>
  queryOptions({
    queryKey: k("schemas"),
    queryFn: ({ signal }) => apiFetch<SchemaInfo[]>("/api/v1/schemas", { signal }),
    staleTime: STALE_MED,
  });

export const contractsQuery = () =>
  queryOptions({
    queryKey: k("contracts"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ id: string; name?: string; version?: string; url?: string }>>(
        "/api/v1/contracts",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const evidenceQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("evidence", params ?? {}),
    queryFn: ({ signal }) =>
      apiFetch<EvidenceItem[]>("/api/v1/evidence", { signal, params }),
    staleTime: STALE_LONG,
  });

export const changelogQuery = () =>
  queryOptions({
    queryKey: k("changelog"),
    queryFn: ({ signal }) =>
      apiFetch<Array<{ id: string; at?: string; title?: string; kind?: string }>>(
        "/api/v1/changelog",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const buildQuery = () =>
  queryOptions({
    queryKey: k("build"),
    queryFn: ({ signal }) =>
      apiFetch<{ version?: string; built_at?: string; features?: Record<string, boolean> }>(
        "/api/v1/build",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const adapterQuery = (slug: string) =>
  queryOptions({
    queryKey: k("adapter", slug),
    queryFn: ({ signal }) =>
      apiFetch<AdapterSnapshot>(`/api/v1/adapters/${slug}`, { signal }),
    staleTime: STALE_MED,
  });
