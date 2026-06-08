import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { apiFetch, type ApiResult, type QueryParams } from "./client";
import type {
  AdapterSnapshot,
  Candidate,
  Coverage,
  Endpoint,
  EndpointIncident,
  EvidenceItem,
  Freshness,
  Gap,
  HealthState,
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

/**
 * Normalize a list response. The API wraps lists as
 *   { ok, data: { <collection>: T[] }, meta }.
 * We tolerate both the wrapped form and a raw array.
 */
async function fetchList<T>(
  path: string,
  key: string,
  params?: QueryParams,
  signal?: AbortSignal,
): Promise<ApiResult<T[]>> {
  const res = await apiFetch<unknown>(path, { params, signal });
  const raw = res.data as unknown;
  let arr: T[] = [];
  if (Array.isArray(raw)) {
    arr = raw as T[];
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidate = obj[key];
    if (Array.isArray(candidate)) arr = candidate as T[];
    else {
      // Fallback: pick the first array-valued property.
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) {
          arr = v as T[];
          break;
        }
      }
    }
  }
  return { data: arr, meta: res.meta, url: res.url };
}

/** Fetch detail and pick a known key, falling back to the whole payload. */
async function fetchDetail<T>(
  path: string,
  key: string,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const res = await apiFetch<unknown>(path, { signal });
  const raw = res.data as unknown;
  if (raw && typeof raw === "object" && key in (raw as object)) {
    return { data: (raw as Record<string, unknown>)[key] as T, meta: res.meta, url: res.url };
  }
  return { data: raw as T, meta: res.meta, url: res.url };
}

export const coverageQuery = () =>
  queryOptions({
    queryKey: k("coverage"),
    queryFn: ({ signal }) => apiFetch<Coverage>("/api/v1/coverage", { signal }),
    staleTime: STALE_MED,
  });

