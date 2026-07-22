// Analytics handlers extracted from workers/api.mjs (#1763, continuation).
// Trajectory, uptime, leaderboards, and compare share the registry-projection
// + schema-stable-empty-payload pattern. D1 fully eliminated (2026-07-17):
// every D1 read here is gone -- a Postgres-tier miss (or, for leaderboards,
// which never had tier plumbing) always falls through to the empty shape,
// marked via the D1-fallback WeakSet contract owned by analytics.mjs so it's
// never edge-cached as fresh.
//
// Dependency wiring mirrors configureAnalytics: the in-isolate memoized KV reads
// (`readHealthMetaKv`, `readEconomicsCurrentKv`) stay in api.mjs and are
// injected once at module-init so this file never imports api.mjs back.

import { UPTIME_WINDOWS } from "../config.ts";
import { tryPostgresTier } from "../postgres-tier.ts";
import { csvRequested, csvResponse } from "../csv.ts";
import { errorResponse } from "../http.ts";
import { readArtifact } from "../storage.ts";
import { contractVersion, envelopeResponse } from "../responses.ts";
import {
  analyticsMeta,
  analyticsQueryError,
  markD1FallbackResponse,
  validateQueryParams,
} from "./analytics.ts";
import {
  parseLimitParam,
  parseNonNegativeIntParam,
} from "../request-params.ts";
import {
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "../../src/neuron-history.mjs";
import { loadEconomicsTrends } from "../../src/economics-trends.ts";
import {
  COMPARE_DIMENSIONS,
  COMPARE_VALIDATORS_MAX,
  growthRowsFromSamples,
  parseCompareDimensions,
  parseCompareHotkeys,
  parseCompareNetuids,
} from "../../src/analytics-live.ts";
import {
  buildValidatorDetail,
  composeValidatorComparison,
} from "../../src/metagraph-neurons.ts";
import {
  formatLeaderboards,
  formatTrajectory,
  formatUptime,
  LEADERBOARD_BOARDS,
  resolveLiveEconomics,
} from "../../src/health-serving.ts";
import { DOMAIN_TAGS } from "../../src/domain-tags.ts";
import {
  buildDomainOverview,
  buildDomainSummary,
} from "../../src/domain-summary.ts";

type HealthMetaKvReader = (
  env: Env,
) => Promise<{ last_run_at?: string | null } | null>;
// Loose: readEconomicsCurrentKv's real return flows straight into
// resolveLiveEconomics (still untyped .mjs) without this file ever reading
// a field off it directly.
type EconomicsCurrentKvReader = (env: Env) => Promise<unknown>;

// Module-load-time placeholders, replaced by configureAnalyticsRoutes() at
// Worker/test startup before any route handler runs -- a wiring bug, never a
// reachable runtime path.
/* v8 ignore start */
let readHealthMetaKv: HealthMetaKvReader = () => {
  throw new Error("analytics routes used before configureAnalyticsRoutes()");
};
let readEconomicsCurrentKv: EconomicsCurrentKvReader = () => {
  throw new Error("analytics routes used before configureAnalyticsRoutes()");
};
/* v8 ignore stop */

const RESPONSE_FORMATS = ["json", "csv"];

const ECONOMICS_TRENDS_CSV_COLUMNS = [
  "snapshot_date",
  "subnet_count",
  "total_stake_tao",
  "alpha_price_tao_weighted",
  "alpha_price_tao_median",
  "validator_count",
  "miner_count",
  "mean_emission_share",
];

const TRAJECTORY_CSV_COLUMNS = [
  "date",
  "completeness_score",
  "surface_count",
  "endpoint_count",
  "validator_count",
  "miner_count",
  "total_stake_tao",
  "alpha_price_tao",
  "emission_share",
  "tao_in_pool_tao",
  "alpha_in_pool",
  "alpha_out_pool",
  "subnet_volume_tao",
];

// formatUptime nests per-day rows under each surface (data.surfaces[].days[]),
// since one subnet can have several probed surfaces. The CSV flattens that to
// one row per (surface, day) pair, tagged with surface_id since a subnet's
// rows would otherwise be indistinguishable across its surfaces, and unnests
// latency_ms.{p50,p95,p99} into their own columns.
const UPTIME_CSV_COLUMNS = [
  "surface_id",
  "day",
  "samples",
  "uptime_ratio",
  "avg_latency_ms",
  "latency_sample_count",
  "p50",
  "p95",
  "p99",
  "status",
];

function uptimeCsvRows(surfaces: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(surfaces) ? surfaces : []).flatMap(
    (surface: Record<string, unknown>) =>
      (Array.isArray(surface?.days) ? surface.days : []).map(
        (d: Record<string, unknown>) => ({
          surface_id: surface.surface_id,
          day: d.day,
          samples: d.samples,
          uptime_ratio: d.uptime_ratio,
          avg_latency_ms: d.avg_latency_ms,
          latency_sample_count: d.latency_sample_count,
          p50:
            (d.latency_ms as Record<string, unknown> | undefined)?.p50 ?? null,
          p95:
            (d.latency_ms as Record<string, unknown> | undefined)?.p95 ?? null,
          p99:
            (d.latency_ms as Record<string, unknown> | undefined)?.p99 ?? null,
          status: d.status,
        }),
      ),
  );
}

