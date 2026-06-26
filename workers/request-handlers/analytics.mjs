// D1-backed analytics handlers + the edge-cache guard that protects them.
//
// This module co-locates three things that form ONE indivisible state contract
// (extracted from workers/api.mjs per #1763, extraction 1 of N):
//
//   1. The D1 read path (`d1All` / `d1Runner`) — the single place a D1 failure is
//      caught and degraded to an empty result.
//   2. The fallback-generation machinery (`d1FallbackGeneration` counter + the two
//      WeakSets + the mark/has helpers) — the bookkeeping that lets the cache guard
//      tell a real result from a degraded one.
//   3. `withEdgeCache` — which reads that counter + the response WeakSet to decide
//      whether a 200 may be persisted into the edge cache.
//
// They MUST live together: the counter is mutated inside `d1All` (where the D1
// error is caught) and read inside `withEdgeCache`. If those two referenced
// different module-level state, a degraded payload could poison the edge cache
// (the #1760 bug class). Keeping them in one file makes the await/WeakSet contract
// reviewable in a single place — `markD1FallbackResponse` must tag an *awaited*
// Response, and `withEdgeCache` must inspect that same object.
//
// The handlers depend on one api.mjs-local helper (`readHealthMetaKv`, an
// in-isolate memoized KV read that stays in api.mjs because the deferred clusters
// and a test import it from there). Rather than import it back — which would make
// this module and api.mjs mutually import each other — it is injected once via
// `configureAnalytics({ readHealthMetaKv })` at api.mjs load time. Everything else
// is imported directly from leaf modules, so this file never imports api.mjs.

import {
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  DAY_MS,
  clampInt,
  HEALTH_TREND_WINDOWS,
  MAX_BULK_TREND_ROWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
} from "../config.mjs";
import { errorResponse, ifNoneMatchSatisfied } from "../http.mjs";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.mjs";
import { d1TimeoutMs, withTimeout } from "../storage.mjs";
import {
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
} from "../../src/health-sql.mjs";
import {
  formatBulkTrends,
  formatGlobalIncidents,
  formatIncidents,
  formatPercentiles,
  formatTrends,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "../../src/health-serving.mjs";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  buildChainSigners,
} from "../../src/chain-analytics.mjs";

// Injected once from api.mjs (see configureAnalytics). The in-isolate memoized
// snapshot-meta read lives in api.mjs because the deferred handler clusters and a
// test still import it from there; injecting the stable function reference here
// keeps the import acyclic. This is a one-time wiring of a stable function — not
// the mutable fallback state, which is genuinely owned by this module below.
let readHealthMetaKv = () => {
  throw new Error("analytics handlers used before configureAnalytics()");
};

// Called once at api.mjs module-init to wire the api.mjs-local KV reader.
export function configureAnalytics(deps) {
  readHealthMetaKv = deps.readHealthMetaKv;
}

function validateQueryParams(url, allowedParams) {
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowedParams.includes(key)) {
      return {
        parameter: key,
        message: `${key} is not supported for this route.`,
      };
    }
    if (seen.has(key)) {
      return {
        parameter: key,
        message: `${key} may only be provided once.`,
      };
    }
    seen.add(key);
  }
  return null;
}

function analyticsWindow(url, extraParams = []) {
  const validationError = validateQueryParams(url, [
    ANALYTICS_WINDOW_PARAM,
    ...extraParams,
  ]);
  if (validationError) return { error: validationError };

  const requested = url.searchParams.get(ANALYTICS_WINDOW_PARAM);
  if (requested !== null && !ANALYTICS_WINDOWS[requested]) {
    return {
      error: {
        parameter: ANALYTICS_WINDOW_PARAM,
        message: `"${requested}" is not a valid window. Supported: ${Object.keys(ANALYTICS_WINDOWS).join(", ")}.`,
      },
    };
  }

  const label = requested || "7d";
  return { label, days: ANALYTICS_WINDOWS[label] };
}

function analyticsQueryError(error) {
  return errorResponse("invalid_query", error.message, 400, {
    parameter: error.parameter,
  });
}

