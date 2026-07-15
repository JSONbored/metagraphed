// Deferred D1-backed analytics handlers extracted from workers/api.mjs (#1763,
// continuation). Trajectory, uptime, leaderboards, and compare share the
// fileless-D1 pattern: live SQL + registry projections, schema-stable empty
// payloads on cold D1, and the D1-fallback WeakSet contract owned by
// analytics.mjs.
//
// Dependency wiring mirrors configureAnalytics: the in-isolate memoized KV reads
// (`readHealthMetaKv`, `readEconomicsCurrentKv`) stay in api.mjs and are
// injected once at module-init so this file never imports api.mjs back.

import { DAY_MS, MAX_UPTIME_ROWS, UPTIME_WINDOWS } from "../config.mjs";
import { tryPostgresTier } from "../postgres-tier.mjs";
import { csvRequested, csvResponse } from "../csv.mjs";
import { errorResponse } from "../http.mjs";
import { readArtifact } from "../storage.mjs";
import { contractVersion, envelopeResponse } from "../responses.mjs";
import {
  analyticsMeta,
  analyticsQueryError,
  d1All,
  hasD1FallbackRows,
  markD1FallbackResponse,
  validateQueryParams,
} from "./analytics.mjs";
import {
  dailyLatencyColumns,
  surfaceStatusAvgLatencySql,
} from "../../src/health-sql.mjs";
import {
  parseLimitParam,
  parseNonNegativeIntParam,
} from "../request-params.mjs";
import {
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "../../src/neuron-history.mjs";
import { loadEconomicsTrends } from "../../src/economics-trends.mjs";
import { growthRowsFromSamples } from "../../src/analytics-live.mjs";
import {
  formatLeaderboards,
  formatTrajectory,
  formatUptime,
  LEADERBOARD_BOARDS,
  resolveLiveEconomics,
} from "../../src/health-serving.mjs";

let readHealthMetaKv = () => {
  throw new Error("analytics routes used before configureAnalyticsRoutes()");
};
let readEconomicsCurrentKv = () => {
  throw new Error("analytics routes used before configureAnalyticsRoutes()");
};

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

function uptimeCsvRows(surfaces) {
  return (Array.isArray(surfaces) ? surfaces : []).flatMap((surface) =>
    (Array.isArray(surface?.days) ? surface.days : []).map((d) => ({
      surface_id: surface.surface_id,
      day: d.day,
      samples: d.samples,
      uptime_ratio: d.uptime_ratio,
      avg_latency_ms: d.avg_latency_ms,
      latency_sample_count: d.latency_sample_count,
      p50: d.latency_ms?.p50 ?? null,
      p95: d.latency_ms?.p95 ?? null,
      p99: d.latency_ms?.p99 ?? null,
      status: d.status,
    })),
  );
}

function validateFormatParam(url) {
  const raw = url.searchParams.get("format");
  if (raw === null && !url.searchParams.has("format")) return null;
  const normalized = String(raw || "").toLowerCase();
  if (RESPONSE_FORMATS.includes(normalized)) return null;
  return {
    parameter: "format",
    message: `format must be one of: ${RESPONSE_FORMATS.join(", ")}.`,
  };
}

function economicsTrendsCacheVariant(url, request, canonicalPath) {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  // canonicalEconomicsTrendsCachePath always supplies ?window=…, so & is safe.
  return `${canonicalPath}&format=csv`;
}

function trajectoryCacheVariant(url, request, canonicalPath) {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  return `${canonicalPath}?format=csv`;
}

function uptimeCacheVariant(url, request, canonicalPath) {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv =
    format === "csv" || (request != null && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  // canonicalUptimeCachePath always supplies ?window=…, so & is safe.
  return `${canonicalPath}&format=csv`;
}

export function configureAnalyticsRoutes(deps) {
  readHealthMetaKv = deps.readHealthMetaKv;
  readEconomicsCurrentKv = deps.readEconomicsCurrentKv;
}

const LEADERBOARD_PROFILES_TTL_MS = 300_000;
let leaderboardProfilesCache = null; // { subnetMeta, mostComplete, builtAt }

const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

async function envelopeWithD1Fallback(request, payload, cacheProfile, rowSets) {
  const response = await envelopeResponse(request, payload, cacheProfile);
  return hasD1FallbackRows(...rowSets)
    ? markD1FallbackResponse(response)
    : response;
}

// Week-over-week structural trajectory from daily snapshots.
export async function handleTrajectory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE (deliberately
  // unflipped -- subnet_snapshots has no historical backfill, only started
  // accumulating from writeSubnetSnapshot's dual-write landing, same
  // rationale as METAGRAPH_HEALTH_SOURCE's own header comment). A Postgres
  // hit never reaches d1All, so it can never be marked a fallback.
  let isFallback = false;
  let data = await tryPostgresTier(
    env,
    request,
    "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
  );
  if (!data) {
    const rows = await d1All(
      env,
      `SELECT snapshot_date, completeness_score, surface_count, endpoint_count,
              validator_count, miner_count, total_stake_tao, alpha_price_tao,
              emission_share, tao_in_pool_tao, alpha_in_pool, alpha_out_pool,
              subnet_volume_tao
       FROM subnet_snapshots
       WHERE netuid = ?
       ORDER BY snapshot_date DESC
       LIMIT 400`,
      [netuid],
    );
    data = formatTrajectory({ netuid, rows });
    isFallback = hasD1FallbackRows(rows);
  }
  if (csvRequested(url, request)) {
    const csvRes = csvResponse(
      data.points,
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
export async function handleEconomicsTrends(request, env, url) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same table
  // and same deliberately-unflipped rationale as handleTrajectory above.
  let isFallback = false;
  let data = await tryPostgresTier(
    env,
    request,
    "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
  );
  if (!data) {
    const loaded = await loadEconomicsTrends(
      (sql, params) => d1All(env, sql, params),
      { windowLabel: label, windowDays: days },
    );
    data = loaded.data;
    isFallback = hasD1FallbackRows(loaded.rows);
  }
  if (csvRequested(url, request)) {
    const csvRes = csvResponse(
      data.days,
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
export async function handleUptime(request, env, netuid, url) {
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
  const minSamples = parseNonNegativeIntParam(
    url.searchParams.get("min_samples"),
    "min_samples",
  );
  if (minSamples.error) return analyticsQueryError(minSamples.error);
  const days = UPTIME_WINDOWS[windowParam];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  // #4832 gap-closure follow-up: reuses METAGRAPH_HEALTH_SOURCE (same table
  // as the bulk-trends/trends/percentiles/incidents routes in analytics.mjs,
  // deliberately unflipped pending Postgres accumulating a real history
  // window -- see handleBulkHealthTrends' own header comment there).
  let isFallback = false;
  let data = await tryPostgresTier(env, request, "METAGRAPH_HEALTH_SOURCE");
  if (!data) {
    const rows = await d1All(
      env,
      `SELECT MAX(surface_id) AS surface_id,
              COALESCE(surface_key, surface_id) AS surface_key,
              day,
              SUM(samples) AS samples,
              SUM(ok_count) AS ok_count,
              CASE
                WHEN SUM(samples) > 0 THEN ROUND(CAST(SUM(ok_count) AS REAL) / SUM(samples), 4)
                ELSE NULL
              END AS uptime_ratio,
              ${dailyLatencyColumns({ roundedAvg: true })},
              MAX(p50_latency_ms) AS p50,
              MAX(p95_latency_ms) AS p95,
              MAX(p99_latency_ms) AS p99,
              CASE
                WHEN SUM(samples) = 0 THEN 'unknown'
                WHEN SUM(ok_count) = SUM(samples) THEN 'ok'
                WHEN SUM(ok_count) = 0 THEN 'failed'
                ELSE 'degraded'
              END AS status
       FROM surface_uptime_daily
       WHERE netuid = ? AND day >= ?
       GROUP BY COALESCE(surface_key, surface_id), day
       ${minSamples.value !== null ? "HAVING SUM(samples) >= ?\n       " : ""}ORDER BY day DESC
       LIMIT ?`,
      minSamples.value !== null
        ? [netuid, cutoff, minSamples.value, MAX_UPTIME_ROWS]
        : [netuid, cutoff, MAX_UPTIME_ROWS],
    );
    const healthMeta = await readHealthMetaKv(env);
    data = formatUptime({
      netuid,
      window: windowParam,
      observedAt: healthMeta?.last_run_at || null,
      rows,
      now: new Date().toISOString(),
    });
    isFallback = hasD1FallbackRows(rows);
  }
  if (csvRequested(url, request)) {
    const csvRes = csvResponse(
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
export function canonicalUptimeCachePath(url, request = null) {
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
  const minSamples = parseNonNegativeIntParam(
    url.searchParams.get("min_samples"),
    "min_samples",
  );
  if (minSamples.error) return `${url.pathname}${url.search}`;
  const params = [`window=${encodeURIComponent(windowParam)}`];
  if (minSamples.value !== null) params.push(`min_samples=${minSamples.value}`);
  return uptimeCacheVariant(
    url,
    request,
    `${url.pathname}?${params.join("&")}`,
  );
}

// Normalises the economics-trends URL so that a bare ?-free request and an explicit
// ?window=30d request both resolve to the same edge-cache entry — mirrors
// canonicalSubnetHistoryCachePath in entities.mjs.
export function canonicalEconomicsTrendsCachePath(url, request = null) {
  const validationError = validateQueryParams(url, ["window", "format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateFormatParam(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return `${url.pathname}${url.search}`;
  return economicsTrendsCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

// Normalises the per-subnet trajectory URL so JSON and CSV variants get distinct
// edge-cache entries — mirrors canonicalEconomicsTrendsCachePath.
export function canonicalTrajectoryCachePath(url, request = null) {
  const validationError = validateQueryParams(url, ["format"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const formatError = validateFormatParam(url);
  if (formatError) return `${url.pathname}${url.search}`;
  return trajectoryCacheVariant(url, request, url.pathname);
}

// Normalises the leaderboards URL so that a bare ?-free request and an explicit
// ?limit=20 request both resolve to the same edge-cache entry — mirrors
// canonicalCompareCachePath and canonicalUptimeCachePath.
export function canonicalLeaderboardsCachePath(url) {
  const validationError = validateQueryParams(url, ["board", "limit"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const parsedLimit = parseLimitParam(url, { defaultLimit: 20, maxLimit: 100 });
  if (parsedLimit.error) {
    return `${url.pathname}${url.search}`;
  }
  const board = url.searchParams.get("board");
  if (board && !LEADERBOARD_BOARDS.includes(board)) {
    return `${url.pathname}${url.search}`;
  }
  const cap = parsedLimit.limit;
  const params = [`limit=${cap}`];
  if (board) params.unshift(`board=${encodeURIComponent(board)}`);
  return `${url.pathname}?${params.join("&")}`;
}

async function leaderboardProfilesProjection(env, now = Date.now()) {
  if (
    leaderboardProfilesCache &&
    now - leaderboardProfilesCache.builtAt <= LEADERBOARD_PROFILES_TTL_MS
  ) {
    return leaderboardProfilesCache;
  }
  const artifact = await readArtifact(env, "/metagraph/profiles.json");
  const profiles = artifact.ok ? artifact.data?.profiles || [] : [];
  const subnetMeta = new Map();
  const mostComplete = [];
  for (const profile of profiles) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid, {
      slug: profile.slug ?? null,
      name: profile.name ?? null,
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

async function resolveEconomicsRows(env) {
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readEconomicsCurrentKv(e),
    env,
    contractVersion: contractVersion(env),
  });
  if (Array.isArray(live?.data?.subnets)) return live.data.subnets;
  const artifact = await readArtifact(env, "/metagraph/economics.json");
  return artifact.ok && Array.isArray(artifact.data?.subnets)
    ? artifact.data.subnets
    : [];
}

/**
 * Compose the registry-leaderboards payload: the profiles projection plus the
 * D1 health/rpc/growth/reliability reads and the economics tier, folded through
 * formatLeaderboards.
 *
 * Split out of handleLeaderboards so the GraphQL mirror
 * (Query.registry_leaderboards, #5661) reuses this exact projection instead of
 * duplicating the D1 queries. Callers own argument validation and response
 * wrapping; this only builds the payload. `d1Rows` is returned alongside it
 * because the HTTP path needs the raw row-sets for its cold-store fallback
 * signal — GraphQL ignores them.
 */
export async function composeLeaderboardsData(
  env,
  { board = null, limit = 20 } = {},
) {
  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // `fastest-growing` uses a short completeness window; `most-reliable` is
  // intentionally more durable and ranks the last 30d of uptime history.
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples, economicsRows, reliabilityRows] =
    await Promise.all([
      d1All(
        env,
        `SELECT netuid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              ${surfaceStatusAvgLatencySql()} AS avg_latency_ms
       FROM surface_status
       GROUP BY netuid`,
        [],
      ),
      d1All(
        env,
        `SELECT netuid, MIN(latency_ms) AS min_latency_ms
       FROM surface_status
       WHERE kind IN ('subtensor-rpc', 'subtensor-wss')
         AND status = 'ok' AND latency_ms IS NOT NULL
       GROUP BY netuid`,
        [],
      ),
      d1All(
        env,
        `SELECT netuid, snapshot_date, completeness_score
       FROM subnet_snapshots
       WHERE snapshot_date >= ?
       ORDER BY netuid, snapshot_date`,
        [sevenDaysAgo],
      ),
      resolveEconomicsRows(env),
      d1All(
        env,
        `SELECT netuid,
              SUM(samples) AS samples,
              SUM(ok_count) AS ok_count,
              ${dailyLatencyColumns({ roundedAvg: true })}
       FROM surface_uptime_daily
       WHERE day >= ?
       GROUP BY netuid`,
        [thirtyDaysAgo],
      ),
    ]);

  const growthRows = growthRowsFromSamples(growthSamples);

  const meta = await readHealthMetaKv(env);
  const data = formatLeaderboards({
    board,
    limit,
    observedAt: meta?.last_run_at || null,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows,
    reliabilityRows,
    economicsRows,
    subnetMeta,
  });
  return {
    data,
    d1Rows: [healthRows, rpcRows, growthSamples, reliabilityRows],
  };
}

export async function handleLeaderboards(request, env, url) {
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
  const parsedLimit = parseLimitParam(url, { defaultLimit: 20, maxLimit: 100 });
  if (parsedLimit.error) {
    return errorResponse("invalid_query", parsedLimit.error.message, 400);
  }

  const { data, d1Rows } = await composeLeaderboardsData(env, {
    board: requestedBoard || null,
    limit: parsedLimit.limit,
  });
  return envelopeWithD1Fallback(
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
    d1Rows,
  );
}

function compareNetuids(netuidsRaw) {
  if (!netuidsRaw || !COMPARE_NETUIDS_PATTERN.test(netuidsRaw)) return null;
  const requestedNetuids = [];
  const seenNetuids = new Set();
  for (const part of netuidsRaw.split(",")) {
    const netuid = Number(part);
    if (seenNetuids.has(netuid)) continue;
    seenNetuids.add(netuid);
    requestedNetuids.push(netuid);
  }
  return requestedNetuids;
}

function compareDimensions(dimensionsRaw) {
  if (dimensionsRaw === null) return COMPARE_DIMENSIONS;
  const requested = [];
  for (const part of dimensionsRaw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") return null;
    requested.push(trimmed);
  }
  const unknown = requested.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
}

export function canonicalCompareCachePath(url) {
  if (validateQueryParams(url, ["netuids", "dimensions"])) return null;
  const requestedNetuids = compareNetuids(url.searchParams.get("netuids"));
  if (!requestedNetuids) return null;
  const dimensions = compareDimensions(url.searchParams.get("dimensions"));
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
function coerceD1Number(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : value;
}

export function composeCompareData({
  requestedNetuids,
  dimensions,
  subnetMeta,
  structureRows,
  economicsRows,
  healthRows,
  observedAt,
}) {
  const includeStructure = dimensions.includes("structure");
  const includeEconomics = dimensions.includes("economics");
  const includeHealth = dimensions.includes("health");

  const structureByNetuid = new Map();
  for (const row of structureRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    structureByNetuid.set(netuid, {
      completeness_score: coerceD1Number(row.completeness_score),
      surface_count: coerceD1Number(row.surface_count),
      operational_interface_count: coerceD1Number(
        row.operational_interface_count,
      ),
    });
  }
  const economicsByNetuid = new Map();
  for (const row of economicsRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    economicsByNetuid.set(netuid, {
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
  const healthByNetuid = new Map();
  for (const row of healthRows || []) {
    const netuid = coerceD1Number(row.netuid);
    if (!Number.isInteger(netuid)) continue;
    healthByNetuid.set(netuid, {
      surface_count: coerceD1Number(row.surface_count),
      ok_count: coerceD1Number(row.ok_count),
      avg_latency_ms: coerceD1Number(row.avg_latency_ms),
    });
  }

  const subnets = requestedNetuids.map((netuid) => {
    const meta = subnetMeta.get(netuid) || null;
    const entry = {
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

export async function handleCompare(request, env, url) {
  const validationError = validateQueryParams(url, ["netuids", "dimensions"]);
  if (validationError) return analyticsQueryError(validationError);

  const netuidsRaw = url.searchParams.get("netuids");
  const requestedNetuids = compareNetuids(netuidsRaw);
  if (!requestedNetuids) {
    return errorResponse(
      "invalid_query",
      "netuids is required: a comma-separated list of 1-128 subnet ids.",
      400,
      { parameter: "netuids" },
    );
  }

  const dimensionsRaw = url.searchParams.get("dimensions");
  const dimensions = compareDimensions(dimensionsRaw);
  if (!dimensions) {
    const tokens = dimensionsRaw.split(",").map((d) => d.trim());
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
  // The health dimension is the only one of the three backed by a table with
  // a Postgres mirror (surface_status, #4832 gap-closure) -- structure/
  // economics stay D1-only. handleCompare has no clean 1:1 D1 route to
  // forward, so it synthesizes its own internal request the same way a
  // syncXToPostgres write helper builds one, rather than forwarding the
  // caller's netuids=/dimensions= request unchanged (tryPostgresTier's usual
  // contract).
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
        if (pgData) return pgData.rows;
        const rows = await d1All(
          env,
          `SELECT netuid,
                COUNT(*) AS surface_count,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                ${surfaceStatusAvgLatencySql({ rounded: true })} AS avg_latency_ms
         FROM surface_status
         WHERE netuid IN (${requestedNetuids.map(() => "?").join(", ")})
         GROUP BY netuid`,
          requestedNetuids,
        );
        healthIsFallback = hasD1FallbackRows(rows);
        return rows;
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
    economicsRows,
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