function validateFormatParam(
  url: URL,
): { parameter: string; message: string } | null {
  const raw = url.searchParams.get("format");
  if (raw === null && !url.searchParams.has("format")) return null;
  const normalized = String(raw || "").toLowerCase();
  if (RESPONSE_FORMATS.includes(normalized)) return null;
  return {
    parameter: "format",
    message: `format must be one of: ${RESPONSE_FORMATS.join(", ")}.`,
  };
}

function economicsTrendsCacheVariant(
  url: URL,
  request: Request | null,
  canonicalPath: string,
): string {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  // canonicalEconomicsTrendsCachePath always supplies ?window=…, so & is safe.
  return `${canonicalPath}&format=csv`;
}

function trajectoryCacheVariant(
  url: URL,
  request: Request | null,
  canonicalPath: string,
): string {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  return `${canonicalPath}?format=csv`;
}

function uptimeCacheVariant(
  url: URL,
  request: Request | null,
  canonicalPath: string,
): string {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  // canonicalUptimeCachePath always supplies ?window=…, so & is safe.
  return `${canonicalPath}&format=csv`;
}

export function configureAnalyticsRoutes(deps: {
  readHealthMetaKv: HealthMetaKvReader;
  readEconomicsCurrentKv: EconomicsCurrentKvReader;
}) {
  readHealthMetaKv = deps.readHealthMetaKv;
  readEconomicsCurrentKv = deps.readEconomicsCurrentKv;
}

interface LeaderboardProfilesProjection {
  subnetMeta: Map<number, { slug: string | null; name: string | null }>;
  mostComplete: Array<Record<string, unknown>>;
  builtAt: number;
}

const LEADERBOARD_PROFILES_TTL_MS = 300_000;
let leaderboardProfilesCache: LeaderboardProfilesProjection | null = null;

