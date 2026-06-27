// Shared live analytics loaders for MCP tools (#1958).
//
// Pure orchestration over D1 rows + registry projections. REST handlers stay in
// workers/request-handlers/analytics-routes.mjs (#1919); MCP tools call these
// loaders so agents get REST parity without duplicating SQL paths.

import { dailyLatencyColumns } from "./health-sql.mjs";
import {
  formatGlobalIncidents,
  formatLeaderboards,
  formatUptime,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "./health-serving.mjs";
import {
  ANALYTICS_WINDOWS,
  DAY_MS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
  MAX_UPTIME_ROWS,
  UPTIME_WINDOWS,
} from "../workers/config.mjs";
import { composeCompareData } from "../workers/request-handlers/analytics-routes.mjs";

export { composeCompareData };
export const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

export function profilesProjectionFromRows(profiles) {
  const subnetMeta = new Map();
  const mostComplete = [];
  for (const profile of profiles || []) {
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
  return { subnetMeta, mostComplete };
}

export function growthRowsFromSamples(growthSamples) {
  const growthByNetuid = new Map();
  for (const row of growthSamples || []) {
    const entry = growthByNetuid.get(row.netuid) || {
      first: undefined,
      last: undefined,
    };
    if (entry.first === undefined) entry.first = row.completeness_score ?? null;
    entry.last = row.completeness_score ?? null;
    growthByNetuid.set(row.netuid, entry);
  }
  return [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));
}

export function parseCompareNetuids(netuidsRaw) {
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

export function parseCompareNetuidList(netuids) {
  if (!Array.isArray(netuids) || netuids.length === 0) return null;
  const requestedNetuids = [];
  const seenNetuids = new Set();
  for (const value of netuids) {
    if (!Number.isInteger(value) || value < 0) return null;
    if (seenNetuids.has(value)) continue;
    seenNetuids.add(value);
    requestedNetuids.push(value);
  }
  if (requestedNetuids.length > 128) return null;
  return requestedNetuids;
}

export function parseCompareDimensions(dimensionsRaw) {
  if (dimensionsRaw === null || dimensionsRaw === undefined) {
    return COMPARE_DIMENSIONS;
  }
  const requested = String(dimensionsRaw).split(",");
  const unknown = requested.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
}

export function parseCompareDimensionList(dimensions) {
  if (dimensions === undefined || dimensions === null) {
    return COMPARE_DIMENSIONS;
  }
  if (!Array.isArray(dimensions) || dimensions.length === 0) return null;
  const unknown = dimensions.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => dimensions.includes(d));
}

export async function loadSubnetUptime(
  d1,
  netuid,
  { window = "90d", observedAt = null, now = null } = {},
) {
  const windowParam = Object.hasOwn(UPTIME_WINDOWS, window) ? window : "90d";
  const days = UPTIME_WINDOWS[windowParam];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await d1(
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
  return formatUptime({
    netuid,
    window: windowParam,
    observedAt,
    rows,
    now: now || new Date().toISOString(),
  });
}

export async function loadGlobalIncidents(
  d1,
  { windowLabel = "7d", windowDays = 7, observedAt = null } = {},
) {
  const since = Date.now() - windowDays * DAY_MS;
  const incidentRows = await d1(
    `WITH recent_checks AS (
       SELECT netuid, COALESCE(surface_key, surface_id) AS surface_key, surface_id, checked_at, ok
       FROM surface_checks
       WHERE checked_at >= ?
       ORDER BY checked_at DESC
       LIMIT ?
     ),
     checks AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              checked_at - LAG(checked_at)
                OVER (
                  PARTITION BY netuid, surface_key
                  ORDER BY checked_at
                ) AS gap
       FROM recent_checks
     ),
     grouped AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                OVER (PARTITION BY netuid, surface_key ORDER BY checked_at) AS grp
       FROM checks
     )
     SELECT netuid,
            MAX(surface_id) AS surface_id,
            surface_key,
            MIN(checked_at) AS started_at,
            MAX(checked_at) AS ended_at,
            COUNT(*) AS failed_samples
     FROM grouped
     WHERE ok = 0
     GROUP BY netuid, surface_key, grp
     HAVING COUNT(*) >= ?
     ORDER BY started_at DESC
     LIMIT ?`,
    [
      since,
      MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
      INCIDENT_GAP_MS,
      MIN_INCIDENT_SAMPLES,
      MAX_INCIDENT_ROWS,
    ],
  );
  return formatGlobalIncidents({
    window: windowLabel,
    observedAt,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
}

export async function loadRegistryLeaderboards(
  d1,
  {
    profiles = [],
    economicsRows = [],
    board = null,
    limit = null,
    observedAt = null,
  } = {},
) {
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples] = await Promise.all([
    d1(
      `SELECT netuid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              AVG(latency_ms) AS avg_latency_ms
       FROM surface_status
       GROUP BY netuid`,
      [],
    ),
    d1(
      `SELECT netuid, MIN(latency_ms) AS min_latency_ms
       FROM surface_status
       WHERE kind IN ('subtensor-rpc', 'subtensor-wss')
         AND status = 'ok' AND latency_ms IS NOT NULL
       GROUP BY netuid`,
      [],
    ),
    d1(
      `SELECT netuid, snapshot_date, completeness_score
       FROM subnet_snapshots
       WHERE snapshot_date >= ?
       ORDER BY netuid, snapshot_date`,
      [sevenDaysAgo],
    ),
  ]);
  return formatLeaderboards({
    board,
    limit,
    observedAt,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows: growthRowsFromSamples(growthSamples),
    economicsRows,
    subnetMeta,
  });
}

export async function loadCompareSubnets(
  d1,
  {
    profiles = [],
    economicsRows = [],
    netuids,
    dimensions = COMPARE_DIMENSIONS,
    observedAt = null,
  } = {},
) {
  if (!Array.isArray(netuids) || netuids.length === 0) {
    return composeCompareData({
      requestedNetuids: [],
      dimensions,
      subnetMeta: new Map(),
      structureRows: [],
      economicsRows: dimensions.includes("economics") ? economicsRows : null,
      healthRows: [],
      observedAt,
    });
  }
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  const [healthRows, economics] = await Promise.all([
    dimensions.includes("health")
      ? d1(
          `SELECT netuid,
                COUNT(*) AS surface_count,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                ROUND(AVG(latency_ms)) AS avg_latency_ms
         FROM surface_status
         WHERE netuid IN (${netuids.map(() => "?").join(", ")})
         GROUP BY netuid`,
          netuids,
        )
      : null,
    dimensions.includes("economics") ? economicsRows : null,
  ]);
  return composeCompareData({
    requestedNetuids: netuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows: economics,
    healthRows,
    observedAt,
  });
}

export function parseAnalyticsWindow(window) {
  if (window === null || window === undefined) {
    return { label: "7d", days: ANALYTICS_WINDOWS["7d"] };
  }
  if (!Object.hasOwn(ANALYTICS_WINDOWS, window)) return null;
  return { label: window, days: ANALYTICS_WINDOWS[window] };
}

export function parseUptimeWindow(window) {
  if (window === null || window === undefined) {
    return "90d";
  }
  return Object.hasOwn(UPTIME_WINDOWS, window) ? window : null;
}