export const freshnessQuery = () =>
  queryOptions({
    queryKey: k("freshness"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/freshness", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const sourcesRaw = (d.sources as Array<Record<string, unknown>> | undefined) ?? [];
      const now = Date.now();
      const ages: number[] = [];
      let stale = 0;
      const sources = sourcesRaw.map((s) => {
        const ts = (s.as_of as string) || (s.timestamp as string) || null;
        const ageSec = ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000)) : null;
        if (ageSec != null) ages.push(ageSec);
        const staleAfterH = Number(s.stale_after_hours);
        const isStale =
          (typeof s.stale === "boolean" ? (s.stale as boolean) : false) ||
          (ageSec != null && Number.isFinite(staleAfterH) && ageSec > staleAfterH * 3600) ||
          s.status === "stale" ||
          s.status === "expired";
        if (isStale) stale += 1;
        return {
          name: (s.id as string) || (s.name as string) || "source",
          last_seen: ts ?? undefined,
          stale: isStale,
        };
      });
      const merged: Freshness = {
        avg_age_seconds: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : undefined,
        max_age_seconds: ages.length ? Math.max(...ages) : undefined,
        stale_count: stale,
        sources,
        ...summary,
      };
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function normalizeHealthBlock(d: Record<string, unknown>): HealthSummary {
  const sc = (d.status_counts as Record<string, number> | undefined) ?? undefined;
  const cc = (d.classification_counts as Record<string, number> | undefined) ?? undefined;
  const ok = (d.ok_count as number | undefined) ?? sc?.ok ?? (d.ok as number | undefined);
  const warn =
    (d.degraded_count as number | undefined) ?? sc?.degraded ?? (d.warn as number | undefined);
  const down =
    (d.failed_count as number | undefined) ?? sc?.failed ?? (d.down as number | undefined);
  const unknown =
    (d.unknown_count as number | undefined) ??
    sc?.unknown ??
    cc?.unsupported ??
    (d.unknown as number | undefined);
  const total =
    (d.surface_count as number | undefined) ??
    (d.total as number | undefined) ??
    [ok, warn, down, unknown].reduce<number | undefined>(
      (acc, v) => (typeof v === "number" ? (acc ?? 0) + v : acc),
      undefined,
    );
  const uptime =
    (d.uptime_24h as number | undefined) ??
    (typeof ok === "number" && typeof total === "number" && total > 0 ? ok / total : undefined);
  return {
    ok,
    warn,
    down,
    unknown,
    total,
    uptime_24h: uptime,
    generated_at: d.generated_at as string | undefined,
    ...d,
  } as HealthSummary;
}

export const healthQuery = () =>
  queryOptions({
    queryKey: k("health"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const global = (d.global as Record<string, unknown> | undefined) ?? {};
      const merged = normalizeHealthBlock({ ...d, ...global });
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

export const sourceHealthQuery = () =>
  queryOptions({
    queryKey: k("source-health"),
    queryFn: async ({ signal }) => {
      // Use freshness.sources — the real per-source health/freshness signal.
      // (/api/v1/source-health returns providers, surfaced on /providers.)
      const res = await apiFetch<Record<string, unknown>>("/api/v1/freshness", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const sourcesRaw = (d.sources as Array<Record<string, unknown>> | undefined) ?? [];
      const now = Date.now();
      const rows = sourcesRaw.map((s) => {
        const ts = (s.as_of as string) || (s.timestamp as string) || null;
        const ageSec = ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000)) : null;
        const staleAfterH = Number(s.stale_after_hours);
        const isStale =
          (typeof s.stale === "boolean" ? (s.stale as boolean) : false) ||
          (ageSec != null && Number.isFinite(staleAfterH) && ageSec > staleAfterH * 3600) ||
          s.status === "stale" ||
          s.status === "expired";
        const captured = s.status === "captured" || s.status === "ok";
        return {
          name: (s.id as string) || (s.name as string) || "source",
          ok: captured ? true : isStale ? false : undefined,
          last_seen: ts ?? undefined,
        } as { name: string; ok?: boolean; last_seen?: string };
      });
      return { data: rows, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function normalizeSubnet(raw: unknown): Subnet {
  if (!raw || typeof raw !== "object") return raw as Subnet;
  const s = raw as Record<string, unknown>;
  const statusToHealth = (v: unknown): HealthState | undefined => {
    if (typeof v !== "string") return undefined;
    if (v === "ok") return "ok";
    if (v === "degraded" || v === "warn") return "warn";
    if (v === "failed" || v === "down") return "down";
    return "unknown";
  };
  return {
    ...(s as object),
    netuid: s.netuid as number,
    name: (s.name as string) ?? (s.native_name as string),
    type: (s.subnet_type as Subnet["type"]) ?? (s.type as Subnet["type"]),
    participants: (s.participants as number) ?? (s.participant_count as number),
    surfaces_count: (s.surfaces_count as number) ?? (s.surface_count as number),
    candidates_count: (s.candidates_count as number) ?? (s.candidate_count as number),
    health: (s.health as HealthState) ?? statusToHealth(s.status),
    updated_at:
      (s.updated_at as string) ??
      (s.last_checked as string) ??
      (s.last_ok as string),
  } as Subnet;
}

export const subnetsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("subnets", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/subnets", "subnets", params, signal);
      return { ...res, data: res.data.map(normalizeSubnet) } as ApiResult<Subnet[]>;
    },
    staleTime: STALE_MED,
  });

export const subnetQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchDetail<unknown>(`/api/v1/subnets/${netuid}`, "subnet", signal);
      return { ...res, data: normalizeSubnet(res.data) } as ApiResult<Subnet>;
    },
    staleTime: STALE_MED,
  });

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function normalizeSubnetProfile(raw: unknown, netuid: number): SubnetProfile {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const profile = (root.profile as Record<string, unknown> | undefined) ?? {};
  const subnet = (root.subnet as Record<string, unknown> | undefined) ?? {};
  const links = (profile.primary_links as Record<string, unknown> | undefined) ?? {};
  const completenessObj = profile.completeness as Record<string, unknown> | undefined;
  const score =
    (typeof completenessObj?.score === "number" ? (completenessObj.score as number) : undefined) ??
    (typeof profile.completeness_score === "number"
      ? (profile.completeness_score as number)
      : undefined);
  const completenessRatio =
    typeof score === "number" ? Math.max(0, Math.min(1, score / 100)) : undefined;
  const curation = (subnet.curation as Record<string, unknown> | undefined) ?? {};
  const gaps = (subnet.gaps as Record<string, unknown> | undefined) ??
    (root.gaps as Record<string, unknown> | undefined) ?? {};

  const website = pickStr(links.website_url, links.website, subnet.website_url);
  const docs = pickStr(links.docs_url, links.docs, subnet.docs_url);
  const repo = pickStr(links.source_repo, links.repo, subnet.source_repo);
  const dashboard = pickStr(links.dashboard_url, links.dashboard, subnet.dashboard_url);

  const status = statusToHealth((subnet.status as string) ?? (profile.status as string));

  return {
    netuid: (subnet.netuid as number) ?? (profile.netuid as number) ?? netuid,
    name: pickStr(profile.name, subnet.name, subnet.native_name, profile.native_name),
    slug: pickStr(profile.slug, subnet.slug, subnet.native_slug),
    native_name: pickStr(subnet.native_name, profile.native_name),
    symbol: pickStr(subnet.symbol),
    description: pickStr(subnet.notes, profile.notes),
    notes: pickStr(subnet.notes, profile.notes),
    subnet_type: pickStr(subnet.subnet_type, profile.subnet_type),
    categories: (profile.categories as string[]) ?? (subnet.categories as string[]) ?? [],
    block: subnet.block as number | undefined,
    registered_at_block: subnet.registered_at_block as number | undefined,
    tempo: subnet.tempo as number | undefined,
    participants: (subnet.participant_count as number) ?? (subnet.participants as number),
    mechanism_count: subnet.mechanism_count as number | undefined,
    // links
    website,
    homepage: website,
    docs,
    repo,
    dashboard,
    primary_links: { website, docs, repo, dashboard },
    // curation
    curation_level: (profile.curation_level as CurationLevel) ??
      (subnet.curation_level as CurationLevel) ??
      ((curation.level as CurationLevel) || undefined),
    coverage_level: subnet.coverage_level as SubnetProfile["coverage_level"],
    review_state: pickStr(profile.review_state, curation.review_state as string),
    reviewed_at: pickStr(curation.reviewed_at as string),
    confidence: pickStr(profile.confidence as string),
    completeness: completenessRatio,
    completeness_score: score,
    // counts
    surface_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    surfaces_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    endpoint_count: (profile.endpoint_count as number) ?? (subnet.probed_surface_count as number),
    candidate_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    candidates_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    monitored_endpoint_count: profile.monitored_endpoint_count as number | undefined,
    operational_interface_kinds:
      (profile.operational_interface_kinds as string[]) ?? [],
    supported_interface_kinds:
      (profile.supported_interface_kinds as string[]) ??
      (gaps.supported_kinds as string[]) ??
      [],
    missing_kinds: (gaps.missing_kinds as string[]) ?? (profile.missing_operational as string[]) ?? [],
    gap_notes: (gaps.gap_notes as string[]) ?? [],
    primary_app_surface: profile.primary_app_surface as PrimaryAppSurface | undefined,
    // embedded
    surfaces: (root.surfaces as Surface[]) ?? [],
    endpoints: (root.endpoints as Endpoint[]) ?? [],
    candidate_surfaces: (root.candidate_surfaces as Candidate[]) ?? [],
    health: status,
  } as SubnetProfile;
}

export const subnetProfileQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-profile", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/profile`, { signal });
      return {
        data: normalizeSubnetProfile(res.data, netuid),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetProfile>;
    },
    staleTime: STALE_MED,
  });

