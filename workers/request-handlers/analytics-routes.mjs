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
import { dailyLatencyColumns } from "../../src/health-sql.mjs";
import {
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "../../src/neuron-history.mjs";
import { loadEconomicsTrends } from "../../src/economics-trends.mjs";
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
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const rows = await d1All(
    env,
    `SELECT snapshot_date, completeness_score, surface_count, endpoint_count,
            validator_count, miner_count, total_stake_tao, alpha_price_tao,
            emission_share
     FROM subnet_snapshots
     WHERE netuid = ?
     ORDER BY snapshot_date DESC
     LIMIT 400`,
    [netuid],
  );
  const data = formatTrajectory({ netuid, rows });
  return envelopeWithD1Fallback(
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
    [rows],
  );
}

// Network-wide economics time series (#1307): aggregate the per-subnet daily
// subnet_snapshots rows up to one point per UTC day across every subnet (total
// stake, stake-weighted + median alpha price, total validator/miner counts, mean
// emission share). Same source as the per-subnet trajectory; raw rows (not a GROUP
// BY) so the weighted/median price is computed in the pure builder. Schema-stable
// (day_count:0, days:[]) on a cold rollup. Bounded by ECONOMICS_TRENDS_ROW_CAP.
export async function handleEconomicsTrends(request, env, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const { data, rows } = await loadEconomicsTrends(
    (sql, params) => d1All(env, sql, params),
    { windowLabel: label, windowDays: days },
  );
  return envelopeWithD1Fallback(
    request,
    {
      data,
      meta: await analyticsMeta(env, "/metagraph/economics/trends.json", null),
    },
    "short",
    [rows],
  );
}

// Long-term daily uptime history for one subnet's operational surfaces.
export async function handleUptime(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam = url.searchParams.get("window") || "90d";
  if (!Object.hasOwn(UPTIME_WINDOWS, windowParam)) {
    return analyticsQueryError({
      parameter: "window",
      message: unsupportedWindowMessage(windowParam, UPTIME_WINDOWS),
    });
  }
  const days = UPTIME_WINDOWS[windowParam];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
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
     ORDER BY day DESC
     LIMIT ?`,
    [netuid, cutoff, MAX_UPTIME_ROWS],
  );
  const healthMeta = await readHealthMetaKv(env);
  const data = formatUptime({
    netuid,
    window: windowParam,
    observedAt: healthMeta?.last_run_at || null,
    rows,
    now: new Date().toISOString(),
  });
  return envelopeWithD1Fallback(
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
    [rows],
  );
}

// Normalises the uptime URL so that a bare ?-free request and an explicit
// ?window=90d request both resolve to the same edge-cache entry — mirrors
// canonicalSubnetConcentrationHistoryCachePath in entities.mjs.
export function canonicalUptimeCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam = url.searchParams.get("window") || "90d";
  if (!Object.hasOwn(UPTIME_WINDOWS, windowParam))
    return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// Normalises the economics-trends URL so that a bare ?-free request and an explicit
// ?window=30d request both resolve to the same edge-cache entry — mirrors
// canonicalSubnetHistoryCachePath in entities.mjs.
export function canonicalEconomicsTrendsCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = parseHistoryWindow(url.searchParams.get("window"));
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

// Normalises the leaderboards URL so that a bare ?-free request and an explicit
// ?limit=20 request both resolve to the same edge-cache entry — mirrors
// canonicalCompareCachePath and canonicalUptimeCachePath.
export function canonicalLeaderboardsCachePath(url) {
  const validationError = validateQueryParams(url, ["board", "limit"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const limit = url.searchParams.get("limit");
  if (
    limit !== null &&
    (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
  ) {
    return `${url.pathname}${url.search}`;
  }
  const board = url.searchParams.get("board");
  if (board && !LEADERBOARD_BOARDS.includes(board)) {
    return `${url.pathname}${url.search}`;
  }
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
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
  const limit = url.searchParams.get("limit");
  if (
    limit !== null &&
    (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
  ) {
    return errorResponse(
      "invalid_query",
      "limit must be an integer between 1 and 100.",
      400,
    );
  }

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
              AVG(latency_ms) AS avg_latency_ms
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

  const growthByNetuid = new Map();
  for (const row of growthSamples) {
    const entry = growthByNetuid.get(row.netuid) || {
      first: undefined,
      last: undefined,
    };
    if (entry.first === undefined) entry.first = row.completeness_score ?? null;
    entry.last = row.completeness_score ?? null;
    growthByNetuid.set(row.netuid, entry);
  }
  const growthRows = [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));

  const meta = await readHealthMetaKv(env);
  const data = formatLeaderboards({
    board: requestedBoard || null,
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
    [healthRows, rpcRows, growthSamples, reliabilityRows],
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
    structureByNetuid.set(row.netuid, {
      completeness_score: row.completeness_score,
      surface_count: row.surface_count,
      operational_interface_count: row.operational_interface_count,
    });
  }
  const economicsByNetuid = new Map();
  for (const row of economicsRows || []) {
    economicsByNetuid.set(row.netuid, {
      registration_cost_tao: row.registration_cost_tao,
      registration_allowed: row.registration_allowed,
      open_slots: row.open_slots,
      emission_share: row.emission_share,
      alpha_price_tao: row.alpha_price_tao,
      validator_count: row.validator_count,
      miner_count: row.miner_count,
      total_stake_tao: row.total_stake_tao,
      miner_readiness: row.miner_readiness,
    });
  }
  const healthByNetuid = new Map();
  for (const row of healthRows || []) {
    healthByNetuid.set(row.netuid, {
      surface_count: row.surface_count,
      ok_count: row.ok_count,
      avg_latency_ms: row.avg_latency_ms,
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
  const [economicsRows, healthRows] = await Promise.all([
    dimensions.includes("economics") ? resolveEconomicsRows(env) : null,
    dimensions.includes("health")
      ? d1All(
          env,
          `SELECT netuid,
                COUNT(*) AS surface_count,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                ROUND(AVG(latency_ms)) AS avg_latency_ms
         FROM surface_status
         WHERE netuid IN (${requestedNetuids.map(() => "?").join(", ")})
         GROUP BY netuid`,
          requestedNetuids,
        )
      : null,
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
  return envelopeWithD1Fallback(
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
    [healthRows],
  );
}
