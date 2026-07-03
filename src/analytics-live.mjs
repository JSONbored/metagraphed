// Shared live analytics loaders for MCP tools (#1958).
//
// Pure orchestration over D1 rows + registry projections. REST handlers stay in
// workers/request-handlers/analytics-routes.mjs (#1919); MCP tools call these
// loaders so agents get REST parity without duplicating SQL paths.

import {
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
  surfaceStatusAvgLatencySql,
} from "./health-sql.mjs";
import {
  formatGlobalIncidents,
  formatIncidents,
  formatLeaderboards,
  formatPercentiles,
  formatTrends,
  formatUptime,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "./health-serving.mjs";
import {
  ANALYTICS_WINDOWS,
  DAY_MS,
  HEALTH_TREND_WINDOWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
  MAX_UPTIME_ROWS,
  UPTIME_WINDOWS,
} from "../workers/config.mjs";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
} from "./chain-analytics.mjs";
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
      first: null,
      last: null,
    };
    // Latch the window's first and last *non-null* completeness scores. Rows
    // arrive ordered by (netuid, snapshot_date), so a subnet whose earliest
    // in-window snapshot has no score yet (completeness_score is a nullable
    // INTEGER) must not have `first` pinned to null: the old `=== undefined`
    // guard fired on the first row regardless, so a leading NULL froze `first`
    // at null for the whole subnet, collapsing its delta to null. That silently
    // dropped a genuinely fast-growing subnet from the "fastest-growing"
    // leaderboard, which filters out null deltas. Skipping NULL scores here
    // makes `first`/`last` the first/last real scores (a trailing NULL no
    // longer poisons `last` either); an all-NULL subnet still yields null.
    const score = row.completeness_score ?? null;
    if (score != null) {
      if (entry.first == null) entry.first = score;
      entry.last = score;
    }
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
  return compareDimensionsFromTokens(String(dimensionsRaw).split(","));
}

export function parseCompareDimensionList(dimensions) {
  if (dimensions === undefined || dimensions === null) {
    return COMPARE_DIMENSIONS;
  }
  if (!Array.isArray(dimensions) || dimensions.length === 0) return null;
  return compareDimensionsFromTokens(dimensions);
}