export const subnetSurfacesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-surfaces", netuid),
    queryFn: ({ signal }) =>
      fetchList<Surface>(`/api/v1/subnets/${netuid}/surfaces`, "surfaces", undefined, signal),
    staleTime: STALE_MED,
  });

export const subnetEndpointsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-endpoints", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/endpoints`,
        "endpoints",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

export const subnetHealthQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-health", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/subnets/${netuid}/health`, { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const merged = normalizeHealthBlock({ ...d, ...summary });
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

export const subnetCandidatesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-candidates", netuid),
    queryFn: ({ signal }) =>
      fetchList<Candidate>(`/api/v1/subnets/${netuid}/candidates`, "candidates", undefined, signal),
    staleTime: STALE_LONG,
  });

export const surfacesQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("surfaces", params ?? {}),
    queryFn: ({ signal }) => fetchList<Surface>("/api/v1/surfaces", "surfaces", params, signal),
    staleTime: STALE_MED,
  });

/**
 * Strict next-cursor extractor. The API has historically returned cursors as
 * strings or numbers; defend against bad shapes (objects, booleans, NaN,
 * empty strings) and against echoes of the cursor we just sent (a common
 * server bug that would cause an infinite "load more" loop).
 *
 * Returns:
 *   { cursor: string } — valid, fetch can continue
 *   { cursor: null }   — explicit end of list
 *   { invalid: true }  — API returned something but we can't trust it
 */