// Week-over-week structural trajectory from daily snapshots.
export async function handleTrajectory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, ["format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, flipped to
  // "postgres" in wrangler.jsonc (D1 retirement, 2026-07-16). D1 fully
  // eliminated (2026-07-17): a tier miss now always falls through to the
  // schema-stable empty payload (never a live D1 query).
  let isFallback = false;
  let data = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
  )) as ReturnType<typeof formatTrajectory> | null;
  if (!data) {
    isFallback = true;
    data = formatTrajectory({ netuid, rows: [] });
  }
  if (csvRequested(url, request)) {
    const csvRes = await csvResponse(
      data.points as unknown[],
      `subnet-${netuid}-trajectory`,
      "short",
      request,
      TRAJECTORY_CSV_COLUMNS,
    );
    return isFallback ? markD1FallbackResponse(csvRes) : csvRes;
  }
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/trajectory.json`,
        null,
      ),
    },
    "short",
  );
  return isFallback ? markD1FallbackResponse(response) : response;
}

// Network-wide economics time series (#1307): aggregate the per-subnet daily
// subnet_snapshots rows up to one point per UTC day across every subnet (total
// stake, stake-weighted + median alpha price, total validator/miner counts, mean
// emission share). Same source as the per-subnet trajectory; raw rows (not a GROUP
// BY) so the weighted/median price is computed in the pure builder. Schema-stable
// (day_count:0, days:[]) on a cold rollup. Bounded by ECONOMICS_TRENDS_ROW_CAP.
export async function handleEconomicsTrends(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const windowResult = parseHistoryWindow(url.searchParams.get("window")) as
    | { label: string; days: number }
    | { error: { parameter: string; message: string } };
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same table
  // and same flip as handleTrajectory above. D1 fully eliminated (2026-07-17).
  let isFallback = false;
  let data = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
  )) as Awaited<ReturnType<typeof loadEconomicsTrends>>["data"] | null;
  if (!data) {
    isFallback = true;
    const loaded = await loadEconomicsTrends({ windowLabel: label });
    data = loaded.data;
  }
  if (csvRequested(url, request)) {
    const csvRes = await csvResponse(
      data.days as unknown[],
      "economics-trends",
      "short",
      request,
      ECONOMICS_TRENDS_CSV_COLUMNS,
    );
    return isFallback ? markD1FallbackResponse(csvRes) : csvRes;
  }
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(env, "/metagraph/economics/trends.json", null),
    },
    "short",
  );
  return isFallback ? markD1FallbackResponse(response) : response;
}

// Long-term daily uptime history for one subnet's operational surfaces.
export async function handleUptime(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, [
    "window",
    "min_samples",
    "format",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const windowParam = url.searchParams.get("window") || "90d";
  if (!Object.hasOwn(UPTIME_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, UPTIME_WINDOWS),
    });
  }
  // Optional low-sample noise floor: drop day rows whose aggregated probe count
  // is below the threshold (a HAVING bound param), so sparse days (including
  // the SUM(samples)=0 'unknown' rows) can be excluded from availability charts.
  const minSamplesResult = parseNonNegativeIntParam(
    url.searchParams.get("min_samples"),
    "min_samples",
  );
  if ("error" in minSamplesResult)
    return analyticsQueryError(minSamplesResult.error);
  // #4832 gap-closure follow-up: reuses METAGRAPH_HEALTH_SOURCE (same table
  // as the bulk-trends/trends/percentiles/incidents routes in analytics.mjs,
  // flipped to "postgres" in wrangler.jsonc -- see that flag's own header
  // comment there). D1 fully eliminated (2026-07-17): a tier miss now always
  // falls through to the schema-stable empty payload (never a live D1 query).
  let isFallback = false;
  let data = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_HEALTH_SOURCE",
  )) as ReturnType<typeof formatUptime> | null;
  if (!data) {
    isFallback = true;
    const healthMeta = await readHealthMetaKv(env);
    data = formatUptime({
      netuid,
      window: windowParam,
      observedAt: healthMeta?.last_run_at || null,
      rows: [],
      now: new Date().toISOString(),
    } as unknown as Parameters<typeof formatUptime>[0]);
  }
  if (csvRequested(url, request)) {
    const csvRes = await csvResponse(
      uptimeCsvRows(data.surfaces),
      `subnet-${netuid}-uptime`,
      "short",
      request,
      UPTIME_CSV_COLUMNS,
    );
    return isFallback ? markD1FallbackResponse(csvRes) : csvRes;
  }
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/uptime.json`,
        data.observed_at,
      ),
    },
    "short",
  );
  return isFallback ? markD1FallbackResponse(response) : response;
}

