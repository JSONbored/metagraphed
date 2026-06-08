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

export const subnetsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("subnets", params ?? {}),
    queryFn: ({ signal }) => fetchList<Subnet>("/api/v1/subnets", "subnets", params, signal),
    staleTime: STALE_MED,
  });

export const subnetQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet", netuid),
    queryFn: ({ signal }) => fetchDetail<Subnet>(`/api/v1/subnets/${netuid}`, "subnet", signal),
    staleTime: STALE_MED,
  });

export const subnetProfileQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-profile", netuid),
    queryFn: ({ signal }) =>
      fetchDetail<SubnetProfile>(`/api/v1/subnets/${netuid}/profile`, "profile", signal),
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
    queryFn: ({ signal }) =>
      fetchList<Endpoint>(`/api/v1/subnets/${netuid}/endpoints`, "endpoints", undefined, signal),
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
    queryFn: ({ pageParam, signal }) =>
      fetchInfinitePage<Subnet>("/api/v1/subnets", "subnets", baseParams, pageParam as string, signal),
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

export const endpointsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("endpoints", params ?? {}),
    queryFn: ({ signal }) =>
      fetchList<Endpoint>("/api/v1/endpoints", "endpoints", params, signal),
    staleTime: STALE_MED,
  });

export const rpcEndpointsQuery = () =>
  queryOptions({
    queryKey: k("rpc-endpoints"),
    queryFn: ({ signal }) =>
      fetchList<Endpoint>("/api/v1/rpc/endpoints", "endpoints", undefined, signal),
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
    queryFn: ({ signal }) =>
      fetchList<EndpointIncident>("/api/v1/endpoint-incidents", "incidents", undefined, signal),
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
    queryFn: ({ signal }) =>
      fetchList<Endpoint>(`/api/v1/providers/${slug}/endpoints`, "endpoints", undefined, signal),
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