function validateNextCursor(
  meta: ApiResult<unknown>["meta"],
  sentCursor: string | undefined,
): { cursor: string | null; invalid?: boolean } {
  const p = (meta?.pagination ?? {}) as { next_cursor?: unknown };
  const raw = p.next_cursor ?? (meta as Record<string, unknown> | undefined)?.next_cursor;
  if (raw === undefined || raw === null) return { cursor: null };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { cursor: null };
    if (sentCursor && trimmed === sentCursor) {
      if (import.meta.env?.DEV)
        console.warn("[metagraphed] next_cursor echoes sent cursor; stopping pagination");
      return { cursor: null, invalid: true };
    }
    return { cursor: trimmed };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const s = String(raw);
    if (sentCursor && s === sentCursor) return { cursor: null, invalid: true };
    return { cursor: s };
  }
  if (import.meta.env?.DEV)
    console.warn("[metagraphed] next_cursor has unexpected shape:", raw);
  return { cursor: null, invalid: true };
}

/** Pages on the infinite query carry the validation flag for the UI. */
type InfinitePage<T> = ApiResult<T[]> & { cursorInvalid?: boolean };

async function fetchInfinitePage<T>(
  path: string,
  key: string,
  baseParams: QueryParams,
  pageParam: string,
  signal?: AbortSignal,
): Promise<InfinitePage<T>> {
  const params: QueryParams = { ...baseParams };
  if (pageParam) params.cursor = pageParam;
  const res = await fetchList<T>(path, key, params, signal);
  const v = validateNextCursor(res.meta, pageParam || undefined);
  // Stash the validated cursor in meta so getNextPageParam can read it
  // without re-running validation.
  const meta = { ...(res.meta ?? {}), _next_cursor: v.cursor };
  return { ...res, meta, cursorInvalid: v.invalid };
}

/** Server-driven cursor-paginated subnets. */
export const subnetsInfiniteQuery = (
  baseParams: QueryParams = {},
  initialCursor = "",
) =>
  infiniteQueryOptions({
    queryKey: k("subnets-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchInfinitePage<unknown>(
        "/api/v1/subnets",
        "subnets",
        baseParams,
        pageParam as string,
        signal,
      );
      return { ...page, data: page.data.map(normalizeSubnet) } as typeof page;
    },
    getNextPageParam: (last) => {
      const nc = (last.meta as Record<string, unknown>)?._next_cursor as string | null | undefined;
      return nc ?? undefined;
    },
    staleTime: STALE_MED,
  });

/** Server-driven cursor-paginated surfaces. */
export const surfacesInfiniteQuery = (
  baseParams: QueryParams = {},
  initialCursor = "",
) =>
  infiniteQueryOptions({
    queryKey: k("surfaces-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: ({ pageParam, signal }) =>
      fetchInfinitePage<Surface>("/api/v1/surfaces", "surfaces", baseParams, pageParam as string, signal),
    getNextPageParam: (last) => {
      const nc = (last.meta as Record<string, unknown>)?._next_cursor as string | null | undefined;
      return nc ?? undefined;
    },
    staleTime: STALE_MED,
  });

function statusToHealth(v: unknown): HealthState | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "ok" || v === "live") return "ok";
  if (v === "degraded" || v === "warn" || v === "redirected" || v === "transient")
    return "warn";
  if (v === "failed" || v === "down" || v === "unsupported") return "down";
  return "unknown";
}

function normalizeEndpoint(raw: unknown): Endpoint {
  if (!raw || typeof raw !== "object") return raw as Endpoint;
  const e = raw as Record<string, unknown>;
  return {
    ...(e as object),
    id: e.id as string,
    health: (e.health as HealthState) ?? statusToHealth(e.status) ?? "unknown",
    provider_slug:
      (e.provider_slug as string) ?? (e.provider as string) ?? (e.operator as string),
    last_probed_at:
      (e.last_probed_at as string) ??
      (e.last_checked as string) ??
      (e.observed_at as string),
  } as Endpoint;
}

function normalizeIncident(raw: unknown): EndpointIncident {
  if (!raw || typeof raw !== "object") return raw as EndpointIncident;
  const i = raw as Record<string, unknown>;
  // API uses state="active" and a separate status="failed|degraded|ok".
  // For the UI pill we want a HealthState derived from status/severity.
  const sev = i.severity as string | undefined;
  const sevHealth: HealthState | undefined =
    sev === "critical" ? "down" : sev === "warning" ? "warn" : undefined;
  const stateHealth = statusToHealth(i.status) ?? sevHealth ?? "unknown";
  const ended = i.state === "resolved" || i.resolved_at;
  return {
    ...(i as object),
    id: i.id as string,
    state: stateHealth,
    message: (i.message as string) ?? (i.reason as string),
    started_at:
      (i.started_at as string) ??
      (i.detected_at as string) ??
      (i.observed_at as string),
    ended_at:
      (i.ended_at as string | null | undefined) ??
      (i.resolved_at as string | null | undefined) ??
      (ended ? (i.last_checked as string) : null),
  } as EndpointIncident;
}