// Normalises the uptime URL so that a bare ?-free request and an explicit
// ?window=90d request both resolve to the same edge-cache entry — mirrors
// canonicalSubnetConcentrationHistoryCachePath in entities.mjs.
export function canonicalUptimeCachePath(
  url: URL,
  request: Request | null = null,
): string {
  const validationError = validateQueryParams(url, [
    "window",
    "min_samples",
    "format",
  ]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateFormatParam(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const windowParam = url.searchParams.get("window") || "90d";
  if (!Object.hasOwn(UPTIME_WINDOWS, windowParam))
    return `${url.pathname}${url.search}`;
  // min_samples is a HAVING row-filter that changes the response (handleUptime
  // drops day rows below the threshold), so it MUST be part of the cache key.
  // Omitting it collides ?min_samples=100 (few rows) with ?min_samples=0 (all
  // rows) on one edge-cache entry, serving whichever was cached first for both.
  const minSamplesResult = parseNonNegativeIntParam(
    url.searchParams.get("min_samples"),
    "min_samples",
  );
  if ("error" in minSamplesResult) return `${url.pathname}${url.search}`;
  const params = [`window=${encodeURIComponent(windowParam)}`];
  if (minSamplesResult.value !== null)
    params.push(`min_samples=${minSamplesResult.value}`);
  return uptimeCacheVariant(
    url,
    request,
    `${url.pathname}?${params.join("&")}`,
  );
}

// Normalises the economics-trends URL so that a bare ?-free request and an explicit
// ?window=30d request both resolve to the same edge-cache entry — mirrors
// canonicalSubnetHistoryCachePath in entities.mjs.
export function canonicalEconomicsTrendsCachePath(
  url: URL,
  request: Request | null = null,
): string {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateFormatParam(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const windowResult = parseHistoryWindow(url.searchParams.get("window"));
  if ("error" in windowResult) return `${url.pathname}${url.search}`;
  return economicsTrendsCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(windowResult.label)}`,
  );
}

// Normalises the per-subnet trajectory URL so JSON and CSV variants get distinct
// edge-cache entries — mirrors canonicalEconomicsTrendsCachePath.
export function canonicalTrajectoryCachePath(
  url: URL,
  request: Request | null = null,
): string {
  const validationError = validateQueryParams(url, ["format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateFormatParam(url);
  if (formatError) return `${url.pathname}${url.search}`;
  return trajectoryCacheVariant(url, request, url.pathname);
}

// Normalises the leaderboards URL so that a bare ?-free request and an explicit
// ?limit=20 request both resolve to the same edge-cache entry — mirrors
// canonicalCompareCachePath and canonicalUptimeCachePath.
export function canonicalLeaderboardsCachePath(url: URL): string {
  const validationError = validateQueryParams(url, ["board", "limit"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const limitResult = parseLimitParam(url, { defaultLimit: 20, maxLimit: 100 });
  if ("error" in limitResult) {
    return `${url.pathname}${url.search}`;
  }
  const board = url.searchParams.get("board");
  if (board && !LEADERBOARD_BOARDS.includes(board)) {
    return `${url.pathname}${url.search}`;
  }
  const cap = limitResult.limit;
  const params = [`limit=${cap}`];
  if (board) params.unshift(`board=${encodeURIComponent(board)}`);
  return `${url.pathname}?${params.join("&")}`;
}

async function leaderboardProfilesProjection(
  env: Env,
  now = Date.now(),
): Promise<LeaderboardProfilesProjection> {
  if (
    leaderboardProfilesCache &&
    now - leaderboardProfilesCache.builtAt <= LEADERBOARD_PROFILES_TTL_MS
  ) {
    return leaderboardProfilesCache;
  }
  const artifact = await readArtifact(env, "/metagraph/profiles.json");
  const profiles: Array<Record<string, unknown>> = artifact.ok
    ? (artifact.data as { profiles?: Array<Record<string, unknown>> })
        ?.profiles || []
    : [];
  const subnetMeta: LeaderboardProfilesProjection["subnetMeta"] = new Map();
  const mostComplete: LeaderboardProfilesProjection["mostComplete"] = [];
  for (const profile of profiles) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid as number, {
      slug: (profile.slug as string | null) ?? null,
      name: (profile.name as string | null) ?? null,
    });
    mostComplete.push({
      netuid: profile.netuid,
      slug: profile.slug ?? null,
      name: profile.name ?? null,
      completeness_score: profile.completeness_score ?? null,
      surface_count: profile.surface_count ?? 0,
      operational_interface_count: profile.operational_interface_count ?? 0,
    });
  }
  const projection = { subnetMeta, mostComplete, builtAt: now };
  if (mostComplete.length > 0) {
    leaderboardProfilesCache = projection;
  }
  return projection;
}

async function resolveEconomicsRows(env: Env): Promise<unknown[]> {
  const live = (await resolveLiveEconomics({
    readHealthKv: (e: Env) => readEconomicsCurrentKv(e),
    env,
    contractVersion: contractVersion(env),
  })) as { data?: { subnets?: unknown[] } } | null;
  if (Array.isArray(live?.data?.subnets)) return live.data.subnets;
  const artifact = await readArtifact(env, "/metagraph/economics.json");
  const artifactSubnets = artifact.ok
    ? (artifact.data as { subnets?: unknown[] })?.subnets
    : undefined;
  return Array.isArray(artifactSubnets) ? artifactSubnets : [];
}

/**
 * Compose the registry-leaderboards payload: the profiles projection and the
 * economics tier, folded through formatLeaderboards.
 *
 * D1 fully eliminated (2026-07-17): this route never had a Postgres-tier
 * mirror for the health/rpc/growth/reliability boards (surface_status/
 * subnet_snapshots/surface_uptime_daily), so those boards are always empty
 * now rather than adding new tier plumbing out of scope for D1 retirement.
 * `economicsRows` isn't D1 -- it comes from the economics tier -- so that
 * board is unaffected.
 *
 * Split out of handleLeaderboards so the GraphQL mirror
 * (Query.registry_leaderboards, #5661) reuses this exact projection.
 */
export async function composeLeaderboardsData(
  env: Env,
  { board = null, limit = 20 }: { board?: string | null; limit?: number } = {},
): Promise<{ data: ReturnType<typeof formatLeaderboards> }> {
  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);
  const economicsRows = await resolveEconomicsRows(env);

  const meta = await readHealthMetaKv(env);
  const data = formatLeaderboards({
    board,
    limit,
    observedAt: meta?.last_run_at || null,
    healthRows: [],
    rpcRows: [],
    mostComplete,
    growthRows: growthRowsFromSamples([]),
    reliabilityRows: [],
    economicsRows,
    subnetMeta,
  } as unknown as Parameters<typeof formatLeaderboards>[0]);
  return { data };
}

export async function handleLeaderboards(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, ["board", "limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const requestedBoard = url.searchParams.get("board");
  if (requestedBoard && !LEADERBOARD_BOARDS.includes(requestedBoard)) {
    return errorResponse(
      "invalid_query",
      `Unknown board "${requestedBoard}". Valid boards: ${LEADERBOARD_BOARDS.join(", ")}.`,
      400,
    );
  }
  const limitResult = parseLimitParam(url, { defaultLimit: 20, maxLimit: 100 });
  if ("error" in limitResult) {
    return errorResponse("invalid_query", limitResult.error.message, 400);
  }

  const { data } = await composeLeaderboardsData(env, {
    board: requestedBoard || null,
    limit: limitResult.limit,
  });
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/registry/leaderboards.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        source: "registry+live-cron-prober",
      },
    },
    "standard",
  );
  // D1 fully eliminated (2026-07-17): the health/rpc/growth/reliability
  // boards are always empty now (see composeLeaderboardsData) -- never
  // edge-cache this as if it were a fresh read.
  return markD1FallbackResponse(response);
}

export function canonicalCompareCachePath(url: URL): string | null {
  if (validateQueryParams(url, ["netuids", "dimensions"])) return null;
  const requestedNetuids = parseCompareNetuids(url.searchParams.get("netuids"));
  if (!requestedNetuids) return null;
  const dimensions = parseCompareDimensions(url.searchParams.get("dimensions"));
  if (!dimensions) return null;
  const params = [`netuids=${encodeURIComponent(requestedNetuids.join(","))}`];
  if (dimensions.length !== COMPARE_DIMENSIONS.length) {
    params.push(`dimensions=${encodeURIComponent(dimensions.join(","))}`);
  }
  return `${url.pathname}?${params.join("&")}`;
}

// D1 can hand a numeric column back as a string on some read paths (the same
// class of cell-coercion the feed formatters apply, e.g. formatBlock). Parse a
// string cell to a number so the CompareArtifact numeric fields never leak a
// string; leave real numbers, null, and absent cells exactly as-is so the
// artifact's null/absent contract is unchanged. Booleans (registration_allowed)
// are intentionally not routed through here. It also normalizes the per-tier
// Map join key: composeCompareData looks tiers up by numeric requested netuid,
// so a string-typed row netuid ("7") must key on 7 or the tier drops to null.
function coerceD1Number(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : value;
}

interface CompareSubnetEntry {
  netuid: number;
  name: string | null;
  slug: string | null;
  found: boolean;
  structure?: unknown;
  economics?: unknown;
  health?: unknown;
}

export function composeCompareData({
  requestedNetuids,
  dimensions,
  subnetMeta,
  structureRows,
  economicsRows,
  healthRows,
  observedAt,
}: {
  requestedNetuids: number[];
  dimensions: string[];
  subnetMeta: Map<number, { name: string | null; slug: string | null }>;
  structureRows: Array<Record<string, unknown>> | null | undefined;
  economicsRows: Array<Record<string, unknown>> | null | undefined;
  healthRows: Array<Record<string, unknown>> | null | undefined;
  observedAt: unknown;
}) {
  const includeStructure = dimensions.includes("structure");
  const includeEconomics = dimensions.includes("economics");
  const includeHealth = dimensions.includes("health");

  const structureByNetuid = new Map<number, Record<string, unknown>>();
  for (const row of structureRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    structureByNetuid.set(netuid as number, {
      completeness_score: coerceD1Number(row.completeness_score),
      surface_count: coerceD1Number(row.surface_count),
      operational_interface_count: coerceD1Number(
        row.operational_interface_count,
      ),
    });
  }
  const economicsByNetuid = new Map<number, Record<string, unknown>>();
  for (const row of economicsRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    economicsByNetuid.set(netuid as number, {
      registration_cost_tao: coerceD1Number(row.registration_cost_tao),
      registration_allowed: row.registration_allowed,
      open_slots: coerceD1Number(row.open_slots),
      emission_share: coerceD1Number(row.emission_share),
      alpha_price_tao: coerceD1Number(row.alpha_price_tao),
      validator_count: coerceD1Number(row.validator_count),
      miner_count: coerceD1Number(row.miner_count),
      total_stake_tao: coerceD1Number(row.total_stake_tao),
      miner_readiness: coerceD1Number(row.miner_readiness),
    });
  }
  const healthByNetuid = new Map<number, Record<string, unknown>>();
  for (const row of healthRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    healthByNetuid.set(netuid as number, {
      surface_count: coerceD1Number(row.surface_count),
      ok_count: coerceD1Number(row.ok_count),
      avg_latency_ms: coerceD1Number(row.avg_latency_ms),
    });
  }

  const subnets: CompareSubnetEntry[] = requestedNetuids.map((netuid) => {
    const meta = subnetMeta.get(netuid) || null;
    const entry: CompareSubnetEntry = {
      netuid,
      name: meta?.name ?? null,
      slug: meta?.slug ?? null,
      found: meta !== null,
    };
    if (includeStructure) {
      entry.structure = meta ? (structureByNetuid.get(netuid) ?? null) : null;
    }
    if (includeEconomics) {
      entry.economics = meta ? (economicsByNetuid.get(netuid) ?? null) : null;
    }
    if (includeHealth) {
      entry.health = meta ? (healthByNetuid.get(netuid) ?? null) : null;
    }
    return entry;
  });

  return {
    schema_version: 1,
    source: "registry+economics+live-cron-prober",
    observed_at: observedAt ?? null,
    dimensions,
    requested_netuids: requestedNetuids,
    subnets,
  };
}

export async function handleCompare(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, ["netuids", "dimensions"]);
  if (validationError) return analyticsQueryError(validationError);

  const netuidsRaw = url.searchParams.get("netuids");
  const requestedNetuids = parseCompareNetuids(netuidsRaw);
  if (!requestedNetuids) {
    return errorResponse(
      "invalid_query",
      "netuids is required: a comma-separated list of 1-128 subnet ids.",
      400,
      { parameter: "netuids" },
    );
  }

  const dimensionsRaw = url.searchParams.get("dimensions");
  const dimensions = parseCompareDimensions(dimensionsRaw);
  if (!dimensions) {
    const tokens = (dimensionsRaw || "").split(",").map((d) => d.trim());
    const unknown =
      tokens.find((d) => d === "") ??
      tokens.find((d) => !COMPARE_DIMENSIONS.includes(d));
    return errorResponse(
      "invalid_query",
      unknown === ""
        ? "dimensions must not contain empty entries."
        : `Unknown dimension "${unknown}". Valid dimensions: ${COMPARE_DIMENSIONS.join(", ")}.`,
      400,
      { parameter: "dimensions" },
    );
  }

  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);
  // The health dimension is backed by surface_status via a Postgres mirror
  // (#4832 gap-closure). handleCompare has no clean 1:1 D1 route to forward,
  // so it synthesizes its own internal request the same way a
  // syncXToPostgres write helper builds one, rather than forwarding the
  // caller's netuids=/dimensions= request unchanged (tryPostgresTier's usual
  // contract). D1 fully eliminated (2026-07-17): a tier miss now always
  // falls through to an empty row set (never a live D1 query).
  let healthIsFallback = false;
  const healthPromise = dimensions.includes("health")
    ? (async () => {
        const pgUrl = new URL(request.url);
        pgUrl.pathname = "/api/v1/internal/compare-health";
        pgUrl.search = `?netuids=${requestedNetuids.join(",")}`;
        const pgData = await tryPostgresTier(
          env,
          new Request(pgUrl),
          "METAGRAPH_HEALTH_SOURCE",
        );
        if (pgData)
          return pgData.rows as Array<Record<string, unknown>> | undefined;
        healthIsFallback = true;
        return [];
      })()
    : null;
  const [economicsRows, healthRows] = await Promise.all([
    dimensions.includes("economics") ? resolveEconomicsRows(env) : null,
    healthPromise,
  ]);

  const meta = await readHealthMetaKv(env);
  const data = composeCompareData({
    requestedNetuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows: economicsRows as Array<Record<string, unknown>> | null,
    healthRows,
    observedAt: meta?.last_run_at ?? null,
  });
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/compare.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        source: "registry+economics+live-cron-prober",
      },
    },
    "standard",
  );
  return healthIsFallback ? markD1FallbackResponse(response) : response;
}

// Shared input for both domain-rollup routes below: the subnets index (netuid
// -> categories/derived_categories) joined against the live economics tier
// (netuid -> total_stake_tao/emission_share), mirroring resolveEconomicsRows'
// own live-KV-first/R2-fallback precedence. `captured_at` comes from whichever
// tier actually supplied economicsRows, matching network-economics.mjs's own
// `data.captured_at` convention -- the domain rollup is only as fresh as the
// economics side (subnets.json's own domain tags change far less often).
async function domainSummaryInputs(env: Env): Promise<{
  subnetRows: unknown[];
  economicsRows: unknown[];
  capturedAt: unknown;
}> {
  const live = (await resolveLiveEconomics({
    readHealthKv: (e: Env) => readEconomicsCurrentKv(e),
    env,
    contractVersion: contractVersion(env),
  })) as { data?: { subnets?: unknown[]; captured_at?: unknown } } | null;
  let economicsRows: unknown[] = [];
  let capturedAt: unknown = null;
  if (Array.isArray(live?.data?.subnets)) {
    economicsRows = live.data.subnets;
    // No `?? null` needed here: resolveLiveEconomics only ever returns a blob
    // whose captured_at already parsed as a valid date (its own freshness
    // gate), so this is always a real string, never null/undefined.
    capturedAt = live.data.captured_at;
  } else {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    const artifactData = artifact.ok
      ? (artifact.data as { subnets?: unknown[]; captured_at?: unknown })
      : undefined;
    if (Array.isArray(artifactData?.subnets)) {
      economicsRows = artifactData.subnets;
      capturedAt = artifactData.captured_at ?? null;
    }
  }
  const subnetsArtifact = await readArtifact(env, "/metagraph/subnets.json");
  const subnetsArtifactData = subnetsArtifact.ok
    ? (subnetsArtifact.data as { subnets?: unknown[] })
    : undefined;
  const subnetRows = Array.isArray(subnetsArtifactData?.subnets)
    ? subnetsArtifactData.subnets
    : [];
  return { subnetRows, economicsRows, capturedAt };
}

// GET /api/v1/domains (#6749/#6750): every domain tag's rollup in one call --
// the DefiLlama-style aggregation layer over the existing 14-tag domain/
// capability taxonomy (src/domain-tags.ts), already exposed read-only via
// ?domain= on /api/v1/subnets. No new capture: pure composition of the
// subnets index + economics tier, same registry+economics pattern
// handleCompare uses above.
export async function handleDomains(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);

  const { subnetRows, economicsRows, capturedAt } =
    await domainSummaryInputs(env);
  const data = buildDomainOverview(
    subnetRows as Array<Record<string, unknown>>,
    economicsRows as Array<Record<string, unknown>>,
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/domains.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: capturedAt,
        source: "registry+economics",
      },
    },
    "standard",
  );
}

// GET /api/v1/domains/{tag}/summary (#6749/#6750): one domain tag's own
// rollup -- subnet_count, total_stake_tao, total_emission_share, and
// emission_concentration across just that tag's member subnets. `tag` is a
// path segment against the SAME fixed 14-tag enum ?domain= already validates
// (src/contracts.mjs's `enumSchema(DOMAIN_TAGS)`), so an unknown tag is a
// 400, not a 404 -- it's a malformed identifier against a known enum, not a
// resource lookup miss.
export async function handleDomainSummary(
  request: Request,
  env: Env,
  tag: string,
): Promise<Response> {
  const url = new URL(request.url);
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  if (!DOMAIN_TAGS.includes(tag)) {
    return errorResponse(
      "invalid_request",
      `Unknown domain tag "${tag}". Valid tags: ${DOMAIN_TAGS.join(", ")}.`,
      400,
      { parameter: "tag" },
    );
  }

  const { subnetRows, economicsRows, capturedAt } =
    await domainSummaryInputs(env);
  const data = buildDomainSummary(
    tag,
    subnetRows as Array<Record<string, unknown>>,
    economicsRows as Array<Record<string, unknown>>,
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: `/metagraph/domains/${tag}/summary.json`,
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: capturedAt,
        source: "registry+economics",
      },
    },
    "standard",
  );
}

// A per-hotkey internal request pointed at /api/v1/validators/{hotkey},
// synthesized from the incoming /api/v1/compare/validators request the same
// way handleCompare's own health branch above builds its internal request --
// tryPostgresTier just forwards whatever Request it's given.
function validatorDetailRequest(request: Request, hotkey: string): Request {
  const pgUrl = new URL(request.url);
  pgUrl.pathname = `/api/v1/validators/${encodeURIComponent(hotkey)}`;
  pgUrl.search = "";
  return new Request(pgUrl);
}

// GET /api/v1/compare/validators?hotkeys=...&netuid= (#6325): place several
// validators side by side for a stake/delegate decision, mirroring the
// compare_validators MCP tool one-for-one -- same hotkey-list contract
// (parseCompareHotkeys/COMPARE_VALIDATORS_MAX, shared with the MCP tool's own
// parseCompareHotkeyList in src/analytics-live.mjs), same per-hotkey
// tryPostgresTier(METAGRAPH_NEURONS_SOURCE) ?? buildValidatorDetail([], hotkey)
// fallback contract handleValidatorDetail uses, and the identical
// composeValidatorComparison projection so REST and MCP never drift. netuid is
// optional subnet context, same as the MCP tool's own netuid arg.
export async function handleCompareValidators(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const validationError = validateQueryParams(url, ["hotkeys", "netuid"]);
  if (validationError) return analyticsQueryError(validationError);

  const hotkeysRaw = url.searchParams.get("hotkeys");
  const hotkeys = parseCompareHotkeys(hotkeysRaw);
  if (!hotkeys) {
    return errorResponse(
      "invalid_query",
      `hotkeys is required: a comma-separated list of 1-${COMPARE_VALIDATORS_MAX} distinct SS58 validator addresses.`,
      400,
      { parameter: "hotkeys" },
    );
  }

  const netuidResult = parseNonNegativeIntParam(
    url.searchParams.get("netuid"),
    "netuid",
  );
  if ("error" in netuidResult) return analyticsQueryError(netuidResult.error);

  // Sequential, not parallel -- matches compare_validators' own fan-out
  // pattern exactly (N individual get_validator_detail-shaped loads), rather
  // than diverging into a REST-only concurrency strategy.
  const details: Array<ReturnType<typeof buildValidatorDetail>> = [];
  let latestCapturedAt: unknown = null;
  for (const hotkey of hotkeys) {
    const detail =
      ((await tryPostgresTier(
        env,
        validatorDetailRequest(request, hotkey),
        "METAGRAPH_NEURONS_SOURCE",
      )) as ReturnType<typeof buildValidatorDetail> | null) ??
      buildValidatorDetail([], hotkey);
    details.push(detail);
    if (
      detail.captured_at &&
      (latestCapturedAt == null || detail.captured_at > latestCapturedAt)
    ) {
      latestCapturedAt = detail.captured_at;
    }
  }

  const data = composeValidatorComparison(details, {
    netuid: netuidResult.value,
  } as unknown as Parameters<typeof composeValidatorComparison>[1]);
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/compare/validators.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: latestCapturedAt,
        source: "neurons",
      },
    },
    "standard",
  );
}
