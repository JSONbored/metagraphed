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
  DEFAULT_ANALYTICS_WINDOW,
  DAY_MS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
} from "../config.mjs";
import { parseLimitParam } from "../request-params.mjs";
import { errorResponse, ifNoneMatchSatisfied } from "../http.mjs";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.mjs";
import { d1TimeoutMs, withTimeout } from "../storage.mjs";
import { loadBulkHealthTrends } from "../../src/bulk-health-trends.mjs";
import {
  formatGlobalIncidents,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "../../src/health-serving.mjs";
import {
  loadChainCalls,
  loadChainFees,
  loadNetworkActivity,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
} from "../../src/analytics-live.mjs";
import {
  CHAIN_SIGNERS_SORTS,
  loadChainSigners,
} from "../../src/chain-query-loaders.mjs";
import { loadChainTransfers } from "../../src/chain-transfers.mjs";

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

// Build an edge-cache key from RESOLVED query values so a bare path, an explicit
// ?window=<default>, and omitted defaulted params all share one cache entry —
// mirrors handleChainActivity and canonicalHealthWindowCachePath. Optional
// filters (call_module) are included only when set.
function canonicalAnalyticsCacheRoute(url, { window, extras = {} } = {}) {
  const search = new URL("https://cache-key.invalid/").searchParams;
  search.set(ANALYTICS_WINDOW_PARAM, window);
  for (const key of ["group_by", "limit", "sort", "call_module"]) {
    if (!Object.hasOwn(extras, key)) continue;
    const value = extras[key];
    if (value != null && value !== "") search.set(key, String(value));
  }
  return `${url.pathname}?${search.toString()}`;
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

  const label = requested || DEFAULT_ANALYTICS_WINDOW;
  return { label, days: ANALYTICS_WINDOWS[label] };
}

// Normalizes per-subnet health analytics URLs so a bare ?-free request and an
// explicit ?window=7d request both resolve to the same edge-cache entry — mirrors
// canonicalEconomicsTrendsCachePath in analytics-routes.mjs.
export function canonicalHealthWindowCachePath(url) {
  const validationError = validateQueryParams(url, [ANALYTICS_WINDOW_PARAM]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = analyticsWindow(url);
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
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

// Bound an optional free-text filter so an oversized value never reaches D1.
function validateMaxLength(url, parameter, max) {
  const raw = url.searchParams.get(parameter);
  if (raw !== null && raw.length > max) {
    return {
      parameter,
      message: `${parameter} must be ${max} characters or fewer.`,
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
// can never serve a cross-version payload) + a freshness stamp + the request
// path (carries netuid) + the canonical search (carries `window`). By default
// the stamp is the health cron snapshot (`last_run_at`); neurons-tier routes
// pass `resolveCacheStamp` to bust on neuron `captured_at` instead (#1346).
// `keyParts` is the extra namespace segment per route. When the stamp is cold
// (null), caching is skipped entirely so a cold-KV/empty payload can never seed
// a stale entry — identical to the overlay cache's `if (lastRunAt)` guard. The
// cache is transparent: body/shape/headers are whatever buildResponse() produced;
// only 200s are cached, never errors.
export async function withEdgeCache(
  request,
  ctx,
  env,
  keyParts,
  buildResponse,
  cachePathAndSearch = null,
  resolveCacheStamp = null,
) {
  const cache = request.method === "GET" ? globalThis.caches?.default : null;
  // Cheap freshness read. On a hit this + the cache match is the whole request
  // (no D1 aggregation at all for the handler body).
  let stamp = null;
  if (cache) {
    if (typeof resolveCacheStamp === "function") {
      stamp = await resolveCacheStamp(env);
    } else {
      stamp = (await readHealthMetaKv(env))?.last_run_at ?? null;
    }
  }
  let cacheKey = null;
  if (cache && stamp) {
    const url = new URL(request.url);
    const cacheRoute = cachePathAndSearch ?? `${url.pathname}${url.search}`;
    cacheKey = new Request(
      `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        contractVersion(env),
      )}/${encodeURIComponent(stamp)}/${keyParts}${cacheRoute}`,
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

// Neurons-tier routes refresh on the ~3-minute events/metagraph cron, not the
// 15-minute health prober — bust their edge cache on per-subnet snapshot time.
export async function readSubnetNeuronsCacheStamp(env, netuid) {
  const rows = await d1All(
    env,
    "SELECT MAX(captured_at) AS captured_at FROM neurons WHERE netuid = ?",
    [netuid],
  );
  if (hasD1FallbackRows(rows)) return null;
  const capturedAt = rows[0]?.captured_at;
  return Number.isInteger(capturedAt) && capturedAt > 0
    ? String(capturedAt)
    : null;
}

// Network-wide neuron cache stamp: the newest captured_at across ALL subnets, so a
// chain-level neurons aggregate (chain/concentration) busts its edge cache the
// moment any subnet's snapshot advances — the network analog of the per-subnet
// stamp above.
export async function readNeuronsCacheStamp(env) {
  const rows = await d1All(
    env,
    "SELECT MAX(captured_at) AS captured_at FROM neurons",
    [],
  );
  if (hasD1FallbackRows(rows)) return null;
  const capturedAt = rows[0]?.captured_at;
  return Number.isInteger(capturedAt) && capturedAt > 0
    ? String(capturedAt)
    : null;
}

export function withNeuronsEdgeCache(
  request,
  ctx,
  env,
  netuid,
  keyParts,
  buildResponse,
  cachePathAndSearch = null,
) {
  return withEdgeCache(
    request,
    ctx,
    env,
    keyParts,
    buildResponse,
    cachePathAndSearch,
    (edgeEnv) => readSubnetNeuronsCacheStamp(edgeEnv, netuid),
  );
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
    const meta = await readHealthMetaKv(env);
    const { data, rows } = await loadBulkHealthTrends(d1Runner(env), {
      observedAt: meta?.last_run_at || null,
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
// never errors (mirrors the live-overlay fall-back philosophy). The query +
// formatting live in loadSubnetHealthTrends (src/analytics-live.mjs) so the
// get_subnet_health_trends MCP tool shares this exact read path (#2335).
export async function handleHealthTrends(request, env, netuid, url, ctx = {}) {
  // Reject unsupported query params (400) like every sibling analytics route
  // (percentiles/incidents/uptime/trajectory and the bulk trends route); this
  // route takes no params and returns all configured windows.
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  return withEdgeCache(request, ctx, env, "trends", async () => {
    // Read through the shared d1All (rather than handing the loader the bare
    // db) so a failure is still logged + marked as a D1 fallback (the
    // dark-serve log contract) — usedFallback tracks it across the loader's
    // parallel per-window reads since the formatted result no longer exposes
    // the raw row arrays hasD1FallbackRows used to check.
    let usedFallback = false;
    const d1 = async (sql, params) => {
      const rows = await d1All(env, sql, params);
      if (hasD1FallbackRows(rows)) usedFallback = true;
      return rows;
    };
    const meta = await readHealthMetaKv(env);
    const data = await loadSubnetHealthTrends(d1, netuid, {
      observedAt: meta?.last_run_at || null,
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
    return usedFallback ? markD1FallbackResponse(response) : response;
  });
}

// p50/p95/p99 latency percentiles per surface, computed in D1. The query +
// formatting live in loadSubnetPercentiles (src/analytics-live.mjs) so the
// get_subnet_health_percentiles MCP tool shares this exact read path.
export async function handleHealthPercentiles(
  request,
  env,
  netuid,
  url,
  ctx = {},
) {
  const { label, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(
    request,
    ctx,
    env,
    "percentiles",
    async () => {
      // Wrap d1All so a failure is still logged + marked as a D1 fallback (the
      // dark-serve contract), since the formatted result no longer exposes the
      // raw rows hasD1FallbackRows used to check (mirrors handleHealthTrends).
      let usedFallback = false;
      const d1 = async (sql, params) => {
        const rows = await d1All(env, sql, params);
        if (hasD1FallbackRows(rows)) usedFallback = true;
        return rows;
      };
      const meta = await readHealthMetaKv(env);
      const data = await loadSubnetPercentiles(d1, netuid, {
        window: label,
        observedAt: meta?.last_run_at || null,
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
      return usedFallback ? markD1FallbackResponse(response) : response;
    },
    canonicalHealthWindowCachePath(url),
  );
}

// SLA + reconstructed downtime incidents per surface.
export async function handleHealthIncidents(
  request,
  env,
  netuid,
  url,
  ctx = {},
) {
  const { label, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(
    request,
    ctx,
    env,
    "incidents",
    async () => {
      // Wrap d1All so a failure in either read is still logged + marked as a D1
      // fallback (the dark-serve contract), since the formatted result no longer
      // exposes the raw row arrays hasD1FallbackRows used to check (mirrors
      // handleHealthTrends / handleHealthPercentiles).
      let usedFallback = false;
      const d1 = async (sql, params) => {
        const rows = await d1All(env, sql, params);
        if (hasD1FallbackRows(rows)) usedFallback = true;
        return rows;
      };
      const meta = await readHealthMetaKv(env);
      const data = await loadSubnetIncidents(d1, netuid, {
        window: label,
        observedAt: meta?.last_run_at || null,
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
      return usedFallback ? markD1FallbackResponse(response) : response;
    },
    canonicalHealthWindowCachePath(url),
  );
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
const GLOBAL_INCIDENTS_SQL = `WITH recent_checks AS (
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
     LIMIT ?`;

/** Shared D1 incident ledger used by GET /api/v1/incidents and content feeds. */
export async function loadGlobalIncidentsLedger(
  env,
  { label = "7d", days = 7 } = {},
) {
  const since = Date.now() - days * DAY_MS;
  const incidentRows = await d1All(env, GLOBAL_INCIDENTS_SQL, [
    since,
    MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
    INCIDENT_GAP_MS,
    MIN_INCIDENT_SAMPLES,
    MAX_INCIDENT_ROWS,
  ]);
  const meta = await readHealthMetaKv(env);
  const data = formatGlobalIncidents({
    window: label,
    observedAt: meta?.last_run_at || null,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
  return { data, incidentRows };
}

export async function handleGlobalIncidents(request, env, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) {
    return analyticsQueryError(error);
  }
  const { data, incidentRows } = await loadGlobalIncidentsLedger(env, {
    label,
    days,
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
  const { label, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-activity",
    async () => {
      const meta = await readHealthMetaKv(env);
      const { data, extrinsicRows, blockRows } = await loadNetworkActivity(
        d1Runner(env),
        {
          window: label,
          observedAt: meta?.last_run_at || null,
        },
      );
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
    },
    // Canonicalize the cache key on the RESOLVED window so the bare path, an
    // explicit ?window=<default>, and reordered/duplicate variants all share one
    // entry instead of fragmenting the cache (mirrors the percentiles/incidents/
    // economics-trends windowed routes). `label` is the validated window.
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

// Extrinsic call-mix breakdown (#1989): counts + share per call_module (or
// call_module/call_function). The share denominator is the full-window extrinsic
// count read separately, so the truncated LIMIT tail never skews shares.
export async function handleChainCalls(request, env, url, ctx = {}) {
  const { label, error } = analyticsWindow(url, [
    "group_by",
    "limit",
    "call_module",
  ]);
  if (error) return analyticsQueryError(error);
  const groupByError = validateEnumParam(url, "group_by", [
    "module",
    "module_function",
  ]);
  if (groupByError) return analyticsQueryError(groupByError);
  const { limit, error: limitError } = parseLimitParam(url, {
    defaultLimit: 50,
    maxLimit: 100,
  });
  if (limitError) return analyticsQueryError(limitError);
  const groupBy = url.searchParams.get("group_by") || "module";
  const callModule = url.searchParams.get("call_module");
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-calls",
    async () => {
      let usedFallback = false;
      const d1 = async (sql, params) => {
        const rows = await d1All(env, sql, params);
        if (hasD1FallbackRows(rows)) usedFallback = true;
        return rows;
      };
      const meta = await readHealthMetaKv(env);
      const data = await loadChainCalls(d1, {
        window: label,
        groupBy,
        callModule,
        limit,
        observedAt: meta?.last_run_at || null,
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
      return usedFallback ? markD1FallbackResponse(response) : response;
    },
    canonicalAnalyticsCacheRoute(url, {
      window: label,
      extras: {
        group_by: groupBy,
        limit,
        ...(callModule ? { call_module: callModule } : {}),
      },
    }),
  );
}

// Windowed most-active-account leaderboard (#1990): signers ranked by extrinsic
// count over the window. The observed_at index bounds the scan to the hot window;
// the aggregation is amortized behind the edge cache (runs only on a new snapshot).
export async function handleChainSigners(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url, [
    "limit",
    "call_module",
    "sort",
  ]);
  if (error) return analyticsQueryError(error);
  const sortError = validateEnumParam(url, "sort", CHAIN_SIGNERS_SORTS);
  if (sortError) return analyticsQueryError(sortError);
  const { limit, error: limitError } = parseLimitParam(url, {
    defaultLimit: 50,
    maxLimit: 100,
  });
  if (limitError) return analyticsQueryError(limitError);
  const sort = url.searchParams.get("sort") || "tx_count";
  // Optional pallet scope, backed by idx_extrinsics_module_block.
  const callModule = url.searchParams.get("call_module");
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-signers",
    async () => {
      const meta = await readHealthMetaKv(env);
      const { data, rows } = await loadChainSigners(d1Runner(env), {
        windowLabel: label,
        windowDays: days,
        observedAt: meta?.last_run_at || null,
        limit,
        callModule,
        sort,
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
    },
    canonicalAnalyticsCacheRoute(url, {
      window: label,
      extras: {
        limit,
        sort,
        ...(callModule ? { call_module: callModule } : {}),
      },
    }),
  );
}

// Network-wide native-TAO transfer analytics: total Balances.Transfer volume over the
// window, the top senders + receivers by volume, and the top senders' share of total
// volume (a concentration signal), from the account_events Transfer feed. The
// network-level companion of /accounts/{ss58}/transfers + /counterparties.
export async function handleChainTransfers(request, env, url, ctx = {}) {
  const { label, days, error } = analyticsWindow(url, ["limit"]);
  if (error) return analyticsQueryError(error);
  const { limit, error: limitError } = parseLimitParam(url, {
    defaultLimit: 25,
    maxLimit: 100,
  });
  if (limitError) return analyticsQueryError(limitError);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-transfers",
    async () => {
      const meta = await readHealthMetaKv(env);
      const data = await loadChainTransfers(d1Runner(env), {
        windowLabel: label,
        windowDays: days,
        observedAt: meta?.last_run_at || null,
        limit,
      });
      return envelopeResponse(
        request,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/transfers.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    canonicalAnalyticsCacheRoute(url, {
      window: label,
      extras: { limit },
    }),
  );
}

// Fee/tip market analytics (#1988): a per-UTC-day fee series (totals, averages,
// exact medians) plus a windowed top-fee-payer list. COALESCE keeps NULL
// fees/tips out of the SUMs and medians.
export async function handleChainFees(request, env, url, ctx = {}) {
  const { label, error } = analyticsWindow(url, ["limit", "call_module"]);
  if (error) return analyticsQueryError(error);
  const { limit, error: limitError } = parseLimitParam(url, {
    defaultLimit: 25,
    maxLimit: 100,
  });
  if (limitError) return analyticsQueryError(limitError);
  // Optional pallet scope (applies to both the daily series and the payer list),
  // backed by idx_extrinsics_module_block.
  const callModule = url.searchParams.get("call_module");
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-fees",
    async () => {
      const meta = await readHealthMetaKv(env);
      const { data, dailyRows, payerRows, medianRows } = await loadChainFees(
        d1Runner(env),
        {
          window: label,
          limit,
          callModule,
          observedAt: meta?.last_run_at || null,
        },
      );
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
      return hasD1FallbackRows(dailyRows, payerRows, medianRows)
        ? markD1FallbackResponse(response)
        : response;
    },
    canonicalAnalyticsCacheRoute(url, {
      window: label,
      extras: {
        limit,
        ...(callModule ? { call_module: callModule } : {}),
      },
    }),
  );
}

// Shared analytics helpers also used by the deferred handler clusters (trajectory,
// metagraph, validators, uptime, history, leaderboards, compare, rpc-usage) that
// still live in api.mjs — re-exported so api.mjs can import them from one place
// until those clusters are extracted too.
export {
  analyticsMeta,
  analyticsQueryError,
  canonicalAnalyticsCacheRoute,
  analyticsWindow,
  d1All,
  d1Runner,
  hasD1FallbackRows,
  markD1FallbackResponse,
  validateQueryParams,
};