export const endpointsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("endpoints", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/endpoints", "endpoints", params, signal);
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

export const rpcEndpointsQuery = () =>
  queryOptions({
    queryKey: k("rpc-endpoints"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/rpc/endpoints", "endpoints", undefined, signal);
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

export const rpcPoolsQuery = () =>
  queryOptions({
    queryKey: k("rpc-pools"),
    queryFn: ({ signal }) => fetchList<RpcPool>("/api/v1/rpc/pools", "pools", undefined, signal),
    staleTime: STALE_MED,
  });

export const endpointPoolsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-pools"),
    queryFn: ({ signal }) =>
      fetchList<RpcPool>("/api/v1/endpoint-pools", "pools", undefined, signal),
    staleTime: STALE_MED,
  });

export const endpointIncidentsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-incidents"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        "/api/v1/endpoint-incidents",
        "incidents",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeIncident) } as ApiResult<EndpointIncident[]>;
    },
    staleTime: STALE_SHORT,
  });

export const providersQuery = () =>
  queryOptions({
    queryKey: k("providers"),
    queryFn: ({ signal }) =>
      fetchList<Provider>("/api/v1/providers", "providers", undefined, signal),
    staleTime: STALE_MED,
  });

export const providerQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider", slug),
    queryFn: ({ signal }) => fetchDetail<Provider>(`/api/v1/providers/${slug}`, "provider", signal),
    staleTime: STALE_MED,
  });

export const providerEndpointsQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider-endpoints", slug),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/providers/${slug}/endpoints`,
        "endpoints",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

export const gapsQuery = () =>
  queryOptions({
    queryKey: k("gaps"),
    queryFn: ({ signal }) => fetchList<Gap>("/api/v1/gaps", "gaps", undefined, signal),
    staleTime: STALE_LONG,
  });

export const reviewProfileCompletenessQuery = () =>
  queryOptions({
    queryKey: k("review-profile-completeness"),
    queryFn: ({ signal }) =>
      fetchList<{ netuid: number; completeness: number; missing?: string[] }>(
        "/api/v1/review/profile-completeness",
        "profiles",
        undefined,
        signal,
      ),
    staleTime: STALE_LONG,
  });

export const reviewAdapterCandidatesQuery = () =>
  queryOptions({
    queryKey: k("review-adapter-candidates"),
    queryFn: ({ signal }) =>
      fetchList<{ netuid: number; reason?: string; score?: number }>(
        "/api/v1/review/adapter-candidates",
        "candidates",
        undefined,
        signal,
      ),
    staleTime: STALE_LONG,
  });

export const reviewEnrichmentQueueQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-queue"),
    queryFn: ({ signal }) =>
      fetchList<{ id: string; netuid?: number; priority?: string; note?: string }>(
        "/api/v1/review/enrichment-queue",
        "queue",
        undefined,
        signal,
      ),
    staleTime: STALE_LONG,
  });

export const schemasQuery = () =>
  queryOptions({
    queryKey: k("schemas"),
    queryFn: ({ signal }) =>
      fetchList<SchemaInfo>("/api/v1/schemas", "schemas", undefined, signal),
    staleTime: STALE_MED,
  });

export const contractsQuery = () =>
  queryOptions({
    queryKey: k("contracts"),
    queryFn: ({ signal }) =>
      fetchList<{ id: string; name?: string; version?: string; url?: string }>(
        "/api/v1/contracts",
        "contracts",
        undefined,
        signal,
      ),
    staleTime: STALE_LONG,
  });

export const evidenceQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("evidence", params ?? {}),
    queryFn: ({ signal }) =>
      fetchList<EvidenceItem>("/api/v1/evidence", "evidence", params, signal),
    staleTime: STALE_LONG,
  });

export const changelogQuery = () =>
  queryOptions({
    queryKey: k("changelog"),
    queryFn: ({ signal }) =>
      fetchList<{ id: string; at?: string; title?: string; kind?: string }>(
        "/api/v1/changelog",
        "entries",
        undefined,
        signal,
      ),
    staleTime: STALE_LONG,
  });

export const searchQuery = (q: string, limit = 20) =>
  queryOptions({
    queryKey: k("search", q, limit),
    queryFn: ({ signal }) =>
      fetchList<{ id: string; kind?: string; title?: string; url?: string }>(
        "/api/v1/search",
        "documents",
        { q, limit },
        signal,
      ),
    enabled: q.trim().length > 0,
    staleTime: STALE_SHORT,
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