function compareDimensionsFromTokens(tokens) {
  const requested = [];
  for (const token of tokens) {
    const trimmed = String(token).trim();
    if (trimmed === "") return null;
    requested.push(trimmed);
  }
  const unknown = requested.find((d) => !COMPARE_DIMENSIONS.includes(d));
  if (unknown !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
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

// One subnet's 7d/30d uptime + latency trend per operational surface, over the
// ranked-dedup CTE shared with the percentiles/incidents routes. The windows are
// independent reads, so they run in parallel rather than serializing an
// await-in-loop — same shape as REST's handleHealthTrends, which this mirrors.
export async function loadSubnetHealthTrends(
  d1,
  netuid,
  { observedAt = null } = {},
) {
  const nowMs = Date.now();
  const windowRows = await Promise.all(
    Object.entries(HEALTH_TREND_WINDOWS).map(async ([label, days]) => {
      const rows = await d1(
        `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
           SELECT MAX(surface_id) AS surface_id,
                  surface_key,
                  COUNT(*) AS total,
                  SUM(ok) AS ok_count,
                  ${latencyStatColumns({ includeMinMax: false })}
           FROM ranked
           GROUP BY surface_key`,
        [netuid, nowMs - days * DAY_MS],
      );
      return [label, rows];
    }),
  );
  const windows = {};
  for (const [label, rows] of windowRows) {
    windows[label] = rows;
  }
  return formatTrends({ netuid, observedAt, windows });
}

// p50/p95/p99 (+avg/min/max) request-latency percentiles per operational surface
// for one subnet over a 7d/30d window, from the live surface_checks history. The
// query + formatting live here so the REST handler (handleHealthPercentiles) and
// the get_subnet_health_percentiles MCP tool share one read path (mirrors
// loadSubnetHealthTrends, #2335). Defensively defaults an unknown window to 7d;
// cold/empty D1 → a schema-stable surfaces:[] payload.
export async function loadSubnetPercentiles(
  d1,
  netuid,
  { window = "7d", observedAt = null } = {},
) {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const days = ANALYTICS_WINDOWS[windowParam];
  const rows = await d1(
    `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
       SELECT MAX(surface_id) AS surface_id,
              surface_key,
              ${latencyStatColumns()}
       FROM ranked
       GROUP BY surface_key
       HAVING MAX(lat_cnt) > 0`,
    [netuid, Date.now() - days * DAY_MS],
  );
  return formatPercentiles({ netuid, window: windowParam, observedAt, rows });
}

// Per-surface SLA + reconstructed downtime incidents for one subnet over a 7d/30d
// window, from the live surface_checks history: an SLA rollup (samples + uptime
// ratio) joined with gap-island-grouped failure incidents (consecutive failures
// within the incident gap collapse into one, capped per surface). The query +
// formatting live here so the REST handler (handleHealthIncidents) and the
// get_subnet_health_incidents MCP tool share one read path (mirrors
// loadSubnetPercentiles). Unknown window → 7d; cold/empty D1 → surfaces:[].
export async function loadSubnetIncidents(
  d1,
  netuid,
  { window = "7d", observedAt = null } = {},
) {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const since = Date.now() - ANALYTICS_WINDOWS[windowParam] * DAY_MS;
  const [slaRows, incidentRows] = await Promise.all([
    d1(
      `SELECT MAX(surface_id) AS surface_id,
              COALESCE(surface_key, surface_id) AS surface_key,
              COUNT(*) AS total,
              SUM(ok) AS ok_count
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ?
       GROUP BY COALESCE(surface_key, surface_id)`,
      [netuid, since],
    ),
    // Gap-island grouping in SQL: collapse consecutive failures (gap <= the
    // incident threshold) into one incident row, then cap per surface_key so one
    // flappy endpoint cannot starve sibling surfaces in the same subnet.
    d1(
      `WITH checks AS (
         SELECT COALESCE(surface_key, surface_id) AS surface_key,
                surface_id,
                checked_at,
                ok,
                checked_at - LAG(checked_at)
                  OVER (
                    PARTITION BY COALESCE(surface_key, surface_id)
                    ORDER BY checked_at
                  ) AS gap
         FROM surface_checks
         WHERE netuid = ? AND checked_at >= ?
       ),
       grouped AS (
         SELECT surface_key, surface_id, checked_at, ok,
                SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                  OVER (PARTITION BY surface_key ORDER BY checked_at) AS grp
         FROM checks
       ),
       incidents AS (
         SELECT MAX(surface_id) AS surface_id,
                surface_key,
                MIN(checked_at) AS started_at,
                MAX(checked_at) AS ended_at,
                COUNT(*) AS failed_samples
         FROM grouped
         WHERE ok = 0
         GROUP BY surface_key, grp
         HAVING COUNT(*) >= ?
       )
       SELECT surface_id,
              surface_key,
              started_at,
              ended_at,
              failed_samples
       FROM (
         SELECT surface_id,
                surface_key,
                started_at,
                ended_at,
                failed_samples,
                ROW_NUMBER() OVER (
                  PARTITION BY surface_key
                  ORDER BY started_at
                ) AS rn
         FROM incidents
       ) ranked
       WHERE rn <= ?
       ORDER BY surface_id, started_at`,
      [netuid, since, INCIDENT_GAP_MS, MIN_INCIDENT_SAMPLES, MAX_INCIDENT_ROWS],
    ),
  ]);
  return formatIncidents({
    netuid,
    window: windowParam,
    observedAt,
    slaRows,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
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
  // `fastest-growing` uses a short completeness window; `most-reliable` is
  // intentionally more durable and ranks the last 30d of uptime history
  // (mirrors handleLeaderboards in analytics-routes.mjs).
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples, reliabilityRows] =
    await Promise.all([
      d1(
        `SELECT netuid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              ${surfaceStatusAvgLatencySql()} AS avg_latency_ms
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
      d1(
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
  return formatLeaderboards({
    board,
    limit,
    observedAt,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows: growthRowsFromSamples(growthSamples),
    reliabilityRows,
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
                ${surfaceStatusAvgLatencySql({ rounded: true })} AS avg_latency_ms
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

// Extrinsic call-mix breakdown (#1989): counts + share per call_module (or
// call_module/call_function). The share denominator is the full-window extrinsic
// count read separately, so the truncated LIMIT tail never skews shares. Tie-break
// on the GROUP BY keys so tied counts keep a stable LIMIT membership. Mirrors
// REST's handleChainCalls and the get_chain_calls MCP tool (#2364).
export async function loadChainCalls(
  d1,
  {
    window = "7d",
    groupBy = "module",
    callModule = null,
    limit = 50,
    observedAt = null,
    now = Date.now(),
  } = {},
) {
  const days = ANALYTICS_WINDOWS[window] ?? ANALYTICS_WINDOWS["7d"];
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const cutoff = now - days * DAY_MS;
  const groupCols =
    groupBy === "module_function"
      ? "call_module, call_function"
      : "call_module";
  const selectCols =
    groupBy === "module_function"
      ? "call_module, call_function"
      : "call_module";
  const orderByCols =
    groupBy === "module_function"
      ? "count DESC, call_module ASC, call_function ASC"
      : "count DESC, call_module ASC";
  const callModuleFilter =
    typeof callModule === "string" && callModule.length > 0 ? callModule : null;
  const moduleClause = callModuleFilter ? " AND call_module = ?" : "";
  const [rows, totalRows] = await Promise.all([
    d1(
      `SELECT ${selectCols}, COUNT(*) AS count
       FROM extrinsics
       WHERE observed_at >= ? AND call_module IS NOT NULL${moduleClause}
       GROUP BY ${groupCols}
       ORDER BY ${orderByCols}
       LIMIT ?`,
      callModuleFilter ? [cutoff, callModuleFilter, limit] : [cutoff, limit],
    ),
    d1(
      `SELECT COUNT(*) AS total FROM extrinsics WHERE observed_at >= ?${moduleClause}`,
      callModuleFilter ? [cutoff, callModuleFilter] : [cutoff],
    ),
  ]);
  return buildChainCalls({
    window: windowLabel,
    groupBy,
    observedAt,
    total: totalRows?.[0]?.total ?? 0,
    rows,
  });
}

const CHAIN_FEE_MEDIAN_SAMPLE_LIMIT = 10000;

// Floor to the start of the UTC calendar day a timestamp falls in (matches the
// `strftime('%Y-%m-%d', ..., 'unixepoch')` day bucketing used below).
function utcDayFloor(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// Fee/tip market analytics (#1988): per-UTC-day fee series with bounded
// request-time medians plus a windowed top-fee-payer list. Mirrors REST
// handleChainFees and get_chain_fees MCP (#2423).
export async function loadChainFees(
  d1,
  {
    window = "7d",
    limit = 25,
    callModule = null,
    observedAt = null,
    now = Date.now(),
  } = {},
) {
  const days = ANALYTICS_WINDOWS[window] ?? ANALYTICS_WINDOWS["7d"];
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const cutoff = now - days * DAY_MS;
  const callModuleFilter =
    typeof callModule === "string" && callModule.length > 0 ? callModule : null;
  const moduleClause = callModuleFilter ? " AND call_module = ?" : "";
  const dailyParams = callModuleFilter ? [cutoff, callModuleFilter] : [cutoff];
  const payerParams = callModuleFilter
    ? [cutoff, callModuleFilter, limit]
    : [cutoff, limit];
  const [dailyRows, payerRows] = await Promise.all([
    d1(
      `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS extrinsic_count,
              SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
              SUM(COALESCE(tip_tao, 0)) AS total_tip_tao
       FROM extrinsics
       WHERE observed_at >= ?${moduleClause}
       GROUP BY day`,
      dailyParams,
    ),
    // Top-fee-payer leaderboard: tie-break on signer ASC so equal-fee signers
    // have stable LIMIT membership (mirrors loadChainSigners in chain-query-loaders).
    d1(
      `SELECT signer,
              SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
              SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
              COUNT(*) AS extrinsic_count
       FROM extrinsics
       WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
       GROUP BY signer
       ORDER BY total_fee_tao DESC, signer ASC
       LIMIT ?`,
      payerParams,
    ),
  ]);
  // Exact per-day medians, but ONLY for days whose extrinsic_count (from the
  // daily aggregate above, already computed) is within the sample cap. A day
  // over the cap gets an honest null median instead of one approximated from
  // a subsample — every capping strategy tried here (chronological-first,
  // random, bucketed) trades exactness for a DIFFERENT bias, and the daily
  // aggregate already tells us for free which days are cheap enough to
  // compute exactly. Each included day's own [dayStart, dayEnd) range is an
  // index-terminated scan (idx_extrinsics_observed) bounded to that day's
  // ALREADY-VERIFIED-small row count — an over-cap day's rows are never
  // touched by the median query at all, so total rows scanned is capped by
  // (verified-safe days) * CHAIN_FEE_MEDIAN_SAMPLE_LIMIT, a hard ceiling
  // fixed before the query runs, not an approximation of one.
  const safeDayCounts = new Map(
    dailyRows.map((row) => [row.day, Number(row.extrinsic_count)]),
  );
  const safeDayBoundaries = [];
  for (let dayStart = utcDayFloor(cutoff); dayStart < now; dayStart += DAY_MS) {
    const dayLabel = new Date(dayStart).toISOString().slice(0, 10);
    const count = safeDayCounts.get(dayLabel);
    if (count !== undefined && count <= CHAIN_FEE_MEDIAN_SAMPLE_LIMIT) {
      safeDayBoundaries.push(dayStart);
    }
  }
  let medianRows = [];
  if (safeDayBoundaries.length > 0) {
    const medianModuleParam = callModuleFilter ? 1 : null;
    const medianFirstDayParam = callModuleFilter ? 2 : 1;
    const medianTable = callModuleFilter
      ? "extrinsics INDEXED BY idx_extrinsics_module_observed"
      : "extrinsics";
    const medianModuleClause = callModuleFilter
      ? ` AND call_module = ?${medianModuleParam}`
      : "";
    const medianDayBlocks = safeDayBoundaries.map((dayStart, i) => {
      const startParam = medianFirstDayParam + i * 2;
      const endParam = startParam + 1;
      return `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COALESCE(fee_tao, 0) AS fee_tao,
                COALESCE(tip_tao, 0) AS tip_tao
         FROM ${medianTable}
         WHERE observed_at >= ?${startParam} AND observed_at < ?${endParam}${medianModuleClause}`;
    });
    const medianParams = [
      ...(callModuleFilter ? [callModuleFilter] : []),
      ...safeDayBoundaries.flatMap((dayStart) => [
        Math.max(dayStart, cutoff),
        Math.min(dayStart + DAY_MS, now),
      ]),
    ];
    medianRows = await d1(
      `WITH samples AS (
         ${medianDayBlocks.join("\n         UNION ALL\n         ")}
       ),
       fee_ranked AS (
         SELECT day,
                fee_tao,
                ROW_NUMBER() OVER (PARTITION BY day ORDER BY fee_tao) AS rn,
                COUNT(*) OVER (PARTITION BY day) AS cnt
         FROM samples
       ),
       fee_medians AS (
         SELECT day, AVG(fee_tao) AS median_fee_tao
         FROM fee_ranked
         WHERE rn IN (CAST((cnt + 1) / 2 AS INTEGER), CAST((cnt + 2) / 2 AS INTEGER))
         GROUP BY day
       ),
       tip_ranked AS (
         SELECT day,
                tip_tao,
                ROW_NUMBER() OVER (PARTITION BY day ORDER BY tip_tao) AS rn,
                COUNT(*) OVER (PARTITION BY day) AS cnt
         FROM samples
       ),
       tip_medians AS (
         SELECT day, AVG(tip_tao) AS median_tip_tao
         FROM tip_ranked
         WHERE rn IN (CAST((cnt + 1) / 2 AS INTEGER), CAST((cnt + 2) / 2 AS INTEGER))
         GROUP BY day
       )
       SELECT fee_medians.day,
              fee_medians.median_fee_tao,
              tip_medians.median_tip_tao
       FROM fee_medians
       JOIN tip_medians USING (day)`,
      medianParams,
    );
  }
  const data = buildChainFees({
    window: windowLabel,
    observedAt,
    dailyRows,
    medianRows,
    payerRows,
  });
  return { data, dailyRows, payerRows, medianRows };
}

// Daily network-activity aggregates (#1987): per-UTC-day extrinsic/event/block
// counts, success rate, and unique signers. Mirrors REST handleChainActivity and
// get_network_activity MCP (#2452).
export async function loadNetworkActivity(
  d1,
  { window = "7d", observedAt = null, now = Date.now() } = {},
) {
  const days = ANALYTICS_WINDOWS[window] ?? ANALYTICS_WINDOWS["7d"];
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const cutoff = now - days * DAY_MS;
  const [extrinsicRows, blockRows] = await Promise.all([
    d1(
      `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS extrinsic_count,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_extrinsics,
              COUNT(DISTINCT signer) AS unique_signers
       FROM extrinsics
       WHERE observed_at >= ?
       GROUP BY day`,
      [cutoff],
    ),
    d1(
      `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS block_count,
              SUM(event_count) AS event_count
       FROM blocks
       WHERE observed_at >= ?
       GROUP BY day`,
      [cutoff],
    ),
  ]);
  const data = buildChainActivity({
    window: windowLabel,
    observedAt,
    extrinsicRows,
    blockRows,
  });
  return { data, extrinsicRows, blockRows };
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