function validateEnumParam(url, parameter, allowedValues) {
  const raw = url.searchParams.get(parameter);
  if (raw === null) return null;
  if (allowedValues.includes(raw)) return null;
  return {
    parameter,
    message: `${parameter} must be one of: ${allowedValues.join(", ")}.`,
  };
}

function validateIntegerParam(url, parameter, min, max) {
  const raw = url.searchParams.get(parameter);
  if (raw === null) return null;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || value < min || value > max) {
    return {
      parameter,
      message: `${parameter} must be an integer between ${min} and ${max}.`,
    };
  }
  return null;
}

let d1FallbackGeneration = 0;
const D1_FALLBACK_ROWS = new WeakSet();
const D1_FALLBACK_RESPONSES = new WeakSet();

function markD1FallbackRows(rows = []) {
  d1FallbackGeneration += 1;
  D1_FALLBACK_ROWS.add(rows);
  return rows;
}

function hasD1FallbackRows(...rowSets) {
  return rowSets.some((rows) => D1_FALLBACK_ROWS.has(rows));
}

function markD1FallbackResponse(response) {
  D1_FALLBACK_RESPONSES.add(response);
  return response;
}

async function d1All(env, sql, params) {
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return markD1FallbackRows([]);
  try {
    const result = await withTimeout(
      db
        .prepare(sql)
        .bind(...params)
        .all(),
      d1TimeoutMs(env),
    );
    return result?.results || [];
  } catch (error) {
    // Surface the failure instead of silently degrading to []. A swallowed
    // "no such column" here (prod schema drift) dark-served the uptime tier for
    // days before anyone noticed — log it so the next failure is diagnosable.
    console.error(
      "[d1All]",
      String(error?.message ?? error),
      "·",
      String(sql).slice(0, 120),
    );
    return markD1FallbackRows([]);
  }
}

// Bind the timeout-guarded D1 reader to an env as a (sql, params) => rows runner
// for the shared loaders, so these routes and the MCP tools share one read path.
const d1Runner = (env) => (sql, params) => d1All(env, sql, params);

async function analyticsMeta(env, artifactPath, observedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: observedAt,
    // Canonical human-facing freshness, consistent with the artifact routes and
    // handleHealthTrends (generated_at is a deterministic build marker per #349).
    published_at: await publishedAt(env),
    source: "live-cron-prober",
  };
}

