import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { apiFetch, type ApiResult, type QueryParams } from "./client";
import { getNetwork } from "./config";
import type {
  AdapterSnapshot,
  AgentResource,
  AgentResources,
  Candidate,
  Coverage,
  CurationLevel,
  Endpoint,
  EndpointIncident,
  EvidenceItem,
  FlatSurfaceIncident,
  Fixture,
  FixtureIndexEntry,
  Freshness,
  Gap,
  GlobalIncident,
  GlobalIncidents,
  GlobalIncidentSurface,
  HealthState,
  HealthSummary,
  HealthTrends,
  HealthTrendSurface,
  HealthTrendWindow,
  LeaderboardBoardKey,
  LeaderboardRow,
  Leaderboards,
  Lineage,
  LineageLink,
  PrimaryAppSurface,
  ReadinessSummary,
  Provider,
  ProviderEndpointSummary,
  RpcPool,
  RpcUsage,
  SchemaInfo,
  Subnet,
  SubnetEconomics,
  SubnetOverview,
  SubnetProfile,
  Surface,
  SurfaceLatencyPercentiles,
  SurfaceSla,
  Trajectory,
  TrajectoryDelta,
  TrajectoryPoint,
  ReliabilityGrade,
  SurfaceUptime,
  SurfaceUptimeDay,
  Uptime,
} from "./types";

const STALE_SHORT = 30_000;
const STALE_MED = 60_000;
const STALE_LONG = 5 * 60_000;

const MAX_TRAJECTORY_POINTS = 104;
const MAX_UPTIME_SURFACES = 500;
const MAX_UPTIME_DAYS = 366;
const MAX_HEALTH_TREND_SURFACES = 500;

function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Include the selected chain network so SSR mainnet data cannot hydrate into a testnet view. */
export const metagraphedQueryKey = (...parts: unknown[]) => [
  "metagraphed",
  { network: getNetwork().id },
  ...parts,
];

const k = metagraphedQueryKey;

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeEconomicsSubnets(value: unknown): SubnetEconomics[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item)) return [];

    const netuid = optionalNumber(item.netuid);
    if (netuid == null) return [];

    return [
      {
        ...item,
        netuid,
        name: optionalString(item.name),
        slug: optionalString(item.slug),
        emission_share: optionalNumber(item.emission_share),
        alpha_price_tao: optionalNumber(item.alpha_price_tao),
        validator_count: optionalNumber(item.validator_count),
        max_validators: optionalNumber(item.max_validators),
        miner_count: optionalNumber(item.miner_count),
        max_uids: optionalNumber(item.max_uids),
        total_stake_tao: optionalNumber(item.total_stake_tao),
        max_stake_tao: optionalNumber(item.max_stake_tao),
        subnet_volume_tao: optionalNumber(item.subnet_volume_tao),
        registration_cost_tao: optionalNumber(item.registration_cost_tao),
        registration_allowed: booleanValue(item.registration_allowed),
      } satisfies SubnetEconomics,
    ];
  });
}

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

interface NormalizedFreshnessSource {
  name: string;
  last_seen?: string;
  stale: boolean;
  captured: boolean;
}

function freshnessSourceRecords(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (source): source is Record<string, unknown> =>
      !!source && typeof source === "object" && !Array.isArray(source),
  );
}

function finiteTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeReliabilityGrade(raw: unknown): ReliabilityGrade | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return {
    score: coerceFiniteNumber(raw.score),
    grade: coerceString(raw.grade),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    avg_latency_ms: coerceFiniteNumber(raw.avg_latency_ms),
    sample_count: coerceFiniteNumber(raw.sample_count),
    surface_count: coerceFiniteNumber(raw.surface_count),
  };
}

function normalizeTrajectoryDelta(raw: unknown): TrajectoryDelta | null {
  if (!isPlainRecord(raw)) return null;
  return {
    from_date: coerceString(raw.from_date),
    to_date: coerceString(raw.to_date),
    completeness_score: coerceFiniteNumber(raw.completeness_score),
    surface_count: coerceFiniteNumber(raw.surface_count),
    endpoint_count: coerceFiniteNumber(raw.endpoint_count),
  };
}

function normalizeTrajectoryPoint(raw: unknown): TrajectoryPoint | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return {
    date: coerceString(raw.date) ?? "",
    completeness_score: coerceFiniteNumber(raw.completeness_score),
    surface_count: coerceFiniteNumber(raw.surface_count),
    endpoint_count: coerceFiniteNumber(raw.endpoint_count),
  };
}

function normalizeTrajectory(raw: Partial<Trajectory> | undefined): Trajectory {
  const d = isPlainRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_TRAJECTORY_POINTS).flatMap((point) => {
        const normalized = normalizeTrajectoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  const deltas = isPlainRecord(d.deltas)
    ? Object.fromEntries(
        Object.entries(d.deltas).map(([window, delta]) => [
          window,
          normalizeTrajectoryDelta(delta),
        ]),
      )
    : undefined;
  return {
    ...(d as object),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
    deltas,
  };
}

function normalizeUptimeDay(raw: unknown): SurfaceUptimeDay | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return {
    day: coerceString(raw.day) ?? "",
    samples: coerceFiniteNumber(raw.samples),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    avg_latency_ms: coerceFiniteNumber(raw.avg_latency_ms),
    status: coerceString(raw.status),
  };
}

function normalizeSurfaceUptime(raw: unknown): SurfaceUptime | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const surfaceId = coerceString(raw.surface_id);
  if (!surfaceId) return undefined;
  const days = Array.isArray(raw.days)
    ? raw.days.slice(-MAX_UPTIME_DAYS).flatMap((day) => {
        const normalized = normalizeUptimeDay(day);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(raw as object),
    surface_id: surfaceId,
    day_count: coerceFiniteNumber(raw.day_count) ?? days.length,
    samples: coerceFiniteNumber(raw.samples),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    reliability: normalizeReliabilityGrade(raw.reliability),
    days,
  };
}