// Edge-cache wrapper for the D1-backed analytics routes (audit #6). Each of these
// re-runs a full-window D1 aggregation on EVERY request, yet the result only
// changes when the health cron writes a new snapshot — so a cross-colo / agent-
// polling burst re-executes the same 7d/30d aggregation needlessly. Mirrors the
// live-overlay collection cache exactly (the CACHEABLE_OVERLAY_ROUTE_IDS path):
// same Cache API, same `edge-cache.metagraph.sh` key host, same last_run_at
// keying, same conditional-GET 304 short-circuit, same ctx.waitUntil put.
//
// The key varies on everything that changes the body: contract_version (a deploy
// can never serve a cross-version payload) + the cron snapshot stamp
// (`last_run_at`) + the request path (carries netuid) + the canonical search
// (carries `window`). `keyParts` is the extra namespace segment per route. When
// the snapshot stamp is cold (null), caching is skipped entirely so a cold-KV
// empty payload can never seed a stale entry — identical to the overlay cache's
// `if (lastRunAt)` guard. The cache is transparent: body/shape/headers are
// whatever buildResponse() produced; only 200s are cached, never errors.
export async function withEdgeCache(
  request,
  ctx,
  env,
  keyParts,
  buildResponse,
  cachePathAndSearch = null,
) {
  const cache = request.method === "GET" ? globalThis.caches?.default : null;
  // Cheap, per-isolate-memoized read of just the snapshot time. On a hit this +
  // the cache match is the whole request (no D1 aggregation at all).
  const lastRunAt = cache ? (await readHealthMetaKv(env))?.last_run_at : null;
  let cacheKey = null;
  if (cache && lastRunAt) {
    const url = new URL(request.url);
    const cacheRoute = cachePathAndSearch ?? `${url.pathname}${url.search}`;
    cacheKey = new Request(
      `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        contractVersion(env),
      )}/${encodeURIComponent(lastRunAt)}/${keyParts}${cacheRoute}`,
    );
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Honour conditional requests against the cached body's weak ETag so
      // polling agents still get a 304 on a warm cache (mirrors envelopeResponse).
      if (ifNoneMatchSatisfied(request, hit.headers.get("etag"))) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return hit;
    }
  }
  const fallbackGeneration = d1FallbackGeneration;
  const response = await buildResponse();
  // Never cache errors / non-200s (cold-D1 still returns a 200 empty envelope;
  // a 400 bad-window or 5xx must not be persisted).
  if (
    cacheKey &&
    response.status === 200 &&
    !D1_FALLBACK_RESPONSES.has(response) &&
    d1FallbackGeneration === fallbackGeneration
  ) {
    ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// D1-backed 7d/30d daily uptime + latency trends across all subnets. This is a
// compact matrix feed for UI dashboards and agents, so it groups by netuid/day
// instead of returning every surface series.
export async function handleBulkHealthTrends(
  request,
  env,
  url = new URL(request.url),
  ctx = {},
) {
  for (const key of url.searchParams.keys()) {
    return errorResponse(
      "invalid_query",
      `${key} is not supported for this route.`,
      400,
      { parameter: key },
    );
  }

  return withEdgeCache(request, ctx, env, "bulk-trends", async () => {
    const nowMs = Date.now();
    const maxWindowDays = Math.max(...Object.values(HEALTH_TREND_WINDOWS));
    const cutoffDay = new Date(nowMs - maxWindowDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const rows = await d1All(
      env,
      `SELECT netuid,
            day AS date,
            SUM(samples) AS total,
            SUM(ok_count) AS ok_count,
            ${dailyLatencyColumns()}
     FROM surface_uptime_daily
     WHERE day >= ?
     GROUP BY netuid, day
     ORDER BY netuid, day
     LIMIT ?`,
      [cutoffDay, MAX_BULK_TREND_ROWS],
    );
    const windows = {};
    for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
      const windowCutoff = new Date(nowMs - days * DAY_MS)
        .toISOString()
        .slice(0, 10);
      windows[label] = rows.filter(
        (row) => String(row.day || row.date) >= windowCutoff,
      );
    }
    const meta = await readHealthMetaKv(env);
    const data = formatBulkTrends({
      observedAt: meta?.last_run_at || null,
      windows,
      windowDays: HEALTH_TREND_WINDOWS,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: {
          artifact_path: "/metagraph/health/trends.json",
          cache: "short",
          contract_version: contractVersion(env),
          generated_at: data.observed_at,
          published_at: await publishedAt(env),
          source: "live-cron-prober",
        },
      },
      "short",
    );
    return hasD1FallbackRows(rows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// D1-backed 7d/30d uptime + latency trends for one subnet's operational
// surfaces. Returns a schema-stable empty payload when D1 is unbound/cold so it
// never errors (mirrors the live-overlay fall-back philosophy).
export async function handleHealthTrends(request, env, netuid, url, ctx = {}) {
  // Reject unsupported query params (400) like every sibling analytics route
  // (percentiles/incidents/uptime/trajectory and the bulk trends route); this
  // route takes no params and returns all configured windows.
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  return withEdgeCache(request, ctx, env, "trends", async () => {
    const db = env.METAGRAPH_HEALTH_DB;
    const nowMs = Date.now();
    const windows = {};
    // The per-window aggregations are independent — run them in parallel (one D1
    // round-trip each) like handleHealthPercentiles/handleLeaderboards, rather than
    // serializing the two with an await-in-loop.
    const windowRows = await Promise.all(
      Object.entries(HEALTH_TREND_WINDOWS).map(async ([label, days]) => {
        if (!db?.prepare) {
          return [label, markD1FallbackRows([])];
        }
        try {
          const result = await withTimeout(
            db
              .prepare(
                `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
             SELECT MAX(surface_id) AS surface_id,
                    surface_key,
                    COUNT(*) AS total,
                    SUM(ok) AS ok_count,
                    ${latencyStatColumns({ includeMinMax: false })}
             FROM ranked
             GROUP BY surface_key`,
              )
              .bind(netuid, nowMs - days * DAY_MS)
              .all(),
            d1TimeoutMs(env),
          );
          return [label, result?.results || []];
        } catch {
          return [label, markD1FallbackRows([])];
        }
      }),
    );
    for (const [label, rows] of windowRows) {
      windows[label] = rows;
    }
    const meta = await readHealthMetaKv(env);
    const data = formatTrends({
      netuid,
      observedAt: meta?.last_run_at || null,
      windows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: {
          artifact_path: `/metagraph/health/trends/${netuid}.json`,
          cache: "short",
          contract_version: contractVersion(env),
          generated_at: data.observed_at,
          published_at: await publishedAt(env),
          source: "live-cron-prober",
        },
      },
      "short",
    );
    return hasD1FallbackRows(...Object.values(windows))
      ? markD1FallbackResponse(response)
      : response;
  });
}

// p50/p95/p99 latency percentiles per surface, computed in D1.
export async function handleHealthPercentiles(
  request,
  env,
  netuid,
  url,
  ctx = {},
) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(request, ctx, env, "percentiles", async () => {
    const rows = await d1All(
      env,
      `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
     SELECT MAX(surface_id) AS surface_id,
            surface_key,
            ${latencyStatColumns()}
     FROM ranked
     GROUP BY surface_key
     HAVING MAX(lat_cnt) > 0`,
      [netuid, Date.now() - days * DAY_MS],
    );
    const meta = await readHealthMetaKv(env);
    const data = formatPercentiles({
      netuid,
      window: label,
      observedAt: meta?.last_run_at || null,
      rows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          `/metagraph/health/percentiles/${netuid}.json`,
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(rows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// SLA + reconstructed downtime incidents per surface.
export async function handleHealthIncidents(
  request,
  env,
  netuid,
  url,
  ctx = {},
) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(request, ctx, env, "incidents", async () => {
    const since = Date.now() - days * DAY_MS;
    const [slaRows, incidentRows] = await Promise.all([
      d1All(
        env,
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
      // incident threshold) into one incident row, then cap the public payload so
      // flapping endpoints cannot force unbounded result sets/responses.
      d1All(
        env,
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
       )
       SELECT MAX(surface_id) AS surface_id,
              surface_key,
              MIN(checked_at) AS started_at,
              MAX(checked_at) AS ended_at,
              COUNT(*) AS failed_samples
       FROM grouped
       WHERE ok = 0
       GROUP BY surface_key, grp
       HAVING COUNT(*) >= ?
       ORDER BY surface_id, started_at
       LIMIT ?`,
        [
          netuid,
          since,
          INCIDENT_GAP_MS,
          MIN_INCIDENT_SAMPLES,
          MAX_INCIDENT_ROWS,
        ],
      ),
    ]);
    const meta = await readHealthMetaKv(env);
    const data = formatIncidents({
      netuid,
      window: label,
      observedAt: meta?.last_run_at || null,
      slaRows,
      incidentRows,
      maxIncidents: MAX_INCIDENT_ROWS,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          `/metagraph/health/incidents/${netuid}.json`,
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(slaRows, incidentRows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Global, cross-subnet incident ledger — the same gap-island grouping as the
// per-subnet route but with no netuid filter, grouped by (netuid, surface_id)
// and capped. Powers a public status page's "recent incidents" feed. Returns a
// schema-stable empty payload when D1 is unbound/cold.
//
// APPROXIMATE NEAR THE SOURCE-ROW CAP: the inner `recent_checks` CTE truncates
// to the newest MAX_GLOBAL_INCIDENT_SOURCE_ROWS checks before the gap-island
// pass runs. An incident whose probe samples straddle that boundary is seen only
// partially, so its started_at / failed_samples can be clipped (or the incident
// dropped entirely if too few of its samples survive the LIMIT). This is a
// best-effort recent-incidents feed for a status page, not an exact audit ledger
// — the per-subnet /incidents route (no global cap) is the authoritative source
// for a single subnet. Widening this to an exact bound would mean aggregating
// from surface_uptime_daily (out of scope here).
export async function handleGlobalIncidents(request, env, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) {
    return analyticsQueryError(error);
  }
  const since = Date.now() - days * DAY_MS;
  const incidentRows = await d1All(
    env,
    `WITH recent_checks AS (
       -- Source-row cap (LIMIT ?): bounds the gap-island scan, but an incident
       -- straddling this newest-N boundary is only partially counted (see the
       -- handler doc-note above — this feed is approximate near the cap).
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
  const meta = await readHealthMetaKv(env);
  const data = formatGlobalIncidents({
    window: label,
    observedAt: meta?.last_run_at || null,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        "/metagraph/incidents.json",
        data.observed_at,
      ),
    },
    "short",
  );
  return hasD1FallbackRows(incidentRows)
    ? markD1FallbackResponse(response)
    : response;
}

// Daily network-activity aggregates over the first-party chain D1 tiers (#1987):
// per-UTC-day extrinsic/event/block counts, success rate, and unique signers —
// the foundation time-series for the block-explorer "network at a glance" view
// (epic #1986). Two independent GROUP-BY-day aggregations (extrinsics + blocks)
// run in parallel and merge in the pure builder, so the route is schema-stable
// (day_count:0, days:[]) on a cold store and never re-aggregates on an edge hit.
export async function handleChainActivity(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(request, ctx, env, "chain-activity", async () => {
    const cutoff = Date.now() - days * DAY_MS;
    // observed_at is epoch-ms; `/ 1000` (SQLite integer division) → unix seconds
    // for strftime's 'unixepoch' UTC bucketer. Values are always bound.
    const [extrinsicRows, blockRows] = await Promise.all([
      d1All(
        env,
        `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COUNT(*) AS extrinsic_count,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_extrinsics,
                COUNT(DISTINCT signer) AS unique_signers
         FROM extrinsics
         WHERE observed_at >= ?
         GROUP BY day`,
        [cutoff],
      ),
      d1All(
        env,
        `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COUNT(*) AS block_count,
                SUM(event_count) AS event_count
         FROM blocks
         WHERE observed_at >= ?
         GROUP BY day`,
        [cutoff],
      ),
    ]);
    const meta = await readHealthMetaKv(env);
    const data = buildChainActivity({
      window: label,
      observedAt: meta?.last_run_at || null,
      extrinsicRows,
      blockRows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          "/metagraph/chain/activity.json",
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(extrinsicRows, blockRows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Extrinsic call-mix breakdown (#1989): counts + share per call_module (or
// call_module/call_function). The share denominator is the full-window extrinsic
// count read separately, so the truncated LIMIT tail never skews shares.
export async function handleChainCalls(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url, ["group_by", "limit"]);
  if (error) return analyticsQueryError(error);
  const groupByError = validateEnumParam(url, "group_by", [
    "module",
    "module_function",
  ]);
  if (groupByError) return analyticsQueryError(groupByError);
  const limitError = validateIntegerParam(url, "limit", 1, 100);
  if (limitError) return analyticsQueryError(limitError);
  const groupBy = url.searchParams.get("group_by") || "module";
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  return withEdgeCache(request, ctx, env, "chain-calls", async () => {
    const cutoff = Date.now() - days * DAY_MS;
    const groupCols =
      groupBy === "module_function"
        ? "call_module, call_function"
        : "call_module";
    const selectCols =
      groupBy === "module_function"
        ? "call_module, call_function"
        : "call_module";
    const [rows, totalRows] = await Promise.all([
      d1All(
        env,
        `SELECT ${selectCols}, COUNT(*) AS count
         FROM extrinsics
         WHERE observed_at >= ? AND call_module IS NOT NULL
         GROUP BY ${groupCols}
         ORDER BY count DESC
         LIMIT ?`,
        [cutoff, limit],
      ),
      d1All(
        env,
        `SELECT COUNT(*) AS total FROM extrinsics WHERE observed_at >= ?`,
        [cutoff],
      ),
    ]);
    const meta = await readHealthMetaKv(env);
    const data = buildChainCalls({
      window: label,
      groupBy,
      observedAt: meta?.last_run_at || null,
      total: totalRows?.[0]?.total ?? 0,
      rows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          "/metagraph/chain/calls.json",
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(rows, totalRows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Windowed most-active-account leaderboard (#1990): signers ranked by extrinsic
// count over the window. The observed_at index bounds the scan to the hot window;
// the aggregation is amortized behind the edge cache (runs only on a new snapshot).
export async function handleChainSigners(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url, ["limit", "call_module"]);
  if (error) return analyticsQueryError(error);
  const limitError = validateIntegerParam(url, "limit", 1, 100);
  if (limitError) return analyticsQueryError(limitError);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  // Optional pallet scope, backed by idx_extrinsics_call_module_order.
  const callModule = url.searchParams.get("call_module");
  const moduleClause = callModule ? " AND call_module = ?" : "";
  return withEdgeCache(request, ctx, env, "chain-signers", async () => {
    const cutoff = Date.now() - days * DAY_MS;
    const rows = await d1All(
      env,
      `SELECT signer,
              COUNT(*) AS tx_count,
              SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
              SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
              MAX(block_number) AS last_tx_block
       FROM extrinsics
       WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
       GROUP BY signer
       ORDER BY tx_count DESC
       LIMIT ?`,
      callModule ? [cutoff, callModule, limit] : [cutoff, limit],
    );
    const meta = await readHealthMetaKv(env);
    const data = buildChainSigners({
      window: label,
      observedAt: meta?.last_run_at || null,
      rows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          "/metagraph/chain/signers.json",
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(rows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Fee/tip market analytics (#1988): a per-UTC-day fee series (totals + averages)
// plus a windowed top-fee-payer list. COALESCE keeps NULL fees/tips out of the
// SUMs; exact median is a deliberate follow-up (no native percentile in D1).
export async function handleChainFees(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url, ["limit", "call_module"]);
  if (error) return analyticsQueryError(error);
  const limitError = validateIntegerParam(url, "limit", 1, 100);
  if (limitError) return analyticsQueryError(limitError);
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 100);
  // Optional pallet scope (applies to both the daily series and the payer list),
  // backed by idx_extrinsics_call_module_order.
  const callModule = url.searchParams.get("call_module");
  const moduleClause = callModule ? " AND call_module = ?" : "";
  return withEdgeCache(request, ctx, env, "chain-fees", async () => {
    const cutoff = Date.now() - days * DAY_MS;
    const [dailyRows, payerRows] = await Promise.all([
      d1All(
        env,
        `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COUNT(*) AS extrinsic_count,
                SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
                SUM(COALESCE(tip_tao, 0)) AS total_tip_tao
         FROM extrinsics
         WHERE observed_at >= ?${moduleClause}
         GROUP BY day`,
        callModule ? [cutoff, callModule] : [cutoff],
      ),
      d1All(
        env,
        `SELECT signer,
                SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
                SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
                COUNT(*) AS extrinsic_count
         FROM extrinsics
         WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
         GROUP BY signer
         ORDER BY total_fee_tao DESC
         LIMIT ?`,
        callModule ? [cutoff, callModule, limit] : [cutoff, limit],
      ),
    ]);
    const meta = await readHealthMetaKv(env);
    const data = buildChainFees({
      window: label,
      observedAt: meta?.last_run_at || null,
      dailyRows,
      payerRows,
    });
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: await analyticsMeta(
          env,
          "/metagraph/chain/fees.json",
          data.observed_at,
        ),
      },
      "short",
    );
    return hasD1FallbackRows(dailyRows, payerRows)
      ? markD1FallbackResponse(response)
      : response;
  });
}

// Shared analytics helpers also used by the deferred handler clusters (trajectory,
// metagraph, validators, uptime, history, leaderboards, compare, rpc-usage) that
// still live in api.mjs — re-exported so api.mjs can import them from one place
// until those clusters are extracted too.
export {
  analyticsMeta,
  analyticsQueryError,
  analyticsWindow,
  d1All,
  d1Runner,
  hasD1FallbackRows,
  markD1FallbackResponse,
  validateQueryParams,
};