function normalizeUptime(raw: Partial<Uptime> | undefined): Uptime {
  const d = isPlainRecord(raw) ? raw : {};
  const surfaces = Array.isArray(d.surfaces)
    ? d.surfaces.slice(0, MAX_UPTIME_SURFACES).flatMap((surface) => {
        const normalized = normalizeSurfaceUptime(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    window: coerceString(d.window),
    reliability: normalizeReliabilityGrade(d.reliability),
    surfaces,
  };
}

function normalizeFreshnessSources(raw: unknown, now = Date.now()) {
  let staleCount = 0;
  let ageTotal = 0;
  let ageCount = 0;
  let maxAgeSeconds: number | undefined;

  const sources = freshnessSourceRecords(raw).map<NormalizedFreshnessSource>((s) => {
    const ts = finiteTimestamp(s.as_of) ?? finiteTimestamp(s.timestamp);
    const ageSec =
      ts !== undefined ? Math.max(0, Math.round((now - Date.parse(ts)) / 1000)) : undefined;

    if (ageSec !== undefined) {
      ageTotal += ageSec;
      ageCount += 1;
      maxAgeSeconds = maxAgeSeconds === undefined ? ageSec : Math.max(maxAgeSeconds, ageSec);
    }

    const staleAfterH = Number(s.stale_after_hours);
    const isStale =
      (typeof s.stale === "boolean" ? s.stale : false) ||
      (ageSec !== undefined && Number.isFinite(staleAfterH) && ageSec > staleAfterH * 3600) ||
      s.status === "stale" ||
      s.status === "expired";
    if (isStale) staleCount += 1;

    return {
      name: (s.id as string) || (s.name as string) || "source",
      last_seen: ts,
      stale: isStale,
      captured: s.status === "captured" || s.status === "ok",
    };
  });

  return {
    avgAgeSeconds: ageCount ? ageTotal / ageCount : undefined,
    maxAgeSeconds,
    staleCount,
    sources,
  };
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

// The backend /api/v1/coverage uses chain-accurate field names; the UI's KPI
// tiles read friendlier aliases. Map the real fields onto the names the
// components expect (keeping the raw fields via spread). manifested_count is
// currently always 0, so fall through to the first-party surface count for the
// "manifested surfaces" tile rather than render a bare 0.
function normalizeCoverage(raw: unknown): Coverage {
  const d = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string) =>
    typeof d[key] === "number" && Number.isFinite(d[key]) ? d[key] : undefined;
  const manifestedCount = num("manifested_count");
  return {
    ...(d as object),
    netuids_total: num("netuids_total") ?? num("chain_subnet_count"),
    netuids_active: num("netuids_active") ?? num("application_subnet_count") ?? num("probed_count"),
    adapter_backed: num("adapter_backed") ?? num("first_party_subnet_count"),
    manifested:
      num("manifested") ??
      (manifestedCount === 0 ? undefined : manifestedCount) ??
      num("official_surface_count"),
    surfaces_total: num("surfaces_total") ?? num("official_surface_count") ?? num("surface_count"),
  } as Coverage;
}

export const coverageQuery = () =>
  queryOptions({
    queryKey: k("coverage"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/coverage", { signal });
      return { data: normalizeCoverage(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeLineageLink(value: unknown): LineageLink | null {
  if (!isRecord(value)) return null;
  const { mainnet_netuid: mainnetNetuid, testnet_netuid: testnetNetuid } = value;
  if (typeof mainnetNetuid !== "number" || typeof testnetNetuid !== "number") return null;

  return {
    mainnet_netuid: mainnetNetuid,
    mainnet_name: optionalString(value.mainnet_name),
    mainnet_slug: optionalString(value.mainnet_slug),
    testnet_netuid: testnetNetuid,
    testnet_name: optionalString(value.testnet_name),
    testnet_slug: optionalString(value.testnet_slug),
    matched_by: optionalString(value.matched_by),
  };
}

function normalizeLineage(data: Partial<Lineage> | undefined): Lineage {
  const d = isRecord(data) ? data : {};
  const links = Array.isArray(d.links)
    ? d.links.flatMap((link) => {
        const normalized = normalizeLineageLink(link);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    source_network: typeof d.source_network === "string" ? d.source_network : "source",
    target_network: typeof d.target_network === "string" ? d.target_network : "target",
    link_count: typeof d.link_count === "number" ? d.link_count : links.length,
    graduated_subnet_count:
      typeof d.graduated_subnet_count === "number" ? d.graduated_subnet_count : 0,
    testnet_only_count: typeof d.testnet_only_count === "number" ? d.testnet_only_count : 0,
    broken_link_count: typeof d.broken_link_count === "number" ? d.broken_link_count : 0,
    links,
  };
}

export const lineageQuery = () =>
  queryOptions({
    queryKey: k("lineage"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Lineage>>("/api/v1/lineage", { signal });
      return { data: normalizeLineage(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_LONG,
  });

// #1112: per-subnet on-chain economics. One artifact carries all subnets, so
// fetch once (shared cache) and the consumer finds its netuid.
export const economicsQuery = () =>
  queryOptions({
    queryKey: k("economics"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ subnets?: unknown }>("/api/v1/economics", {
        signal,
      });
      return { data: normalizeEconomicsSubnets(res.data?.subnets), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

const LEADERBOARD_BOARD_KEYS: LeaderboardBoardKey[] = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
];

function normalizeLeaderboardRow(raw: unknown): LeaderboardRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.netuid !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    netuid: r.netuid,
    slug: str(r.slug),
    name: str(r.name),
    uptime_ratio: num(r.uptime_ratio),
    surfaces_ok: num(r.surfaces_ok),
    surfaces_total: num(r.surfaces_total),
    avg_latency_ms: num(r.avg_latency_ms),
    latency_ms: num(r.latency_ms),
    completeness_score: num(r.completeness_score),
    surface_count: num(r.surface_count),
    operational_interface_count: num(r.operational_interface_count),
    completeness_delta: num(r.completeness_delta),
  };
}

function normalizeLeaderboards(raw: unknown): Leaderboards {
  const boards = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as Leaderboards;
  for (const key of LEADERBOARD_BOARD_KEYS) {
    const rows = Array.isArray(boards[key]) ? (boards[key] as unknown[]) : [];
    out[key] = rows
      .map(normalizeLeaderboardRow)
      .filter((row): row is LeaderboardRow => row !== null);
  }
  return out;
}

// #1111: registry leaderboards — five live, D1-computed boards (healthiest,
// fastest-rpc, most-complete, most-enriched, fastest-growing). One artifact carries
// all boards; the homepage discovery module renders the top rows of each.
export const leaderboardsQuery = () =>
  queryOptions({
    queryKey: k("registry-leaderboards"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ boards?: unknown }>("/api/v1/registry/leaderboards", {
        signal,
      });
      return { data: normalizeLeaderboards(res.data?.boards), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

export const freshnessQuery = () =>
  queryOptions({
    queryKey: k("freshness"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/freshness", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const { sources: _summarySources, ...summaryWithoutSources } = summary;
      const normalized = normalizeFreshnessSources(d.sources);
      const merged: Freshness = {
        avg_age_seconds: normalized.avgAgeSeconds,
        max_age_seconds: normalized.maxAgeSeconds,
        stale_count: normalized.staleCount,
        sources: normalized.sources.map(({ name, last_seen, stale }) => ({
          name,
          last_seen,
          stale,
        })),
        ...summaryWithoutSources,
      };
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function normalizeHealthBlock(d: Record<string, unknown>): HealthSummary {
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const sc = (d.status_counts as Record<string, unknown> | undefined) ?? undefined;
  const cc = (d.classification_counts as Record<string, unknown> | undefined) ?? undefined;
  const ok = num(d.ok_count) ?? num(sc?.ok) ?? num(d.ok);
  const warn = num(d.degraded_count) ?? num(sc?.degraded) ?? num(d.warn);
  const down = num(d.failed_count) ?? num(sc?.failed) ?? num(d.down);
  const unknown =
    num(d.unknown_count) ?? num(sc?.unknown) ?? num(cc?.unsupported) ?? num(d.unknown);
  const total =
    num(d.surface_count) ??
    num(d.total) ??
    [ok, warn, down, unknown].reduce<number | undefined>(
      (acc, v) => (typeof v === "number" ? (acc ?? 0) + v : acc),
      undefined,
    );
  const uptime =
    num(d.uptime_24h) ??
    (typeof ok === "number" && typeof total === "number" && total > 0 ? ok / total : undefined);
  return {
    ...d,
    ok,
    warn,
    down,
    unknown,
    total,
    uptime_24h: uptime,
    generated_at: typeof d.generated_at === "string" ? d.generated_at : undefined,
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

// Per-subnet probe health, keyed by netuid. The /api/v1/subnets LIST rows carry
// only chain `status` ("active"), never probe health or last_checked — that
// lives in /api/v1/health `data.subnets[]` (one entry per probed subnet). The
// subnets table joins this map in so the Health + Updated columns (and the
// health filter) resolve; subnets with no probed surfaces have no entry and stay
// "unknown" (correct — there is nothing to probe).
export type SubnetHealthEntry = { health: HealthState; last_checked?: string };

export const subnetHealthMapQuery = () =>
  queryOptions({
    queryKey: k("subnet-health-map"),
    queryFn: async ({ signal }) => {
      const empty = { data: {} as Record<number, SubnetHealthEntry> };
      try {
        const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
        const d = isPlainRecord(res.data) ? res.data : {};
        const subnets = Array.isArray(d.subnets) ? d.subnets : [];
        const map: Record<number, SubnetHealthEntry> = {};
        for (const sn of subnets) {
          if (!isPlainRecord(sn)) continue;
          const netuid = sn.netuid;
          if (typeof netuid !== "number") continue;
          map[netuid] = {
            health: statusToHealth(sn.status) ?? "unknown",
            last_checked:
              typeof sn.last_checked === "string"
                ? sn.last_checked
                : typeof sn.last_ok === "string"
                  ? sn.last_ok
                  : undefined,
          };
        }
        return { data: map, meta: res.meta, url: res.url };
      } catch {
        return empty;
      }
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
      const rows = normalizeFreshnessSources(d.sources).sources.map((source) => {
        return {
          name: source.name,
          ok: source.captured ? true : source.stale ? false : undefined,
          last_seen: source.last_seen,
        } as { name: string; ok?: boolean; last_seen?: string };
      });
      return { data: rows, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function normalizeSubnet(raw: unknown): Subnet {
  if (!raw || typeof raw !== "object") return raw as Subnet;
  const s = raw as Record<string, unknown>;
  return {
    ...(s as object),
    netuid: firstFiniteNumber(s.netuid) ?? (s.netuid as number),
    name: firstString(s.name, s.native_name),
    type: firstString(s.subnet_type, s.type) as Subnet["type"] | undefined,
    participants: firstFiniteNumber(s.participants, s.participant_count),
    surfaces_count: firstFiniteNumber(s.surfaces_count, s.surface_count),
    candidates_count: firstFiniteNumber(s.candidates_count, s.candidate_count),
    // chain `status` is "active" → "unknown" here; the real probe health is
    // joined from /api/v1/health in the table. Default to "unknown" (never
    // undefined) so the health filter matches unprobed rows.
    health: statusToHealth(s.health) ?? statusToHealth(s.status) ?? "unknown",
    icon_url: firstString(s.icon_url, s.logo_url),
    // API key is website_url; the BrandIcon favicon fallback reads `website`.
    website: firstString(s.website, s.website_url),
    updated_at: firstString(s.updated_at, s.last_checked, s.last_ok),
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

const READINESS_COMPONENT_KEYS = [
  "has_callable_api",
  "callable_now",
  "documented",
  "auth_clarity",
  "profile_complete",
  "active_lifecycle",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeReadiness(raw: unknown): ReadinessSummary | undefined {
  if (!isPlainObject(raw)) return undefined;

  const componentsRaw = raw.components;
  let components: Record<string, boolean> | undefined;

  if (isPlainObject(componentsRaw)) {
    const normalizedComponents: Record<string, boolean> = {};
    for (const key of READINESS_COMPONENT_KEYS) {
      if (typeof componentsRaw[key] === "boolean") {
        normalizedComponents[key] = componentsRaw[key];
      }
    }
    if (Object.keys(normalizedComponents).length > 0) {
      components = normalizedComponents;
    }
  }

  const readiness: ReadinessSummary = {};
  if (typeof raw.score === "number") readiness.score = raw.score;
  if (typeof raw.readiness_version === "number")
    readiness.readiness_version = raw.readiness_version;
  if (components) readiness.components = components;

  return Object.keys(readiness).length > 0 ? readiness : undefined;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

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
  const gaps =
    (subnet.gaps as Record<string, unknown> | undefined) ??
    (root.gaps as Record<string, unknown> | undefined) ??
    {};

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
    icon_url: pickStr(profile.icon_url as string, subnet.logo_url as string),
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
    curation_level:
      (profile.curation_level as CurationLevel) ??
      (subnet.curation_level as CurationLevel) ??
      ((curation.level as CurationLevel) || undefined),
    coverage_level: subnet.coverage_level as SubnetProfile["coverage_level"],
    review_state: pickStr(profile.review_state, curation.review_state as string),
    reviewed_at: pickStr(curation.reviewed_at as string),
    confidence: pickStr(profile.confidence as string),
    completeness: completenessRatio,
    completeness_score: score,
    integration_readiness:
      typeof profile.integration_readiness === "number"
        ? (profile.integration_readiness as number)
        : undefined,
    readiness: normalizeReadiness(profile.readiness),
    // counts
    surface_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    surfaces_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    endpoint_count: (profile.endpoint_count as number) ?? (subnet.probed_surface_count as number),
    candidate_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    candidates_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    monitored_endpoint_count: profile.monitored_endpoint_count as number | undefined,
    operational_interface_kinds: (profile.operational_interface_kinds as string[]) ?? [],
    supported_interface_kinds:
      (profile.supported_interface_kinds as string[]) ?? (gaps.supported_kinds as string[]) ?? [],
    missing_kinds:
      (gaps.missing_kinds as string[]) ?? (profile.missing_operational as string[]) ?? [],
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
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/surfaces`,
        "surfaces",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeSurface) } as ApiResult<Surface[]>;
    },
    staleTime: STALE_MED,
  });

// #748: which surfaces carry a captured request/response sample (index), and
// the full sanitized sample for one surface (detail, fetched lazily on expand).
export const fixturesIndexQuery = () =>
  queryOptions({
    queryKey: k("fixtures-index"),
    queryFn: async ({ signal }) =>
      fetchList<FixtureIndexEntry>("/api/v1/fixtures", "fixtures", undefined, signal),
    staleTime: STALE_LONG,
  });

export const fixtureDetailQuery = (surfaceId: string) =>
  queryOptions({
    queryKey: k("fixture-detail", surfaceId),
    queryFn: async ({ signal }) =>
      apiFetch<Fixture>(`/metagraph/fixtures/${encodePathSegment(surfaceId)}.json`, { signal }),
    staleTime: STALE_LONG,
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
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/subnets/${netuid}/health`, {
        signal,
      });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const merged = normalizeHealthBlock({ ...d, ...summary });
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function normalizeSurfaceLatencyPercentile(raw: unknown): SurfaceLatencyPercentiles | undefined {
  if (!isPlainRecord(raw) || typeof raw.surface_id !== "string") return undefined;

  const latency = isPlainRecord(raw.latency_ms) ? raw.latency_ms : {};
  return {
    surface_id: raw.surface_id,
    samples: optionalNumber(raw.samples),
    latency_ms: {
      p50: optionalNumber(latency.p50),
      p95: optionalNumber(latency.p95),
      p99: optionalNumber(latency.p99),
      avg: optionalNumber(latency.avg),
      min: optionalNumber(latency.min),
      max: optionalNumber(latency.max),
    },
  };
}

function normalizeSurfaceLatencyPercentiles(raw: unknown): SurfaceLatencyPercentiles[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((surface) => {
    const normalized = normalizeSurfaceLatencyPercentile(surface);
    return normalized ? [normalized] : [];
  });
}

function normalizeSurfaceSla(raw: unknown): SurfaceSla | undefined {
  if (!isPlainRecord(raw) || typeof raw.surface_id !== "string") return undefined;

  return {
    surface_id: raw.surface_id,
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    incident_count: optionalNumber(raw.incident_count),
    downtime_ms: optionalNumber(raw.downtime_ms),
    incidents: Array.isArray(raw.incidents) ? raw.incidents : undefined,
  };
}

function normalizeSurfaceSlas(raw: unknown): SurfaceSla[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((surface) => {
    const normalized = normalizeSurfaceSla(surface);
    return normalized ? [normalized] : [];
  });
}

// #1114: per-surface latency distribution (p50/p95/p99) over a 7d/30d window,
// computed live from D1.
export const subnetHealthPercentilesQuery = (netuid: number, window = "7d") =>
  queryOptions({
    queryKey: k("subnet-health-percentiles", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ surfaces?: unknown }>(
        `/api/v1/subnets/${netuid}/health/percentiles`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSurfaceLatencyPercentiles(res.data?.surfaces),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

// #1114: per-surface SLA (uptime ratio) + reconstructed downtime incidents over
// a 7d/30d window, computed live from D1.
export const subnetHealthIncidentsQuery = (netuid: number, window = "7d") =>
  queryOptions({
    queryKey: k("subnet-health-incidents", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ surfaces?: unknown }>(
        `/api/v1/subnets/${netuid}/health/incidents`,
        { params: { window }, signal },
      );
      return { data: normalizeSurfaceSlas(res.data?.surfaces), meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function epochMsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * Flatten the per-surface SLA rows from {@link subnetHealthIncidentsQuery} into
 * a single chronological list of downtime windows, newest-first. Each window is
 * tagged with its owning surface_id and has epoch-ms timestamps converted to ISO
 * strings (for TimeAgo / date rendering). The upstream payload carries no id,
 * severity, or message per incident — these are reconstructed failure windows —
 * so severity is fixed to "high" and identity comes from surface_id + start.
 */
export function flattenSurfaceIncidents(slas: SurfaceSla[]): FlatSurfaceIncident[] {
  const out: FlatSurfaceIncident[] = [];
  for (const sla of slas) {
    for (const inc of sla.incidents ?? []) {
      out.push({
        surface_id: sla.surface_id,
        started_at: epochMsToIso(inc.started_at),
        ended_at: inc.ended_at == null ? null : (epochMsToIso(inc.ended_at) ?? null),
        duration_ms: typeof inc.duration_ms === "number" ? inc.duration_ms : undefined,
        failed_samples: typeof inc.failed_samples === "number" ? inc.failed_samples : undefined,
        severity: "high",
      });
    }
  }
  return out.sort((a, b) => {
    const at = a.started_at ? Date.parse(a.started_at) : 0;
    const bt = b.started_at ? Date.parse(b.started_at) : 0;
    return bt - at;
  });
}

// #1115: weekly structural trajectory (completeness / surface / endpoint counts
// over time) from D1 snapshots.
export const subnetTrajectoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-trajectory", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Trajectory>>(`/api/v1/subnets/${netuid}/trajectory`, {
        signal,
      });
      return { data: normalizeTrajectory(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_LONG,
  });

// #1115: long-range daily uptime history + reliability grade per surface, over a
// 90d/1y window.
export const subnetUptimeQuery = (netuid: number, window = "90d") =>
  queryOptions({
    queryKey: k("subnet-uptime", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Uptime>>(`/api/v1/subnets/${netuid}/uptime`, {
        params: { window },
        signal,
      });
      return { data: normalizeUptime(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// #1124 port: composed subnet overview (profile + health + curation + gaps + counts)
// in one call — for the redesigned subnet-detail header/overview.
export const subnetOverviewQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-overview", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<SubnetOverview>(`/api/v1/subnets/${netuid}/overview`, {
        signal,
      });
      return { data: (res.data ?? { netuid }) as SubnetOverview, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// #1124 port: per-window health trends. NB the live API returns each window as an
// aggregate snapshot with a per-surface breakdown (`surfaces[]`), not a `points[]`
// series — consumers wanting a daily time-series should use subnetUptimeQuery instead.
export const subnetHealthTrendsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-health-trends", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ windows?: unknown }>(
        `/api/v1/subnets/${netuid}/health/trends`,
        { signal },
      );
      return { data: normalizeHealthTrends(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function normalizeHealthTrendLatency(raw: unknown): HealthTrendSurface["latency_ms"] {
  if (!isPlainRecord(raw)) return undefined;
  return {
    p50: optionalNumber(raw.p50),
    p95: optionalNumber(raw.p95),
    p99: optionalNumber(raw.p99),
  };
}

function normalizeHealthTrendSurface(raw: unknown): HealthTrendSurface | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const surfaceId = coerceString(raw.surface_id);
  if (!surfaceId) return undefined;

  return {
    ...(raw as object),
    surface_id: surfaceId,
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    avg_latency_ms: optionalNumber(raw.avg_latency_ms),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
    latency_ms: normalizeHealthTrendLatency(raw.latency_ms),
  };
}

function normalizeHealthTrendWindow(raw: unknown): HealthTrendWindow | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.slice(0, MAX_HEALTH_TREND_SURFACES).flatMap((surface) => {
        const normalized = normalizeHealthTrendSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    ...(raw as object),
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
    surfaces,
  };
}

function normalizeHealthTrends(raw: unknown): HealthTrends {
  const d = isPlainRecord(raw) ? raw : {};
  const windows = isPlainRecord(d.windows)
    ? Object.fromEntries(
        Object.entries(d.windows).flatMap(([range, window]) => {
          const normalized = normalizeHealthTrendWindow(window);
          return normalized ? [[range, normalized]] : [];
        }),
      )
    : {};
  return { windows };
}

export function sortedHealthTrendSurfaces(window: HealthTrendWindow | undefined) {
  const surfaces = Array.isArray(window?.surfaces)
    ? window.surfaces.slice(0, MAX_HEALTH_TREND_SURFACES).flatMap((surface) => {
        const normalized = normalizeHealthTrendSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return surfaces.sort((a, b) => (a.uptime_ratio ?? 1) - (b.uptime_ratio ?? 1));
}

/**
 * Extract honest per-surface distribution series from a health-trends window.
 *
 * The window has no time dimension — it is an aggregate snapshot with a
 * per-surface breakdown — so these are distributions ACROSS surfaces (worst
 * uptime first), not time-series. Use them for spread sparklines, never for a
 * "trend over time". Returns empty arrays when the window has no surfaces.
 */
export function trendSurfaceSeries(window: HealthTrendWindow | undefined): {
  uptimePct: number[];
  p50: number[];
  p95: number[];
} {
  const surfaces = sortedHealthTrendSurfaces(window);
  const finite = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v);
  return {
    uptimePct: surfaces
      .map((s) => (finite(s.uptime_ratio) ? s.uptime_ratio * 100 : null))
      .filter((v): v is number => v != null),
    p50: surfaces
      .map((s) => (finite(s.latency_ms?.p50) ? s.latency_ms!.p50! : (s.avg_latency_ms ?? null)))
      .filter((v): v is number => v != null && Number.isFinite(v)),
    p95: surfaces.map((s) => s.latency_ms?.p95).filter((v): v is number => finite(v)),
  };
}

// Candidate rows carry `review_notes` (not `notes`) and a nested
// `verification.verified_at` (no top-level `discovered_at`).
function normalizeCandidate(raw: unknown): Candidate {
  if (!raw || typeof raw !== "object") return raw as Candidate;
  const c = raw as Record<string, unknown>;
  const verification = (c.verification as Record<string, unknown> | undefined) ?? {};
  return {
    ...(c as object),
    notes: (c.notes as string) ?? (c.review_notes as string),
    discovered_at:
      (c.discovered_at as string) ??
      (verification.verified_at as string) ??
      (c.observed_at as string),
  } as Candidate;
}

export const subnetCandidatesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-candidates", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/candidates`,
        "candidates",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeCandidate) } as ApiResult<Candidate[]>;
    },
    staleTime: STALE_LONG,
  });

export const surfacesQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("surfaces", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/surfaces", "surfaces", params, signal);
      return { ...res, data: res.data.map(normalizeSurface) } as ApiResult<Surface[]>;
    },
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
  if (import.meta.env?.DEV) console.warn("[metagraphed] next_cursor has unexpected shape:", raw);
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
export const subnetsInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
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
export const surfacesInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
  infiniteQueryOptions({
    queryKey: k("surfaces-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchInfinitePage<unknown>(
        "/api/v1/surfaces",
        "surfaces",
        baseParams,
        pageParam as string,
        signal,
      );
      // Normalize on the infinite-query path so provider_slug, curation_level
      // (from authority), provider, last_verified_at, and the provider filter
      // are populated — same mapping the non-paginated surfacesQuery applies.
      return { ...page, data: page.data.map(normalizeSurface) } as InfinitePage<Surface>;
    },
    getNextPageParam: (last) => {
      const nc = (last.meta as Record<string, unknown>)?._next_cursor as string | null | undefined;
      return nc ?? undefined;
    },
    staleTime: STALE_MED,
  });

function statusToHealth(v: unknown): HealthState | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "ok" || v === "live") return "ok";
  if (v === "degraded" || v === "warn" || v === "redirected" || v === "transient") return "warn";
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
    provider_slug: (e.provider_slug as string) ?? (e.provider as string) ?? (e.operator as string),
    archive:
      (e.archive as boolean | undefined) ??
      (e.archive_support as boolean | undefined) ??
      (e.archive_capable as boolean | undefined),
    last_probed_at:
      (e.last_probed_at as string) ?? (e.last_checked as string) ?? (e.observed_at as string),
  } as Endpoint;
}

function normalizeSurface(raw: unknown): Surface {
  if (!raw || typeof raw !== "object") return raw as Surface;
  const s = raw as Record<string, unknown>;
  return {
    ...(s as object),
    // Per-surface payloads carry `authority` (official | registry-observed |
    // community | native-chain) — the real trust signal — but not curation_level.
    // Surface it as the chip level so surfaces don't all read "candidate-discovered".
    curation_level: (s.curation_level as CurationLevel) ?? (s.authority as CurationLevel),
    provider_slug: (s.provider_slug as string) ?? (s.provider as string),
  } as Surface;
}

function isHealthState(v: unknown): v is HealthState {
  return v === "ok" || v === "warn" || v === "down" || v === "unknown";
}

function normalizeIncident(raw: unknown): EndpointIncident {
  if (!raw || typeof raw !== "object") return raw as EndpointIncident;
  const i = raw as Record<string, unknown>;
  // API uses lifecycle state="active|resolved" and a separate
  // status="failed|degraded|ok". Some responses already use the frontend
  // contract state="ok|warn|down|unknown", so preserve those health states.
  const sev = i.severity as string | undefined;
  const sevHealth: HealthState | undefined =
    sev === "critical" ? "down" : sev === "warning" ? "warn" : undefined;
  const stateHealth =
    statusToHealth(i.status) ??
    sevHealth ??
    (isHealthState(i.state) ? i.state : undefined) ??
    "unknown";
  const ended = i.state === "resolved" || i.resolved_at;
  return {
    ...(i as object),
    id: i.id as string,
    state: stateHealth,
    message: (i.message as string) ?? (i.reason as string),
    started_at: (i.started_at as string) ?? (i.detected_at as string) ?? (i.observed_at as string),
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

// Pool rows are { id, kind, endpoint_count, eligible_count, best_endpoint_id,
// endpoints[] }; the pools table reads name/members_count/proxy_enabled/
// archive_capable. Derive those from the real fields (region is not modelled,
// stays "—"). archive_capable = any member endpoint supports archive; a pool is
// proxy-eligible when it has eligible endpoints.
function normalizePool(raw: unknown): RpcPool {
  if (!raw || typeof raw !== "object") return raw as RpcPool;
  const p = raw as Record<string, unknown>;
  const endpoints = Array.isArray(p.endpoints) ? p.endpoints.filter(isPlainRecord) : [];
  return {
    ...(p as object),
    id: p.id as string,
    name: (p.name as string) ?? (p.id as string) ?? (p.kind as string),
    members_count: (p.members_count as number) ?? (p.endpoint_count as number) ?? endpoints.length,
    proxy_enabled:
      (p.proxy_enabled as boolean) ??
      (typeof p.eligible_count === "number" && (p.eligible_count as number) > 0),
    archive_capable:
      (p.archive_capable as boolean) ?? endpoints.some((e) => e.archive_support === true),
  } as RpcPool;
}

export const rpcPoolsQuery = () =>
  queryOptions({
    queryKey: k("rpc-pools"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/rpc/pools", "pools", undefined, signal);
      return { ...res, data: res.data.map(normalizePool) } as ApiResult<RpcPool[]>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/rpc/usage returns a single analytics object (not a list), like the
// global incident ledger. Cold/unmigrated D1 already yields a schema-stable
// zeroed payload server-side; this normaliser just hardens against missing
// fields so a partial response can't crash the proxy panel.
function normalizeRpcUsage(raw: unknown): RpcUsage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (r.summary && typeof r.summary === "object" ? r.summary : {}) as Record<
    string,
    unknown
  >;
  const lat = (s.latency_ms && typeof s.latency_ms === "object" ? s.latency_ms : {}) as Record<
    string,
    unknown
  >;
  return {
    window: (r.window as string | null) ?? null,
    observed_at: (r.observed_at as string | null) ?? null,
    source: (r.source as string) ?? "rpc-proxy",
    summary: {
      total_requests: finiteNumber(s.total_requests),
      ok_requests: finiteNumber(s.ok_requests),
      error_requests: finiteNumber(s.error_requests),
      error_rate: finiteOptionalNumber(s.error_rate) ?? null,
      failover_requests: finiteNumber(s.failover_requests),
      failover_rate: finiteOptionalNumber(s.failover_rate) ?? null,
      cache_hits: finiteNumber(s.cache_hits),
      cache_hit_rate: finiteOptionalNumber(s.cache_hit_rate) ?? null,
      latency_ms: {
        p50: finiteOptionalNumber(lat.p50) ?? null,
        p95: finiteOptionalNumber(lat.p95) ?? null,
        avg: finiteOptionalNumber(lat.avg) ?? null,
      },
    },
    endpoints: Array.isArray(r.endpoints)
      ? r.endpoints.flatMap((endpoint, index) => {
          const normalized = normalizeRpcUsageEndpoint(endpoint, index);
          return normalized ? [normalized] : [];
        })
      : [],
    networks: Array.isArray(r.networks)
      ? r.networks.flatMap((network) => {
          const normalized = normalizeRpcUsageNetwork(network);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function normalizeRpcUsageEndpoint(
  raw: unknown,
  index: number,
): RpcUsage["endpoints"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  return {
    rank: finiteNumber(e.rank, index + 1),
    endpoint_id: typeof e.endpoint_id === "string" ? e.endpoint_id : null,
    provider: typeof e.provider === "string" ? e.provider : null,
    requests: finiteNumber(e.requests),
    ok_requests: finiteNumber(e.ok_requests),
    error_rate: finiteOptionalNumber(e.error_rate) ?? null,
    avg_latency_ms: finiteOptionalNumber(e.avg_latency_ms) ?? null,
  };
}

function normalizeRpcUsageNetwork(raw: unknown): RpcUsage["networks"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const n = raw as Record<string, unknown>;
  const network = typeof n.network === "string" ? n.network : "unknown";
  return {
    network,
    requests: finiteNumber(n.requests),
    ok_requests: finiteNumber(n.ok_requests),
    error_rate: finiteOptionalNumber(n.error_rate) ?? null,
  };
}

export const rpcUsageQuery = (window = "7d") =>
  queryOptions({
    queryKey: k("rpc-usage", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/rpc/usage", { params: { window }, signal });
      return { ...res, data: normalizeRpcUsage(res.data) } as ApiResult<RpcUsage>;
    },
    staleTime: STALE_SHORT,
  });

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const AGENT_RESOURCE_KINDS = new Set(["agent", "skill", "index", "contract", "api", "data"]);

function normalizeAgentResource(raw: unknown, index: number): AgentResource | undefined {
  const r = recordValue(raw);
  const id = stringValue(r.id, `resource-${index}`);
  const title = stringValue(r.title);
  const url = stringValue(r.url);
  if (!title || !url) return undefined;

  const kind = stringValue(r.kind);
  return {
    id,
    kind: AGENT_RESOURCE_KINDS.has(kind) ? kind : "api",
    title,
    url,
  };
}

function normalizeAgentResources(raw: unknown): AgentResources {
  const d = recordValue(raw);
  const copyableAgent = recordValue(d.copyable_agent);
  const mcp = recordValue(d.mcp);
  const summary = recordValue(d.summary);
  const tools = Array.isArray(mcp.tools)
    ? mcp.tools
        .map((tool) => {
          const t = recordValue(tool);
          return { name: stringValue(t.name), title: stringValue(t.title) || undefined };
        })
        .filter((tool) => tool.name)
    : [];
  const resources = Array.isArray(d.resources)
    ? d.resources.flatMap((resource, index) => {
        const normalized = normalizeAgentResource(resource, index);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    generated_at: stringValue(d.generated_at) || null,
    published_at: stringValue(d.published_at) || null,
    copyable_agent: {
      title: stringValue(copyableAgent.title),
      description: stringValue(copyableAgent.description),
      url: stringValue(copyableAgent.url),
    },
    mcp: {
      endpoint: stringValue(mcp.endpoint),
      install: stringValue(mcp.install),
      server_card: stringValue(mcp.server_card),
      transport: stringValue(mcp.transport, "MCP"),
      tools,
    },
    summary: {
      callable_service_count: finiteNumber(summary.callable_service_count),
      subnet_count: finiteNumber(summary.subnet_count),
    },
    resources,
  };
}

// /api/v1/agent-resources — the machine-readable index of every AI surface
// (MCP, agent.md, llms.txt, openapi, catalog, datasets, …). Single object.
export const agentResourcesQuery = () =>
  queryOptions({
    queryKey: k("agent-resources"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/agent-resources", { signal });
      return { ...res, data: normalizeAgentResources(res.data) } as ApiResult<AgentResources>;
    },
    staleTime: STALE_MED,
  });

export const endpointPoolsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-pools"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/endpoint-pools", "pools", undefined, signal);
      return { ...res, data: res.data.map(normalizePool) } as ApiResult<RpcPool[]>;
    },
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

/**
 * Global, cross-subnet incident ledger (/api/v1/incidents) — recent downtime
 * reconstructed from probe history, grouped by surface, over a 7d/30d window.
 * Broader than endpoint-incidents (which is RPC-only); powers the /status page.
 */
export const globalIncidentsQuery = (window: string) =>
  queryOptions({
    queryKey: k("incidents", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/incidents", { params: { window }, signal });
      return { ...res, data: normalizeGlobalIncidents(res.data) } as ApiResult<GlobalIncidents>;
    },
    staleTime: STALE_SHORT,
  });

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteEpochMs(value: unknown): number | undefined {
  const n = finiteNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return undefined;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : undefined;
}

function normalizeGlobalIncident(raw: unknown): GlobalIncident | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!r) return undefined;
  const started_at = finiteEpochMs(r.started_at) ?? 0;
  const ended_at = finiteEpochMs(r.ended_at) ?? 0;
  return {
    started_at,
    ended_at,
    duration_ms: finiteNumber(r.duration_ms),
    failed_samples: finiteOptionalNumber(r.failed_samples),
  };
}

function normalizeGlobalIncidentSurface(raw: unknown): GlobalIncidentSurface | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!r) return undefined;
  const incidents = Array.isArray(r.incidents)
    ? r.incidents.flatMap((incident) => {
        const normalized = normalizeGlobalIncident(incident);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: finiteNumber(r.netuid),
    surface_id: pickStr(r.surface_id) ?? "",
    incident_count: finiteNumber(r.incident_count, incidents.length),
    downtime_ms: finiteNumber(r.downtime_ms),
    incidents,
  };
}

function normalizeGlobalIncidents(raw: unknown): GlobalIncidents {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary =
    r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : {};
  const surfaces = Array.isArray(r.surfaces)
    ? r.surfaces.flatMap((surface) => {
        const normalized = normalizeGlobalIncidentSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    window: pickStr(r.window) ?? null,
    observed_at: pickStr(r.observed_at) ?? null,
    source: pickStr(r.source),
    summary: {
      incident_count: finiteNumber(summary.incident_count),
      affected_surface_count: finiteNumber(summary.affected_surface_count, surfaces.length),
    },
    surfaces,
  };
}

function normalizeProviderListItem(raw: unknown): Provider {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const slug = pickStr(r.slug, r.id) ?? "";
  const website = pickStr(r.website_url, r.website, r.homepage);
  const docs = pickStr(r.docs_url, r.docs);
  const repo = pickStr(r.github_url, r.repo, r.repository);
  return {
    ...r,
    slug,
    name: pickStr(r.name) ?? slug,
    kind: pickStr(r.kind),
    authority: pickStr(r.authority),
    homepage: website,
    website,
    docs,
    repo,
    // Curated/backfilled provider logo → BrandIcon's iconUrl (mirrors subnets).
    icon_url: (r.icon_url as Provider["icon_url"]) ?? (r.logo_url as string),
    notes: pickStr(r.notes, r.public_notes),
    // API returns snake_case singular (endpoint_count / surface_count / subnet_count).
    // Normalize to the plural _count fields used by all consumers.
    endpoints_count:
      (r.endpoint_count as number | undefined) ?? (r.endpoints_count as number | undefined),
    surfaces_count:
      (r.surface_count as number | undefined) ?? (r.surfaces_count as number | undefined),
    subnet_count: r.subnet_count as number | undefined,
  } as Provider;
}

export const providersQuery = () =>
  queryOptions({
    queryKey: k("providers"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/providers", "providers", undefined, signal);
      return { ...res, data: res.data.map(normalizeProviderListItem) } as ApiResult<Provider[]>;
    },
    staleTime: STALE_MED,
  });

/**
 * Per-provider tally of surfaces / endpoints / subnets, keyed by provider slug.
 * These counts ride along on each /api/v1/providers list row
 * (endpoint_count / surface_count / subnet_count, normalized to the *_count
 * fields by `normalizeProviderListItem`), so consumers derive this map from the
 * providers query itself rather than re-fetching the surfaces + endpoints
 * collections.
 */
export type ProviderCounts = {
  surfaces: number;
  endpoints: number;
  subnets: number;
};

function normalizeProvider(raw: unknown, slug: string): Provider {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const inner = (root.provider as Record<string, unknown> | undefined) ?? root;
  const summary = (root.endpoint_summary as Record<string, unknown> | undefined) ?? undefined;
  const website = pickStr(inner.website_url, inner.homepage, inner.website);
  const docs = pickStr(inner.docs_url, inner.docs);
  return {
    slug: (inner.id as string) ?? (inner.slug as string) ?? slug,
    name: pickStr(inner.name) ?? slug,
    kind: pickStr(inner.kind),
    authority: pickStr(inner.authority),
    homepage: website,
    website,
    docs,
    notes: pickStr(inner.notes),
    endpoint_summary: summary as ProviderEndpointSummary | undefined,
    // Normalize singular API field names (endpoint_count / surface_count) to
    // plural _count fields so all consumers use the same key regardless of
    // whether the data came from the list or detail endpoint.
    endpoints_count:
      (inner.endpoint_count as number | undefined) ??
      (summary?.endpoint_count as number | undefined),
    surfaces_count:
      (inner.surface_count as number | undefined) ?? (inner.surfaces_count as number | undefined),
    generated_at: pickStr(root.generated_at as string, inner.generated_at as string),
    ...inner,
    icon_url: (inner.icon_url as Provider["icon_url"]) ?? (inner.logo_url as string),
  } as Provider;
}

export const providerQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider", slug),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/providers/${encodePathSegment(slug)}`, {
        signal,
      });
      return {
        data: normalizeProvider(res.data, slug),
        meta: res.meta,
        url: res.url,
      } as ApiResult<Provider>;
    },
    staleTime: STALE_MED,
  });

export const providerEndpointsQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider-endpoints", slug),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/providers/${encodePathSegment(slug)}/endpoints`,
        "endpoints",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/gaps returns per-subnet gap PROFILES
// ({ netuid, name, slug, coverage_level, curation_level, gaps: { missing_kinds,
// gap_notes, supported_kinds } }), not flat gap records. Reshape each subnet that
// has missing surface kinds into a single displayable gap card.
function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    return [];
  });
}

function normalizeGap(raw: unknown): Gap {
  const r = (raw ?? {}) as Record<string, unknown>;
  const g = (r.gaps as Record<string, unknown> | undefined) ?? {};
  const missing = stringArrayFromUnknown(g.missing_kinds);
  const notes = stringArrayFromUnknown(g.gap_notes);
  const netuid = r.netuid as number | undefined;
  const name = (r.name as string) ?? (netuid != null ? `SN${netuid}` : "subnet");
  const core = missing.filter((kind) => kind === "openapi" || kind === "subnet-api").length;
  const severity =
    core >= 1 && missing.length >= 3 ? "high" : missing.length >= 2 ? "medium" : "low";
  return {
    id: (r.slug as string) ?? `gap-${netuid}`,
    netuid,
    category: (r.curation_level as string) ?? (r.coverage_level as string),
    severity,
    title: `${name} — ${missing.length} missing surface${missing.length === 1 ? "" : "s"}`,
    description: missing.length ? `Missing: ${missing.join(", ")}` : undefined,
    suggested_action: notes[0],
    // Preserve the raw arrays so consumers (e.g. the missing-kinds glance) can
    // bind to the real per-row missing kinds instead of parsing the description.
    missing_kinds: missing,
    gap_notes: notes,
  } as Gap;
}

export const gapsQuery = () =>
  queryOptions({
    queryKey: k("gaps"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/gaps", "gaps", undefined, signal);
      // Only surface subnets that actually have missing kinds.
      const rows = res.data.map(normalizeGap).filter((gap) => Boolean(gap.description));
      return { ...res, data: rows } as ApiResult<Gap[]>;
    },
    staleTime: STALE_LONG,
  });

export const reviewProfileCompletenessQuery = () =>
  queryOptions({
    queryKey: k("review-profile-completeness"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/profile-completeness",
        "profiles",
        undefined,
        signal,
      );
      // API exposes completeness_score (0-100); the UI bars expect a 0-1 ratio.
      const rows = res.data.map((r) => ({
        netuid: r.netuid as number,
        name: r.name as string | undefined,
        completeness:
          typeof r.completeness === "number"
            ? (r.completeness as number)
            : typeof r.completeness_score === "number"
              ? (r.completeness_score as number) / 100
              : undefined,
        missing: (r.missing_required as string[]) ?? (r.gap_reasons as string[]),
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

export const reviewAdapterCandidatesQuery = () =>
  queryOptions({
    queryKey: k("review-adapter-candidates"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/adapter-candidates",
        "candidates",
        undefined,
        signal,
      );
      // API rows: { netuid, name, slug, suggested_next_action, priority_score,
      // recommended_adapter_kind, reason_codes, ... }. Map to the fields the UI
      // reads (reason/score); the historical reason/score keys are not present.
      const rows = res.data.map((r) => ({
        netuid: r.netuid as number | undefined,
        name: r.name as string | undefined,
        slug: r.slug as string | undefined,
        reason:
          (r.reason as string) ??
          (r.suggested_next_action as string) ??
          (r.recommended_adapter_kind as string),
        score:
          typeof r.score === "number"
            ? (r.score as number)
            : typeof r.priority_score === "number"
              ? (r.priority_score as number)
              : undefined,
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

export const reviewEnrichmentQueueQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-queue"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/enrichment-queue",
        "queue",
        undefined,
        signal,
      );
      // API rows: { name, slug, netuid, priority_score, contribution_hint, ... }.
      const rows = res.data.map((r) => ({
        id: (r.slug as string) ?? (r.name as string) ?? String(r.netuid ?? ""),
        netuid: r.netuid as number | undefined,
        priority:
          (r.priority as string) ??
          (typeof r.priority_score === "number"
            ? String(Math.round(r.priority_score as number))
            : undefined),
        note:
          (r.note as string) ?? (r.contribution_hint as string) ?? (r.recommended_action as string),
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

function normalizeSchema(raw: unknown): SchemaInfo {
  if (!raw || typeof raw !== "object") return raw as SchemaInfo;
  const s = raw as Record<string, unknown>;
  const snap = (s.snapshot as Record<string, unknown> | undefined) ?? {};
  const drift = (s.drift_status as string | undefined) ?? (snap.drift_status as string | undefined);
  return {
    ...(s as object),
    id:
      (s.id as string) ??
      (s.surface_id as string) ??
      `${(s.netuid as number) ?? "?"}-${(s.path as string) ?? (s.url as string) ?? "schema"}`,
    name: (snap.title as string) ?? (s.name as string) ?? (s.surface_id as string),
    url: (s.schema_url as string) ?? (s.url as string) ?? (s.surface_url as string),
    netuid: (s.netuid as number) ?? (snap.netuid as number),
    surface_id: (s.surface_id as string) ?? (snap.surface_id as string),
    drift_status: drift,
    drift: drift != null && drift !== "unchanged",
    artifact_path: s.path as string | undefined,
    hash: typeof s.hash === "string" ? s.hash : undefined,
    previous_hash: typeof s.previous_hash === "string" ? s.previous_hash : undefined,
    status: s.status as string | undefined,
    updated_at:
      (s.observed_at as string) ??
      (snap.observed_at as string) ??
      (s.generated_at as string) ??
      (snap.generated_at as string),
  } as SchemaInfo;
}

export const schemasQuery = () =>
  queryOptions({
    queryKey: k("schemas"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/schemas", "schemas", undefined, signal);
      return { ...res, data: res.data.map(normalizeSchema) } as ApiResult<SchemaInfo[]>;
    },
    staleTime: STALE_MED,
  });

/**
 * Schemas filtered down to a single netuid. The profile envelope doesn't
 * currently expose schema drift, so we join against /api/v1/schemas here
 * until the upstream payload grows native drift fields.
 */
export const subnetSchemasQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-schemas", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/schemas", "schemas", undefined, signal);
      const all = res.data.map(normalizeSchema);
      const mine = all.filter((s) => s.netuid === netuid);
      return { ...res, data: mine } as ApiResult<SchemaInfo[]>;
    },
    staleTime: STALE_MED,
  });

export const contractsQuery = () =>
  queryOptions({
    queryKey: k("contracts"),
    queryFn: ({ signal }) =>
      // /api/v1/contracts nests the per-artifact contract metadata under
      // `data.artifacts` (each: id, description, path, content_type, storage_tier).
      fetchList<{
        id: string;
        description?: string;
        path?: string;
        content_type?: string;
        storage_tier?: string;
      }>("/api/v1/contracts", "artifacts", undefined, signal),
    staleTime: STALE_LONG,
  });

export const evidenceQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("evidence", params ?? {}),
    queryFn: ({ signal }) =>
      fetchList<EvidenceItem>("/api/v1/evidence", "evidence", params, signal),
    staleTime: STALE_LONG,
  });

type ChangelogEntry = { id: string; at?: string; title?: string; kind?: string };

function normalizeChangelogEntries(raw: unknown[]): ChangelogEntry[] {
  return raw.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];

    const id = optionalString(entry.id)?.trim() || `entry-${index}`;
    const title = optionalString(entry.title)?.trim() || id;

    return [
      {
        id,
        title,
        at: finiteTimestamp(entry.at),
        kind: optionalString(entry.kind)?.trim(),
      },
    ];
  });
}

export const changelogQuery = () =>
  queryOptions({
    queryKey: k("changelog"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/changelog", "entries", undefined, signal);
      return { ...res, data: normalizeChangelogEntries(res.data) };
    },
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
      apiFetch<AdapterSnapshot>(`/api/v1/adapters/${encodePathSegment(slug)}`, {
        signal,
      }),
    staleTime: STALE_MED,
  });
