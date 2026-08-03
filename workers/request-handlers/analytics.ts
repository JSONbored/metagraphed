// Analytics handlers + the edge-cache guard that protects them.
//
// D1 fully eliminated (2026-07-17, reconfirmed live 2026-07-25 -- zero D1
// databases remain on the account): every handler in this file now goes
// straight to a schema-stable empty payload on a Postgres-tier miss, never a
// live D1 read -- the D1 read path (`d1All`) and its fallback-row bookkeeping
// (`markD1FallbackRows`/`hasD1FallbackRows`/the `d1FallbackGeneration`
// counter) were deleted once they had zero remaining callers.
//
// What's left is `markPostgresTierFallbackResponse` + the
// `POSTGRES_TIER_FALLBACK_RESPONSES` WeakSet (renamed 2026-07-25 -- it means
// "this response used the degraded/empty-fallback path, not a real tier
// hit") and `withEdgeCache`, which reads that WeakSet to decide whether a
// 200 may be persisted into the edge cache: `markPostgresTierFallbackResponse`
// must tag an *awaited* Response, and `withEdgeCache` must inspect that same
// object, or a degraded payload could poison the edge cache (the #1760 bug
// class).
//
// The handlers depend on one api.ts-local helper (`readHealthMetaKv`, an
// in-isolate memoized KV read that stays in api.ts because the deferred clusters
// and a test import it from there). Rather than import it back — which would make
// this module and api.ts mutually import each other — it is injected once via
// `configureAnalytics({ readHealthMetaKv })` at api.ts load time. Everything else
// is imported directly from leaf modules, so this file never imports api.ts.

import {
  ANALYTICS_WINDOW_PARAM,
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  MAX_INCIDENT_ROWS,
  resolveClientIp,
} from "../config.ts";
import { parseLimitParam } from "../request-params.ts";
import { loadChainServingColdTier } from "../../src/chain-serving-loader.ts";
import { loadChainWeightsColdTier } from "../../src/chain-weights-loader.ts";
import { loadChainWeightSettersColdTier } from "../../src/chain-weight-setters-loader.ts";
import { API_ROUTES } from "../../src/contracts.ts";
import { registerModuleStateReset } from "../../src/module-state-registry.ts";
import { errorResponse, ifNoneMatchSatisfied } from "../http.ts";
import { csvRequested, csvResponse } from "../csv.ts";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.ts";
import {
  currentPostgresTierFallbackGeneration,
  tryPostgresTier,
} from "../postgres-tier.ts";
import { loadBulkHealthTrends } from "../../src/bulk-health-trends.ts";
import { formatGlobalIncidents } from "../../src/health-serving.ts";
import {
  applyQueryFilters,
  listQueryParamNames,
  paginationLinkHeader,
  type Pagination,
  type QueryError,
} from "../list-query.ts";
import {
  currentD1ReadFailureGeneration,
  loadGlobalIncidentRows,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
  type ObservationsReadDb,
} from "../../src/analytics-live.ts";
import { CHAIN_SIGNERS_SORTS } from "../../src/chain-query-loaders.ts";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  trimChainActivityToWindow,
  trimChainFeesToWindow,
  buildChainSigners,
} from "../../src/chain-analytics.ts";
import {
  CHAIN_TRANSFER_PAIR_SORTS,
  buildChainTransferPairs,
} from "../../src/chain-transfer-pairs.ts";
import { buildChainTransfers } from "../../src/chain-transfers.ts";
import {
  buildChainServing,
  CHAIN_SERVING_LIMIT_DEFAULT,
  CHAIN_SERVING_LIMIT_MAX,
} from "../../src/chain-serving.ts";
import {
  buildChainPrometheus,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
  CHAIN_PROMETHEUS_LIMIT_MAX,
} from "../../src/chain-prometheus.ts";
import {
  buildChainAxonRemovals,
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
} from "../../src/chain-axon-removals.ts";
import {
  buildChainRegistrations,
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_REGISTRATIONS_LIMIT_MAX,
} from "../../src/chain-registrations.ts";
import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_DEREGISTRATIONS_LIMIT_MAX,
} from "../../src/chain-deregistrations.ts";
import {
  buildChainStakeMoves,
  CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
  CHAIN_STAKE_MOVES_LIMIT_MAX,
} from "../../src/chain-stake-moves.ts";
import {
  buildChainStakeTransfers,
  CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
  CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
} from "../../src/chain-stake-transfers.ts";
import {
  buildChainWeights,
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
  CHAIN_WEIGHTS_LIMIT_MAX,
} from "../../src/chain-weights.ts";
import {
  buildChainWeightSetters,
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
} from "../../src/chain-weight-setters.ts";
import {
  buildChainStakeFlow,
  CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
  CHAIN_STAKE_FLOW_LIMIT_MAX,
} from "../../src/chain-stake-flow.ts";
import { loadChainTransfersFromArtifact } from "../../src/chain-transfers-artifact.ts";
import { loadChainStakeFlowFromArtifact } from "../../src/chain-stake-flow-artifact.ts";
import { loadChainRegistrationsFromArtifact } from "../../src/chain-registrations-artifact.ts";
import { loadChainActivityFromArtifact } from "../../src/chain-activity-artifact.ts";
import { loadChainCallsFromArtifact } from "../../src/chain-calls-artifact.ts";
import { loadChainFeesFromArtifact } from "../../src/chain-fees-artifact.ts";
import { loadChainSignersFromArtifact } from "../../src/chain-signers-artifact.ts";
import { loadChainAlphaVolumeFromArtifact } from "../../src/chain-alpha-volume-artifact.ts";
import { loadChainStakeTransfersFromArtifact } from "../../src/chain-stake-transfers-artifact.ts";
import { loadChainTransferPairsFromArtifact } from "../../src/chain-transfer-pairs-artifact.ts";
import { loadChainStakeMovesFromArtifact } from "../../src/chain-stake-moves-artifact.ts";
import {
  buildChainAlphaVolume,
  CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
  CHAIN_ALPHA_VOLUME_LIMIT_MAX,
} from "../../src/chain-alpha-volume.ts";

// The shape of the api.ts-local in-isolate memoized KV read (see
// configureAnalytics below) -- loose on the return value beyond `last_run_at`
// since that field is the only one any handler in this file reads.
type HealthMetaKvReader = (
  env: Env,
) => Promise<{ last_run_at?: string | null } | null>;

// The api.ts-local in-isolate memoized read of the live `economics:current` KV
// blob, injected for the same reason and in the same way (#8744): the emission
// decomposition is built from the economics tier, and the live blob is fresher
// than the committed R2 artifact it falls back to.
type EconomicsCurrentKvReader = (
  env: Env,
) => Promise<Record<string, unknown> | null>;

// Injected once from api.ts (see configureAnalytics). The in-isolate memoized
// snapshot-meta read lives in api.ts because the deferred handler clusters and a
// test still import it from there; injecting the stable function reference here
// keeps the import acyclic. This is a one-time wiring of a stable function — not
// the mutable fallback state, which is genuinely owned by this module below.
/* v8 ignore start */
let readHealthMetaKv: HealthMetaKvReader = () => {
  throw new Error("analytics handlers used before configureAnalytics()");
};
/* v8 ignore stop */

/* v8 ignore start */
let readEconomicsCurrentKv: EconomicsCurrentKvReader = () => {
  throw new Error("analytics handlers used before configureAnalytics()");
};
/* v8 ignore stop */

// Post-load baseline captured before api.ts wires the real readers. See
// src/module-state-registry.ts: under `isolate: false` a test file's fakes
// would otherwise outlive the file. api.ts evaluates after this module, so its
// reset re-wires production immediately after this one unwires.
const unwiredReaders = { readHealthMetaKv, readEconomicsCurrentKv };

registerModuleStateReset("workers/request-handlers/analytics.ts", () => {
  readHealthMetaKv = unwiredReaders.readHealthMetaKv;
  readEconomicsCurrentKv = unwiredReaders.readEconomicsCurrentKv;
});

/** The injected live-economics KV reader, for sibling handler modules. */
export function economicsCurrentKvReader(): EconomicsCurrentKvReader {
  return readEconomicsCurrentKv;
}

// Called once at api.ts module-init to wire the api.ts-local KV readers.
export function configureAnalytics(deps: {
  readHealthMetaKv: HealthMetaKvReader;
  readEconomicsCurrentKv: EconomicsCurrentKvReader;
}) {
  readHealthMetaKv = deps.readHealthMetaKv;
  readEconomicsCurrentKv = deps.readEconomicsCurrentKv;
}

/**
 * The declared query-parameter names for a route path, straight off the
 * contract (#9149).
 *
 * The 33 handlers that call `validateQueryParams` pass a hand-written array,
 * which is a second copy of a list the contract already publishes -- the same
 * "one fact, several declarations" shape as #9127 and #9131. Deriving it means
 * a parameter added to `API_ROUTES` is accepted the day it lands, and one
 * removed stops being accepted, with no array to keep in step.
 */
export function declaredQueryParams(routePath: string): string[] | null {
  const route = (
    API_ROUTES as unknown as {
      path: string;
      method: string;
      query_parameters?: { name: string }[];
    }[]
  ).find((entry) => entry.path === routePath && entry.method === "GET");
  if (!route?.query_parameters?.length) return null;
  return route.query_parameters.map((parameter) => parameter.name);
}

/**
 * Reject a request carrying a parameter the route does not declare.
 *
 * Returns null when the route declares no query parameters at all -- there is
 * nothing to typo, and treating "declares nothing" as "allows nothing" would
 * start 400ing cache-busting params on 44 param-less detail routes for no gain.
 */
/**
 * Parameters accepted on every route regardless of what it declares.
 *
 * `format` is the one API-wide parameter whose no-op is DELIBERATE and tested:
 * /api/v1/chain-events/stats is an aggregate with no top-level row array, so
 * `?format=csv` deliberately falls through to the JSON envelope rather than
 * producing a bogus export ("chain-events/stats ignores ?format=csv and keeps
 * the JSON envelope"). Rejecting it would break that contract to guard against
 * a typo that cannot silently change any result -- the harm here is a dropped
 * FILTER, and format is not one.
 *
 * A declared judgement rather than a derived fact, so it is deliberately a set
 * of exactly one: anything added here stops being typo-checked everywhere.
 */
const GLOBALLY_ACCEPTED_PARAMS = ["format"];

export function validateDeclaredQueryParams(
  url: URL,
  routePath: string,
): QueryError | null {
  const allowed = declaredQueryParams(routePath);
  if (!allowed) return null;
  return validateQueryParams(url, [...allowed, ...GLOBALLY_ACCEPTED_PARAMS]);
}

function validateQueryParams(
  url: URL,
  allowedParams: string[],
): QueryError | null {
  const seen = new Set<string>();
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

// Build the canonical edge-cache key for an analytics route from the handler's
// ALREADY-RESOLVED param values, so a bare request and an explicit request for
// the handler's own documented default share one cache entry (#6356).
//
// `resolved` is an ordered map of param -> resolved value; its key order is the
// key's param order (window is always emitted first). Pass the value the handler
// actually used, not the raw query string: previously only `window` was
// defaulted here and every other param entered the key only when the caller
// spelled it out, so `?limit=50` and a bare request (which also means 50) hashed
// to two entries with identical bodies -- undercutting the "don't re-execute the
// same aggregation for a cross-colo / agent-polling burst" purpose withEdgeCache
// documents. Mirrors canonicalLeaderboardsCachePath / canonicalGlobalValidators-
// CachePath, which already resolve their defaults before keying.
//
// A null/undefined value means the param is genuinely absent with no default
// (e.g. an unset `call_module` filter), so it stays out of the key.
function canonicalAnalyticsCacheRoute(
  url: URL,
  resolved: Record<string, unknown> = {},
): string {
  const search = new URL("https://cache-key.invalid/").searchParams;
  search.set(
    ANALYTICS_WINDOW_PARAM,
    (resolved[ANALYTICS_WINDOW_PARAM] as string | undefined) ??
      DEFAULT_ANALYTICS_WINDOW,
  );
  for (const [param, value] of Object.entries(resolved)) {
    if (param === ANALYTICS_WINDOW_PARAM) continue;
    if (value === null || value === undefined) continue;
    search.set(param, String(value));
  }
  const query = search.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

// Two-shape (not `ok`-tagged) union matching the original JS's `{label,days}` /
// `{error}` return -- callers narrow via `"error" in result`, same convention as
// ParamError-style returns elsewhere (workers/request-params.ts).
type WindowResult = { label: string; days: number } | { error: QueryError };

function analyticsWindow(url: URL, extraParams: string[] = []): WindowResult {
  const validationError = validateQueryParams(url, [
    ANALYTICS_WINDOW_PARAM,
    ...extraParams,
  ]);
  if (validationError) return { error: validationError };

  const requested = url.searchParams.get(ANALYTICS_WINDOW_PARAM);
  if (
    requested !== null &&
    !ANALYTICS_WINDOWS[requested as keyof typeof ANALYTICS_WINDOWS]
  ) {
    return {
      error: {
        parameter: ANALYTICS_WINDOW_PARAM,
        message: `"${requested}" is not a valid window. Supported: ${Object.keys(ANALYTICS_WINDOWS).join(", ")}.`,
      },
    };
  }

  const label = requested || DEFAULT_ANALYTICS_WINDOW;
  return {
    label,
    days: ANALYTICS_WINDOWS[label as keyof typeof ANALYTICS_WINDOWS],
  };
}

// Normalizes per-subnet health analytics URLs so a bare ?-free request and an
// explicit ?window=7d request both resolve to the same edge-cache entry — mirrors
// canonicalEconomicsTrendsCachePath in analytics-routes.ts.
export function canonicalHealthWindowCachePath(url: URL): string {
  const validationError = validateQueryParams(url, [ANALYTICS_WINDOW_PARAM]);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowResult = analyticsWindow(url);
  if ("error" in windowResult) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(windowResult.label)}`;
}

async function dataRateLimitResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.DATA_RATE_LIMITER?.limit) return null;
  const { success } = await env.DATA_RATE_LIMITER.limit({
    key: `data:${resolveClientIp(request)}`,
  });
  if (success) return null;
  return errorResponse(
    "data_rate_limited",
    "Too many data API requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": "60",
      "x-ratelimit-limit": "60",
      "x-ratelimit-policy": "60;w=60",
      "x-ratelimit-remaining": "0",
    },
  );
}

function analyticsQueryError(error: QueryError): Response {
  return errorResponse("invalid_query", error.message, 400, {
    parameter: error.parameter,
  });
}

function validateEnumParam(
  url: URL,
  parameter: string,
  allowedValues: readonly string[],
): QueryError | null {
  const raw = url.searchParams.get(parameter);
  if (raw === null) return null;
  if (allowedValues.includes(raw)) return null;
  return {
    parameter,
    message: `${parameter} must be one of: ${allowedValues.join(", ")}.`,
  };
}

// Enforce the declared `format` enum (json|csv). The per-handler allow-list only
// gates the param NAME, not its value — without this a `?format=xml` would be
// silently accepted, contradicting the contract's `enum: [json, csv]` (#2532).
function validateFormatParam(url: URL): QueryError | null {
  return validateEnumParam(url, "format", ["json", "csv"]);
}

// Bound an optional free-text filter so an oversized value never reaches D1.
function validateMaxLength(
  url: URL,
  parameter: string,
  max: number,
): QueryError | null {
  const raw = url.searchParams.get(parameter);
  if (raw !== null && raw.length > max) {
    return {
      parameter,
      message: `${parameter} must be ${max} characters or fewer.`,
    };
  }
  return null;
}

const POSTGRES_TIER_FALLBACK_RESPONSES = new WeakSet<Response>();

/**
 * The header a degraded response carries (#9110).
 *
 * A tier miss used to be invisible to the caller: the empty payload came back
 * `ok: true` with the same headers as a real one, so `total_extrinsics: 0` from
 * a missed tier read exactly like a measured zero. Observed live —
 * /api/v1/chain/calls?window=30d returned 0 in the same minute ?window=7d
 * returned 1,347,135, and 5,118,674 on the next attempt. That is worse than an
 * error: a client retries a 503 and publishes a zero.
 *
 * A HEADER and not a body field, deliberately. Writing `meta.degraded` into the
 * envelope means re-serialising it, which invalidates the ETag
 * `envelopeResponse` already computed — and recomputing it breaks conditional
 * requests, because the retry recomputes the ETag from the UNLABELLED body and
 * no longer matches. That is not hypothetical; it broke
 * "a warm cache honours conditional requests with a 304" when this was tried
 * body-first. The header carries the same information, costs no
 * re-serialisation, and works for the CSV variants too.
 */
export const DEGRADED_HEADER = "x-metagraph-degraded";
export const DEGRADED_TIER_UNAVAILABLE = "tier_unavailable";

/**
 * Tag a response as having used the empty-fallback path, and say so to the
 * caller.
 *
 * `withEdgeCache` reads the WeakSet on the object it gets back, so the NEW
 * response is what gets tagged — tagging the original would let a degraded
 * payload into the edge cache (the #1760 bug class this WeakSet exists for).
 */
function markPostgresTierFallbackResponse(response: Response): Response {
  // Set in place so the returned object IS the one passed in. Identity matters
  // here: `withEdgeCache` reads the WeakSet on the object it gets back, and
  // handlers hand this response straight on, so returning a copy would both
  // break that invariant and silently change what callers already assert.
  //
  // A response read back out of the edge cache has immutable headers; that path
  // never reaches this function today, and the copy is the correct fallback if
  // it ever does rather than throwing on a degraded response.
  try {
    response.headers.set(DEGRADED_HEADER, DEGRADED_TIER_UNAVAILABLE);
    POSTGRES_TIER_FALLBACK_RESPONSES.add(response);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(DEGRADED_HEADER, DEGRADED_TIER_UNAVAILABLE);
    const marked = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    POSTGRES_TIER_FALLBACK_RESPONSES.add(marked);
    return marked;
  }
}

async function analyticsMeta(
  env: Env,
  artifactPath: string,
  observedAt: unknown,
) {
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

// Edge-cache wrapper for the Postgres-backed analytics routes (audit #6). Each
// of these re-runs a full-window Postgres aggregation on EVERY request, yet
// the result only changes when the health cron writes a new snapshot — so a
// cross-colo / agent-polling burst re-executes the same 7d/30d aggregation
// needlessly (D1 fully eliminated 2026-07-17 -- see this file's own header).
// Mirrors the
// live-overlay collection cache exactly (the CACHEABLE_OVERLAY_ROUTE_IDS path):
// same Cache API, same `edge-cache.metagraph.sh` key host, same last_run_at
// keying, same conditional-GET 304 short-circuit, same ctx.waitUntil put.
//
// The key varies on everything that changes the body: contract_version (a deploy
// can never serve a cross-version payload) + a freshness stamp + the request
// path (carries netuid) + the canonical search (carries `window`). The stamp is
// the health cron snapshot (`last_run_at`) for every route, including chain/
// identity-history -- its own bespoke `readIdentityHistoryCacheStamp` stamp was
// retired alongside the D1 read it existed to bust on (D1 fully eliminated,
// 2026-07-16), the same way the neurons/neuron_daily-backed stamps were
// retired when #4772 dropped those tables from D1. `resolveCacheStamp` stays
// as an override hook for any future bespoke-stamp need, just unused today.
// `keyParts` is the extra namespace segment per route. When the stamp is cold
// (null), caching is skipped entirely so a cold-KV/empty payload can never seed
// a stale entry — identical to the overlay cache's `if (lastRunAt)` guard. The
// cache is transparent: body/shape/headers are whatever buildResponse() produced;
// only 200s are cached, never errors.
// Loose, structural ExecutionContext -- every call site here either receives
// the real Workers-runtime ExecutionContext or, from a handler invoked with no
// ctx (e.g. a direct unit-test call), the `= {}` default; both only ever need
// `waitUntil`, so a full ExecutionContext isn't required to satisfy this type.
export interface EdgeCacheCtx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function withEdgeCache(
  request: Request,
  ctx: EdgeCacheCtx | undefined,
  env: Env,
  keyParts: string,
  buildResponse: (cacheRequest: Request) => Response | Promise<Response>,
  cachePathAndSearch: string | null = null,
  resolveCacheStamp: ((env: Env) => Promise<string | null>) | null = null,
): Promise<Response> {
  const isHead = request.method === "HEAD";
  // Only opt HEAD into the GET cache path for handlers that accept the
  // normalized request. Legacy zero-arg builders may close over the original
  // HEAD request and return a bodyless response, which must not seed the GET
  // cache for later clients.
  const normalizesHead = isHead && buildResponse.length > 0;
  const cacheRequest = normalizesHead
    ? new Request(request, { method: "GET" })
    : request;
  // `globalThis.caches` (not the bare `caches` global) so the optional
  // chain actually guards: Node/vitest has no Cache API global at all,
  // unlike the real Workers runtime where `caches` is always populated --
  // the bare identifier's ambient `declare const caches: CacheStorage` types
  // it as unconditionally present, which would be true at compile time but
  // false at this test-runtime.
  const cache =
    cacheRequest.method === "GET"
      ? (globalThis as { caches?: CacheStorage }).caches?.default
      : null;
  // Cheap freshness read. On a hit this + the cache match is the whole request
  // (no D1 aggregation at all for the handler body).
  let stamp = null;
  if (cache) {
    if (typeof resolveCacheStamp === "function") {
      // resolveCacheStamp is an override hook for a future bespoke-stamp
      // need (see its own doc comment above) -- no call site passes one
      // today, so this branch is genuinely unreachable right now.
      /* v8 ignore start */
      stamp = await resolveCacheStamp(env);
      /* v8 ignore stop */
    } else {
      stamp = (await readHealthMetaKv(env))?.last_run_at ?? null;
    }
  }
  let cacheKey = null;
  if (cache && stamp) {
    const url = new URL(cacheRequest.url);
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
      if (ifNoneMatchSatisfied(request, hit.headers.get("etag") || "")) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return normalizesHead
        ? new Response(null, { status: hit.status, headers: hit.headers })
        : hit;
    }
  }
  const pgFallbackGeneration = currentPostgresTierFallbackGeneration();
  const built = await buildResponse(cacheRequest);
  // #9110: the generation counter already told us the tier degraded while this
  // request was being served -- it is what suppresses caching two lines down.
  // Until now that was the ONLY thing it did, so 16 of the 21 tier-reading
  // handlers returned an unlabelled empty payload: `total: 0`, `ok: true`, and
  // no way for a caller to tell it from a measured zero.
  //
  // Labelling here rather than in each handler is deliberate. Only 5 of the 21
  // remembered to call markPostgresTierFallbackResponse; a per-handler flag is
  // exactly the thing the 22nd handler will forget. Every one of them already
  // goes through this function.
  //
  // The counter is module-global, so a CONCURRENT request degrading can label
  // this one too. That is the same trade the cache-suppression below already
  // makes, and it errs the safe way: a false "degraded" makes good data look
  // suspect, where the bug it replaces made missing data look measured.
  const degraded =
    POSTGRES_TIER_FALLBACK_RESPONSES.has(built) ||
    currentPostgresTierFallbackGeneration() !== pgFallbackGeneration;
  const response =
    degraded && built.status === 200 && !built.headers.has(DEGRADED_HEADER)
      ? markPostgresTierFallbackResponse(built)
      : built;
  // Never cache errors / non-200s (a cold Postgres tier still returns a 200
  // empty envelope; a 400 bad-window or 5xx must not be persisted).
  if (
    cache &&
    cacheKey &&
    response.status === 200 &&
    !POSTGRES_TIER_FALLBACK_RESPONSES.has(response) &&
    currentPostgresTierFallbackGeneration() === pgFallbackGeneration
  ) {
    ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
  }
  return normalizesHead
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// Postgres-backed 7d/30d daily uptime + latency trends across all subnets
// (D1 fully eliminated 2026-07-17 -- see this file's own header). This is a
// compact matrix feed for UI dashboards and agents, so it groups by netuid/day
// instead of returning every surface series.
export async function handleBulkHealthTrends(
  request: Request,
  env: Env,
  url: URL = new URL(request.url),
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  for (const key of url.searchParams.keys()) {
    return errorResponse(
      "invalid_query",
      `${key} is not supported for this route.`,
      400,
      { parameter: key },
    );
  }

  return withEdgeCache(
    request,
    ctx,
    env,
    "bulk-trends",
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4832 gap-closure: METAGRAPH_HEALTH_SOURCE was left unset in
      // wrangler.jsonc for a long stretch after this tier's tryPostgresTier
      // wiring landed -- surface_checks/surface_uptime_daily only started
      // accumulating from the dual-write landing (#4881/#4885), with no
      // historical backfill, and an empty/short Postgres window is still a
      // valid 200 response that tryPostgresTier's error-only fallback can't
      // tell apart from "technically fine but missing D1's history". FLIPPED
      // to "postgres" (D1 retirement, 2026-07-16) once Postgres accumulated a
      // real window: direct `psql` confirmed surface_checks holds 111,088 rows
      // and surface_uptime_daily holds 1,182 rows spanning 2026-07-11 through
      // 2026-07-16, a full rolling window. See wrangler.jsonc's own comment on
      // this flag for the complete verification writeup.
      let isFallback = false;
      let data = (await tryPostgresTier(
        env,
        cacheRequest,
        "METAGRAPH_HEALTH_SOURCE",
      )) as Awaited<ReturnType<typeof loadBulkHealthTrends>>["data"] | null;
      if (!data) {
        // D1-served payloads are cacheable; only a genuinely empty one is not.
        // `isFallback` bars the edge cache, so it must mean "this payload is
        // the schema-stable empty", not merely "the Postgres tier missed" --
        // since 2026-08-03 a tier miss is the NORMAL path and D1 answers it
        // with real rows. Mirrors handleSubnetUptime in analytics-routes.ts.
        const d1Generation = currentD1ReadFailureGeneration();
        const result = await loadBulkHealthTrends({
          observedAt: meta?.last_run_at || null,
          db: env.METAGRAPH_HEALTH_DB,
        });
        data = result.data;
        isFallback =
          !env.METAGRAPH_HEALTH_DB ||
          currentD1ReadFailureGeneration() !== d1Generation;
      }
      const response = await envelopeResponse(
        cacheRequest,
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
      return isFallback ? markPostgresTierFallbackResponse(response) : response;
    },
  );
}

// Postgres-backed 7d/30d uptime + latency trends for one subnet's operational
// surfaces (D1 fully eliminated 2026-07-17 -- see this file's own header).
// Returns a schema-stable empty payload on a Postgres-tier miss so it never
// errors (mirrors the live-overlay fall-back philosophy). The query +
// formatting live in loadSubnetHealthTrends (src/analytics-live.ts) so the
// get_subnet_health_trends MCP tool shares this exact read path (#2335).
export async function handleHealthTrends(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  // Reject unsupported query params (400) like every sibling analytics route
  // (percentiles/incidents/uptime/trajectory and the bulk trends route); this
  // route takes no params and returns all configured windows.
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  return withEdgeCache(request, ctx, env, "trends", async (cacheRequest) => {
    // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
    let usedFallback = false;
    let data = (await tryPostgresTier(
      env,
      cacheRequest,
      "METAGRAPH_HEALTH_SOURCE",
    )) as Awaited<ReturnType<typeof loadSubnetHealthTrends>> | null;
    if (!data) {
      // Read through the shared d1All (rather than handing the loader the bare
      // db) so a failure is still logged + marked as a D1 fallback (the
      // dark-serve log contract) — a Postgres-tier miss now falls straight
      // through to the pure formatter with no rows (never a live D1 query),
      // so it's always marked a fallback (never edge-cache a schema-stable
      // empty payload).
      // Only an EMPTY payload is barred from the edge cache — no D1 binding,
      // or a D1 read that failed mid-load (tracked by the failure generation,
      // the same contract the Postgres tier uses). A D1-served response
      // carries real rows and caches like any tier hit (the pre-elimination
      // behavior this route always had).
      const d1Generation = currentD1ReadFailureGeneration();
      const meta = await readHealthMetaKv(env);
      data = await loadSubnetHealthTrends(netuid, {
        observedAt: meta?.last_run_at || null,
        db: env.METAGRAPH_HEALTH_DB,
      } as unknown as Parameters<typeof loadSubnetHealthTrends>[1]);
      usedFallback =
        !env.METAGRAPH_HEALTH_DB ||
        currentD1ReadFailureGeneration() !== d1Generation;
    }
    const response = await envelopeResponse(
      cacheRequest,
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
    return usedFallback ? markPostgresTierFallbackResponse(response) : response;
  });
}

// p50/p95/p99 latency percentiles per surface, computed in Postgres (D1 fully
// eliminated 2026-07-17 -- see this file's own header). The query +
// formatting live in loadSubnetPercentiles (src/analytics-live.ts) so the
// get_subnet_health_percentiles MCP tool shares this exact read path.
export async function handleHealthPercentiles(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  return withEdgeCache(
    request,
    ctx,
    env,
    "percentiles",
    async (cacheRequest) => {
      // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
      let usedFallback = false;
      let data = (await tryPostgresTier(
        env,
        cacheRequest,
        "METAGRAPH_HEALTH_SOURCE",
      )) as Awaited<ReturnType<typeof loadSubnetPercentiles>> | null;
      if (!data) {
        // A Postgres-tier miss now falls straight through to the pure
        // formatter with no rows (never a live D1 query), so it's always
        // marked a fallback (mirrors handleHealthTrends).
        // Cacheable when D1-served — see handleHealthTrends' comment.
        const d1Generation = currentD1ReadFailureGeneration();
        const meta = await readHealthMetaKv(env);
        data = await loadSubnetPercentiles(netuid, {
          window: label,
          observedAt: meta?.last_run_at || null,
          db: env.METAGRAPH_HEALTH_DB,
        } as unknown as Parameters<typeof loadSubnetPercentiles>[1]);
        usedFallback =
          !env.METAGRAPH_HEALTH_DB ||
          currentD1ReadFailureGeneration() !== d1Generation;
      }
      const response = await envelopeResponse(
        cacheRequest,
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
      return usedFallback
        ? markPostgresTierFallbackResponse(response)
        : response;
    },
    canonicalHealthWindowCachePath(url),
  );
}

// SLA + reconstructed downtime incidents per surface.
export async function handleHealthIncidents(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  return withEdgeCache(
    request,
    ctx,
    env,
    "incidents",
    async (cacheRequest) => {
      // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
      let usedFallback = false;
      let data = (await tryPostgresTier(
        env,
        cacheRequest,
        "METAGRAPH_HEALTH_SOURCE",
      )) as Awaited<ReturnType<typeof loadSubnetIncidents>> | null;
      if (!data) {
        // A Postgres-tier miss now falls straight through to the pure
        // formatter with no rows (never a live D1 query), so it's always
        // marked a fallback (mirrors handleHealthTrends / handleHealthPercentiles).
        // Cacheable when D1-served — see handleHealthTrends' comment.
        const d1Generation = currentD1ReadFailureGeneration();
        const meta = await readHealthMetaKv(env);
        data = await loadSubnetIncidents(netuid, {
          window: label,
          observedAt: meta?.last_run_at || null,
          db: env.METAGRAPH_HEALTH_DB,
        } as unknown as Parameters<typeof loadSubnetIncidents>[1]);
        usedFallback =
          !env.METAGRAPH_HEALTH_DB ||
          currentD1ReadFailureGeneration() !== d1Generation;
      }
      const response = await envelopeResponse(
        cacheRequest,
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
      return usedFallback
        ? markPostgresTierFallbackResponse(response)
        : response;
    },
    canonicalHealthWindowCachePath(url),
  );
}

// Global, cross-subnet incident ledger — the same gap-island grouping as the
// per-subnet route but with no netuid filter, grouped by (netuid, surface_id)
// and capped. Powers a public status page's "recent incidents" feed.
//
// D1 fully eliminated (2026-07-17): surface_checks is Postgres-only now (every
// caller tries the Postgres tier first) -- this is only reached on a tier
// miss, so it always returns the schema-stable empty payload.
export async function loadGlobalIncidentsLedger(
  env: Env,
  { label = "7d", days = 7 }: { label?: string; days?: number } = {},
) {
  // D1 reads resurrected (2026-08-02, box decommission): the rows come from
  // the dual-written surface_checks copy in D1 — no binding, no rows, which
  // is exactly the empty stub this was between 2026-07-17 and now.
  const incidentRows = await loadGlobalIncidentRows(
    env.METAGRAPH_HEALTH_DB as unknown as ObservationsReadDb,
    days,
  );
  const meta = await readHealthMetaKv(env);
  const data = formatGlobalIncidents({
    window: label,
    observedAt: meta?.last_run_at || null,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
  return { data, incidentRows };
}

/**
 * Resolve the global incident ledger the way every caller must: Postgres tier
 * first, the schema-stable empty stub above only on a miss.
 *
 * The stub is NOT a data source — it hardcodes `incidentRows: []`. Calling
 * loadGlobalIncidentsLedger directly therefore always yields zero incidents,
 * which is exactly what /api/v1/feeds/incidents did: it bypassed the Postgres
 * tier, so the feed reported "no incidents" while /status, reading through the
 * route below, showed dozens ongoing from the same underlying data (#8242).
 *
 * `request` matters here, not just as plumbing: `tryPostgresTier` forwards it
 * VERBATIM to the DATA_API service binding, so the caller must already be
 * handling the same path DATA_API should answer (as handleGlobalIncidents
 * below does for its own /api/v1/incidents request). #8242 fixed every OTHER
 * caller this way but missed that /api/v1/feeds/incidents's own request
 * doesn't qualify — see resolveGlobalIncidentsForFeed, the fix for that
 * (metagraphed#8353).
 */
export async function resolveGlobalIncidents(
  request: Request,
  env: Env,
  { label = "7d", days = 7 }: { label?: string; days?: number } = {},
): Promise<{ data: Record<string, unknown>; isFallback: boolean }> {
  const tiered = (await tryPostgresTier(
    env,
    request,
    "METAGRAPH_HEALTH_SOURCE",
  )) as Record<string, unknown> | null;
  if (tiered) return { data: tiered, isFallback: false };
  const d1Generation = currentD1ReadFailureGeneration();
  const result = await loadGlobalIncidentsLedger(env, { label, days });
  return {
    data: result.data as unknown as Record<string, unknown>,
    // Only an EMPTY ledger counts as a fallback for caching purposes — no D1
    // binding, or a D1 read failure mid-load. A D1-served ledger carries
    // real rows.
    isFallback:
      !env.METAGRAPH_HEALTH_DB ||
      currentD1ReadFailureGeneration() !== d1Generation,
  };
}

/**
 * The one correct way for /api/v1/feeds/incidents to reach the same data
 * /status shows (metagraphed#8353).
 *
 * resolveGlobalIncidents's `request` argument isn't incidental — tryPostgresTier
 * forwards it, unmodified, to the DATA_API service binding, so whatever path
 * that request carries is the path DATA_API tries to route. The feed handler's
 * OWN incoming request is for /api/v1/feeds/incidents(.json|.rss|.atom), a path
 * DATA_API has no route for at all; forwarding it verbatim (what #8242's fix
 * did) makes DATA_API 404, which tryPostgresTier reads as a tier miss and
 * silently degrades to the empty stub — the exact "feed says zero incidents,
 * /status says dozens" symptom #8242 believed it had fixed.
 *
 * The fix is a synthetic request for the path the status page's own default
 * view actually queries (GET /api/v1/incidents?window=7d) — the "https://d"
 * placeholder origin matches this file's sibling readChainEventsDb, which
 * constructs the same kind of same-worker service-binding request for the
 * same reason. Both share `resolveGlobalIncidents`'s 7d default label so a
 * future window-default change to one can't silently orphan the other.
 */
export async function resolveGlobalIncidentsForFeed(
  env: Env,
): Promise<Record<string, unknown>> {
  const { data } = await resolveGlobalIncidents(
    new Request("https://d/api/v1/incidents?window=7d"),
    env,
  );
  return data;
}

// The list-query params GET /api/v1/incidents accepts on top of its own `window`
// scope (#6571): limit/cursor/sort/order + the netuid filter, so a caller can page
// a 30-day incident list the way the sibling endpoint-incidents route already can.
const GLOBAL_INCIDENTS_LIST_PARAMS = listQueryParamNames("incidents");

export async function handleGlobalIncidents(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const windowResult = analyticsWindow(url, GLOBAL_INCIDENTS_LIST_PARAMS);
  if ("error" in windowResult) {
    return analyticsQueryError(windowResult.error);
  }
  const { label, days } = windowResult;
  // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
  const { data, isFallback } = await resolveGlobalIncidents(request, env, {
    label,
    days,
  });
  // Page/sort/filter the window-scoped `surfaces` ledger through the shared
  // list-query engine (#6571). `window` is this route's own scope param, already
  // validated above, so it is stripped before the engine — which only knows the
  // collection's own vocabulary and would otherwise reject it as an unknown param.
  const listUrl = new URL(url.href);
  listUrl.searchParams.delete("window");
  const transformed = applyQueryFilters(data, listUrl, "incidents");
  if (transformed.error) {
    return analyticsQueryError(transformed.error);
  }
  // Pin the resolved window onto every page link so paging a non-default window
  // doesn't silently fall back to 7d (canonicalListSearch keeps only list params).
  const link = paginationLinkHeader(
    url,
    transformed.meta?.pagination as Pagination | null | undefined,
    {
      queryCollection: "incidents",
      searchParams: { window: label },
    },
  );
  const response = await envelopeResponse(
    request,
    {
      data: transformed.data,
      meta: {
        ...(await analyticsMeta(
          env,
          "/metagraph/incidents.json",
          data.observed_at,
        )),
        ...transformed.meta,
      },
    },
    "short",
    link ? { link } : {},
  );
  return isFallback ? markPostgresTierFallbackResponse(response) : response;
}

// Explicit CSV column order for the chain-analytics ?format=csv exports (#2532).
// Passed to csvResponse so a cold store (empty array) still emits a header row,
// and column order stays stable regardless of row-key insertion order.
const CHAIN_ACTIVITY_CSV_COLUMNS = [
  "day",
  "block_count",
  "extrinsic_count",
  "event_count",
  "successful_extrinsics",
  "success_rate",
  "unique_signers",
];
// group_by=module rows carry call_function:null, so the default export omits that
// column; group_by=module_function adds it — keeping the CSV header honest per grouping.
const CHAIN_CALLS_CSV_COLUMNS = ["call_module", "count", "share"];
const CHAIN_CALLS_FUNCTION_CSV_COLUMNS = [
  "call_module",
  "call_function",
  "count",
  "share",
];
const CHAIN_SIGNERS_CSV_COLUMNS = [
  "signer",
  "tx_count",
  "total_fee_tao",
  "total_tip_tao",
  "last_tx_block",
];
// The fee-market CSV exports the per-day fee series (data.daily) — the primary
// row-shaped table, mirroring chain-activity; the top_fee_payers leaderboard
// stays JSON-only in the envelope.
const CHAIN_FEES_CSV_COLUMNS = [
  "day",
  "extrinsic_count",
  "signed_extrinsic_count",
  "total_fee_tao",
  "avg_fee_tao",
  "median_fee_tao",
  "total_tip_tao",
  "avg_tip_tao",
  "median_tip_tao",
];
// The stake-flow CSV exports the per-subnet capital-flow leaderboard (data.subnets)
// — the row-shaped table, mirroring chain-signers; the network rollup and
// net_flow_distribution stay JSON-only in the envelope.
const CHAIN_STAKE_FLOW_CSV_COLUMNS = [
  "netuid",
  "total_staked_tao",
  "total_unstaked_tao",
  "net_flow_tao",
  "gross_flow_tao",
  "stake_events",
  "unstake_events",
  "direction",
];

// The alpha-volume CSV exports the per-subnet leaderboard (data.subnets) — each row is a full
// buildAlphaVolume scorecard (schema_version/window omitted here as constant across every row);
// the network rollup + volume_distribution stay JSON-only, mirroring chain-stake-flow.
const CHAIN_ALPHA_VOLUME_CSV_COLUMNS = [
  "netuid",
  "buy_volume_alpha",
  "sell_volume_alpha",
  "total_volume_alpha",
  "buy_volume_tao",
  "sell_volume_tao",
  "total_volume_tao",
  "buy_count",
  "sell_count",
  "net_volume_alpha",
  "sentiment_ratio",
  "sentiment",
  "vol_mcap_ratio",
];

// CSV column order for the /api/v1/chain/weights per-subnet leaderboard rows
// (the row-shaped `subnets` array). The network rollup + intensity_distribution
// stay JSON-only, mirroring chain-stake-flow.
const CHAIN_WEIGHTS_CSV_COLUMNS = [
  "netuid",
  "distinct_setters",
  "weight_sets",
  "sets_per_setter",
];

// CSV column order for the /api/v1/chain/weights/setters network-wide leaderboard rows.
const CHAIN_WEIGHT_SETTERS_CSV_COLUMNS = [
  "hotkey",
  "netuid",
  "uid",
  "weight_sets",
  "share",
  "first_set_at",
  "last_set_at",
];

// CSV column order for the /api/v1/chain/serving per-subnet leaderboard rows (the
// row-shaped `subnets` array). The network rollup + intensity_distribution stay
// JSON-only, mirroring chain-weights / chain-stake-flow.
const CHAIN_SERVING_CSV_COLUMNS = [
  "netuid",
  "distinct_servers",
  "announcements",
  "announcements_per_server",
];

const CHAIN_REGISTRATIONS_CSV_COLUMNS = [
  "netuid",
  "distinct_registrants",
  "registrations",
  "registrations_per_registrant",
];

const CHAIN_DEREGISTRATIONS_CSV_COLUMNS = [
  "netuid",
  "distinct_deregistered_hotkeys",
  "deregistrations",
  "deregistrations_per_hotkey",
];

const CHAIN_PROMETHEUS_CSV_COLUMNS = [
  "netuid",
  "distinct_exporters",
  "announcements",
  "announcements_per_exporter",
];

const CHAIN_AXON_REMOVALS_CSV_COLUMNS = [
  "netuid",
  "distinct_removers",
  "removals",
  "removals_per_remover",
];

const CHAIN_STAKE_MOVES_CSV_COLUMNS = [
  "netuid",
  "distinct_movers",
  "movements",
  "movements_per_mover",
];

const CHAIN_STAKE_TRANSFERS_CSV_COLUMNS = [
  "netuid",
  "distinct_senders",
  "transfers",
  "transfers_per_sender",
];

// CSV column order for the /api/v1/chain/transfer-pairs top corridors (the
// row-shaped `pairs` array). The totals + top_pair_share rollup stay JSON-only,
// mirroring chain-stake-flow / chain-weights.
const CHAIN_TRANSFER_PAIRS_CSV_COLUMNS = [
  "from",
  "to",
  "volume_tao",
  "transfer_count",
  "last_block",
  "last_observed_at",
];

// The transfers CSV exports the top-senders and top-receivers leaderboards as one
// row set tagged by a `direction` column (sender|receiver) rather than as two
// separate exports, since both share the same per-address shape; the scorecard
// totals + top_sender_share rollup stay JSON-only, mirroring chain-transfer-pairs.
const CHAIN_TRANSFERS_CSV_COLUMNS = [
  "direction",
  "address",
  "volume_tao",
  "transfer_count",
];

// Daily network-activity aggregates over the first-party chain D1 tiers (#1987):
// per-UTC-day extrinsic/event/block counts, success rate, and unique signers —
// the foundation time-series for the block-explorer "network at a glance" view
// (epic #1986). Two independent GROUP-BY-day aggregations (extrinsics + blocks)
// run in parallel and merge in the pure builder, so the route is schema-stable
// (day_count:0, days:[]) on a cold store and never re-aggregates on an edge hit.
export async function handleChainActivity(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label, days: windowDays } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-activity",
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: extrinsics'/blocks' D1 write path is retired
      // (#4772) and the tables are dropped in production, so a D1 query here
      // would always miss. Postgres → schema-stable empty stub, never a live
      // D1 read.
      // #8242: the upstream aggregation buckets by UTC day across a
      // `now - N days` range, so a 7d window comes back as 8 calendar days (a
      // partial today plus a partial tail day). Trim to the window the caller
      // actually asked for so day_count can't contradict the window label.
      const data = trimChainActivityToWindow(
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_EXTRINSICS_SOURCE",
        )) as ReturnType<typeof buildChainActivity> | null) ??
          // The projection tier (#9146): a cron recomputes this window's
          // daily series from the lakehouse; the reader feeds the same
          // formatter, and the #8242 trim below applies to it exactly as it
          // applies to a live answer. See src/chain-activity-artifact.ts.
          (await loadChainActivityFromArtifact(env, { window: label })) ??
          buildChainActivity({
            window: label,
            observedAt: meta?.last_run_at || null,
          } as unknown as Parameters<typeof buildChainActivity>[0]),
        windowDays,
      );
      if (csv) {
        return csvResponse(
          data.days,
          "chain-activity",
          "short",
          cacheRequest,
          CHAIN_ACTIVITY_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
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
    },
    // Canonicalize the cache key on the RESOLVED window so the bare path, an
    // explicit ?window=<default>, and reordered/duplicate variants all share one
    // entry instead of fragmenting the cache (mirrors the percentiles/incidents/
    // economics-trends windowed routes). `label` is the validated window.
    `${url.pathname}?window=${encodeURIComponent(label)}${csv ? "&format=csv" : ""}`,
  );
}

// Extrinsic call-mix breakdown (#1989): counts + share per call_module (or
// call_module/call_function). The share denominator is the full-window extrinsic
// count read separately, so the truncated LIMIT tail never skews shares.
export async function handleChainCalls(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, [
    "group_by",
    "limit",
    "call_module",
    "format",
  ]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const groupByError = validateEnumParam(url, "group_by", [
    "module",
    "module_function",
  ]);
  if (groupByError) return analyticsQueryError(groupByError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: 50,
    maxLimit: 100,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const groupBy = url.searchParams.get("group_by") || "module";
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-calls",
    async (cacheRequest) => {
      // #4772 D1 retirement: the `extrinsics` D1 table is dropped in production, so
      // a postgres-tier miss now falls straight back to the pure builder with no
      // rows (never a live D1 query) -- always mark that response as a fallback
      // (never edge-cache a schema-stable empty payload).
      let usedFallback = false;
      const meta = await readHealthMetaKv(env);
      let data = (await tryPostgresTier(
        env,
        cacheRequest,
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as ReturnType<typeof buildChainCalls> | null;
      // The projection tier (#9146): a cron recomputes this window's call
      // mix (both group_by variants) from the lakehouse; the reader slices
      // to the request's limit and feeds the same formatter, declining any
      // call_module scope. A projected answer is a real answer, so it is
      // never marked as a fallback. See src/chain-calls-artifact.ts.
      data ??= await loadChainCallsFromArtifact(env, {
        window: label,
        groupBy,
        limit,
        callModule: url.searchParams.get("call_module"),
      });
      if (!data) {
        usedFallback = true;
        data = buildChainCalls({
          window: label,
          groupBy,
          observedAt: meta?.last_run_at || null,
          total: 0,
          rows: [],
        } as unknown as Parameters<typeof buildChainCalls>[0]);
      }
      if (csv) {
        const csvRes = await csvResponse(
          data.calls,
          "chain-calls",
          "short",
          cacheRequest,
          groupBy === "module_function"
            ? CHAIN_CALLS_FUNCTION_CSV_COLUMNS
            : CHAIN_CALLS_CSV_COLUMNS,
        );
        return usedFallback ? markPostgresTierFallbackResponse(csvRes) : csvRes;
      }
      const response = await envelopeResponse(
        cacheRequest,
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
      return usedFallback
        ? markPostgresTierFallbackResponse(response)
        : response;
    },
    `${canonicalAnalyticsCacheRoute(url, {
      window: label,
      group_by: groupBy,
      limit,
      call_module: url.searchParams.get("call_module"),
    })}${csv ? "&format=csv" : ""}`,
  );
}

// Windowed most-active-account leaderboard (#1990): signers ranked by extrinsic
// count over the window. The observed_at index bounds the scan to the hot window;
// the aggregation is amortized behind the edge cache (runs only on a new snapshot).
export async function handleChainSigners(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, [
    "limit",
    "call_module",
    "sort",
    "format",
  ]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const sortError = validateEnumParam(url, "sort", CHAIN_SIGNERS_SORTS);
  if (sortError) return analyticsQueryError(sortError);
  // limit/call_module no longer feed a live D1 read (see the retirement note
  // below) but are still shape-validated so the REST contract stays stable.
  const limitResult = parseLimitParam(url, {
    defaultLimit: 50,
    maxLimit: 100,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const sort = url.searchParams.get("sort") || "tx_count";
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-signers",
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and
      // the table is dropped in production, so a D1 query here would always
      // miss (#6013). Postgres → schema-stable empty stub, never a live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_EXTRINSICS_SOURCE",
        )) as ReturnType<typeof buildChainSigners> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // leaderboard (both sorts) from the lakehouse; the reader slices to
        // the request's limit and feeds the same formatter, declining any
        // call_module scope. See src/chain-signers-artifact.ts.
        (await loadChainSignersFromArtifact(env, {
          window: label,
          sort,
          limit,
          callModule: url.searchParams.get("call_module"),
        })) ??
        buildChainSigners({
          window: label,
          sort,
          observedAt: meta?.last_run_at || null,
          rows: [],
        } as unknown as Parameters<typeof buildChainSigners>[0]);
      if (csv) {
        return csvResponse(
          data.signers,
          "chain-signers",
          "short",
          cacheRequest,
          CHAIN_SIGNERS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
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
    },
    `${canonicalAnalyticsCacheRoute(url, {
      window: label,
      limit,
      call_module: url.searchParams.get("call_module"),
      sort,
    })}${csv ? "&format=csv" : ""}`,
  );
}

// Network-wide native-TAO transfer analytics: total Balances.Transfer volume over the
// window, the top senders + receivers by volume, and the top senders' share of total
// volume (a concentration signal), from the account_events Transfer feed. The
// network-level companion of /accounts/{ss58}/transfers + /counterparties.
export async function handleChainTransfers(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  // limit no longer feeds a live D1 read (see the retirement note below) but
  // is still shape-validated so the REST contract stays stable.
  const limitResult = parseLimitParam(url, {
    defaultLimit: 25,
    maxLimit: 100,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  // HEAD probes are globally allowed for read-only API routes. Normalize them
  // through the GET cache key so a transfer-analytics probe cannot bypass the
  // edge cache and repeatedly force the network-wide D1 aggregations. The
  // response is stripped back to HEAD semantics after the cache lookup/miss.
  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-transfers",
    async () => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainTransfers> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // scorecard from the lakehouse; the artifact reader slices to the
        // request's limit and feeds the same formatter. See
        // src/chain-transfers-artifact.ts.
        (await loadChainTransfersFromArtifact(env, {
          window: label,
          limit,
        })) ??
        buildChainTransfers({
          window: label,
          observedAt: meta?.last_run_at || null,
        });
      if (csv) {
        return csvResponse(
          [
            ...data.top_senders.map((row) => ({
              direction: "sender",
              ...row,
            })),
            ...data.top_receivers.map((row) => ({
              direction: "receiver",
              ...row,
            })),
          ],
          "chain-transfers",
          "short",
          cacheRequest,
          CHAIN_TRANSFERS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
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
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// Network-wide native-TAO transfer-pair analytics: top sender -> receiver pairs by
// volume or count over the window, from the same account_events Transfer feed as
// /chain/transfers. Excludes malformed/self-transfer rows so every row represents
// a real directed account corridor.
export async function handleChainTransferPairs(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "sort", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const sortError = validateEnumParam(url, "sort", CHAIN_TRANSFER_PAIR_SORTS);
  if (sortError) return analyticsQueryError(sortError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  // limit no longer feeds a live D1 read (see the retirement note below) but
  // is still shape-validated so the REST contract stays stable.
  const limitResult = parseLimitParam(url, {
    defaultLimit: 25,
    maxLimit: 100,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const sort = url.searchParams.get("sort") || "volume";
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-transfer-pairs",
    async () => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainTransferPairs> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // corridor leaderboard (both sorts) from the lakehouse; the reader
        // slices to the request's limit and feeds the same formatter. See
        // src/chain-transfer-pairs-artifact.ts.
        (await loadChainTransferPairsFromArtifact(env, {
          window: label,
          sort,
          limit,
        })) ??
        buildChainTransferPairs({
          window: label,
          sort,
          observedAt: meta?.last_run_at || null,
        } as unknown as Parameters<typeof buildChainTransferPairs>[0]);
      // CSV exports the row-shaped top corridors; the totals + top_pair_share
      // rollup stay JSON-only (mirrors chain-stake-flow / chain-weights).
      if (csv) {
        return csvResponse(
          data.pairs,
          "chain-transfer-pairs",
          "short",
          cacheRequest,
          CHAIN_TRANSFER_PAIRS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/transfer-pairs.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, {
      window: label,
      limit,
      sort,
    })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// Network-wide cross-subnet capital flow: rank every subnet by net StakeAdded - StakeRemoved
// over the window from the account_events stream, with a network rollup and a net-flow
// distribution. The network companion to /api/v1/subnets/{netuid}/stake-flow; edge-cached like
// the sibling chain-transfers route (account_events-derived, analytics cron freshness).
export async function handleChainStakeFlow(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
    maxLimit: CHAIN_STAKE_FLOW_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  // Normalize HEAD probes through the GET cache key so they cannot bypass the edge cache and
  // repeatedly force the network-wide account_events aggregation (mirrors chain-transfers).
  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-stake-flow",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainStakeFlow> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // per-(netuid, event_kind) aggregate from the lakehouse; the shared
        // builder owns ranking and the limit. See
        // src/chain-stake-flow-artifact.ts.
        (await loadChainStakeFlowFromArtifact(env, {
          window: label,
          limit,
        })) ??
        buildChainStakeFlow([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainStakeFlow>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // net_flow_distribution stay JSON-only (mirrors chain-fees' top_fee_payers).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-stake-flow",
          "short",
          cacheRequest,
          CHAIN_STAKE_FLOW_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/stake-flow.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// Canonicalizes the /chain/alpha-volume cache key on `limit` only -- this route has no ?window=
// param (fixed 24h, mirroring handleSubnetAlphaVolume's own framing), so there is no window value
// to normalize into the key the way canonicalAnalyticsCacheRoute does for every windowed sibling.
// `csv` is folded in directly (rather than string-concatenated after, like the windowed routes
// do) so a bare request never produces a dangling "&format=csv" with no leading "?".
function canonicalChainAlphaVolumeCacheRoute(url: URL, csv: boolean): string {
  const search = new URL("https://cache-key.invalid/").searchParams;
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null) search.set("limit", limitParam);
  if (csv) search.set("format", "csv");
  const query = search.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

// Network-wide rolling 24h buy/sell alpha-volume leaderboard: rank every subnet by
// total_volume_tao from the account_events stream, with a network rollup (including its own
// net/gross sentiment reading) and a total-volume distribution. The network companion to
// /api/v1/subnets/{netuid}/volume; edge-cached like the sibling chain-stake-flow route
// (account_events-derived, analytics cron freshness). Fixed 24h window, no ?window= param --
// mirrors handleSubnetAlphaVolume's own framing (#4339's scope: a canonical market-depth
// figure, not a windowed analytics view).
export async function handleChainAlphaVolume(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const validationError = validateQueryParams(url, ["limit", "format"]);
  if (validationError) return analyticsQueryError(validationError);
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
    maxLimit: CHAIN_ALPHA_VOLUME_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  // Normalize HEAD probes through the GET cache key so they cannot bypass the edge cache and
  // repeatedly force the network-wide account_events aggregation (mirrors chain-stake-flow).
  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-alpha-volume",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainAlphaVolume> | null) ??
        // The projection tier (#9146): a cron recomputes the fixed 24h
        // per-(netuid, event_kind) aggregate from the lakehouse; the shared
        // builder owns ranking and the limit. See
        // src/chain-alpha-volume-artifact.ts.
        (await loadChainAlphaVolumeFromArtifact(env, { limit })) ??
        buildChainAlphaVolume([], {
          limit,
        } as unknown as Parameters<typeof buildChainAlphaVolume>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // volume_distribution stay JSON-only (mirrors chain-stake-flow).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-alpha-volume",
          "short",
          cacheRequest,
          CHAIN_ALPHA_VOLUME_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/alpha-volume.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    canonicalChainAlphaVolumeCacheRoute(url, csv),
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/weights: network-wide validator weight-setting activity across every subnet
// over a 7d/30d window, read from the account_events WeightsSet stream. Mirrors chain-transfers:
// window + limit params, HEAD probes normalized through the GET cache key so they cannot bypass
// the edge cache and repeatedly force the network-wide aggregations, cache keyed on the analytics
// cron freshness. The leaderboard is fixed to most-active-first (total WeightsSet events).
export async function handleChainWeights(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_WEIGHTS_LIMIT_DEFAULT,
    maxLimit: CHAIN_WEIGHTS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-weights",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainWeights> | null) ??
        // Same shared loader MCP and GraphQL call, so all three surfaces
        // answer from one implementation. Declines (null) rather than
        // half-answering, leaving the empty payload below as the fallback.
        (await loadChainWeightsColdTier(
          env as unknown as Parameters<typeof loadChainWeightsColdTier>[0],
          { window: label, limit },
        )) ??
        buildChainWeights([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainWeights>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-stake-flow).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-weights",
          "short",
          cacheRequest,
          CHAIN_WEIGHTS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/weights.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/weights/setters: the network-wide weight-setter leaderboard — the individual
// validators driving consensus across every subnet, read from the account_events WeightsSet
// stream. The network-wide companion to /api/v1/subnets/{netuid}/weights/setters (the same
// relationship /chain/weights has to /subnets/{netuid}/weights); mirrors chain-weights: window +
// limit params, HEAD probes normalized through the GET cache key so they cannot bypass the edge
// cache and repeatedly force the network-wide aggregation. The leaderboard is fixed to
// most-active-first (total WeightsSet events).
export async function handleChainWeightSetters(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
    maxLimit: CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-weight-setters",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss. Postgres → schema-stable empty stub, never a live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainWeightSetters> | null) ??
        // The same WeightsSet stream /chain/weights already reads, grouped one
        // level finer (#9249). Through the shared loader so MCP and GraphQL get
        // it too rather than being wired one surface at a time.
        (await loadChainWeightSettersColdTier(
          env as unknown as Parameters<
            typeof loadChainWeightSettersColdTier
          >[0],
          { window: label, limit },
        )) ??
        buildChainWeightSetters([], null, { window: label, limit });
      if (csv) {
        return csvResponse(
          data.setters,
          "chain-weight-setters",
          "short",
          cacheRequest,
          CHAIN_WEIGHT_SETTERS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/weights/setters.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/serving: network-wide axon-serving announcement activity across every subnet
// over a 7d/30d window, read from the account_events AxonServed stream. Mirrors chain-transfers:
// window + limit params, HEAD probes normalized through the GET cache key so they cannot bypass
// the edge cache and repeatedly force the network-wide aggregations, cache keyed on the analytics
// cron freshness. The leaderboard is fixed to most-active-first (total AxonServed events).
export async function handleChainServing(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_SERVING_LIMIT_DEFAULT,
    maxLimit: CHAIN_SERVING_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-serving",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainServing> | null) ??
        // The box's Postgres is gone, so the tier above always misses. The
        // shared loader is the one MCP and GraphQL call too, so all three
        // surfaces answer from a single implementation rather than three
        // copies that can drift. It declines (null) rather than
        // half-answering, leaving the empty payload below as the fallback.
        (await loadChainServingColdTier(
          env as unknown as Parameters<typeof loadChainServingColdTier>[0],
          { window: label, limit },
        )) ??
        buildChainServing([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainServing>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-weights).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-serving",
          "short",
          cacheRequest,
          CHAIN_SERVING_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/serving.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/prometheus: network-wide Prometheus-endpoint serving activity across every
// subnet over a 7d/30d window, read from the account_events PrometheusServed stream. The
// telemetry-endpoint companion to chain/serving (axon endpoints); same window + limit params, HEAD
// probes normalized through the GET cache key so they cannot bypass the edge cache and repeatedly
// force the network-wide aggregations. The leaderboard is fixed to most-active-first (total events).
export async function handleChainPrometheus(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_PROMETHEUS_LIMIT_DEFAULT,
    maxLimit: CHAIN_PROMETHEUS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-prometheus",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainPrometheus> | null) ??
        buildChainPrometheus([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainPrometheus>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-serving).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-prometheus",
          "short",
          cacheRequest,
          CHAIN_PROMETHEUS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/prometheus.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/axon-removals: network-wide axon-removal activity across every subnet over a
// 7d/30d window, read from the account_events AxonInfoRemoved stream. The teardown-side companion to
// chain/serving (axon announcements) and the network-wide companion to the per-subnet
// axon-removals route; same window + limit params, HEAD probes normalized through the GET cache key
// so they cannot bypass the edge cache and repeatedly force the network-wide aggregations. The
// leaderboard is fixed to most-active-first (total AxonInfoRemoved events).
export async function handleChainAxonRemovals(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
    maxLimit: CHAIN_AXON_REMOVALS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-axon-removals",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainAxonRemovals> | null) ??
        buildChainAxonRemovals([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainAxonRemovals>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-serving).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-axon-removals",
          "short",
          cacheRequest,
          CHAIN_AXON_REMOVALS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/axon-removals.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/registrations: network-wide neuron-registration activity across every subnet
// over a 7d/30d window, read from the account_events NeuronRegistered stream. Mirrors chain-serving:
// window + limit params, HEAD probes normalized through the GET cache key so they cannot bypass the
// edge cache and repeatedly force the network-wide aggregations, cache keyed on the analytics cron
// freshness. The leaderboard is fixed to most-active-first (total NeuronRegistered events).
export async function handleChainRegistrations(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
    maxLimit: CHAIN_REGISTRATIONS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-registrations",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainRegistrations> | null) ??
        // #9146: served from the chain-registrations PROJECTION lane rather
        // than a request-time read. The request-time form cannot answer the
        // 30d window at all: R2 SQL rejects
        // `COUNT(DISTINCT hotkey) ... GROUP BY netuid` over it with
        // `40015: scan budget exceeded`, which is why /chain/registrations
        // served real 7d numbers and an empty 30d block in production. The
        // lane distributes that aggregation (GROUP BY netuid, hotkey) and
        // reduces it writer-side, exactly and once per tick.
        (await loadChainRegistrationsFromArtifact(env, {
          window: label,
          limit,
        })) ??
        buildChainRegistrations([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainRegistrations>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-serving).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-registrations",
          "short",
          cacheRequest,
          CHAIN_REGISTRATIONS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/registrations.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/deregistrations: network-wide neuron-deregistration activity across every subnet
// over a 7d/30d window, read from the account_events NeuronDeregistered stream. The exit-side
// companion to chain-registrations; mirrors it: window + limit + ?format=csv params, HEAD probes
// normalized through the GET cache key so they cannot bypass the edge cache and repeatedly force the
// network-wide aggregations, cache keyed on the analytics cron freshness. The leaderboard is fixed
// to most-active-first (total NeuronDeregistered events).
export async function handleChainDeregistrations(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
    maxLimit: CHAIN_DEREGISTRATIONS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-deregistrations",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainDeregistrations> | null) ??
        buildChainDeregistrations([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainDeregistrations>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-registrations).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-deregistrations",
          "short",
          cacheRequest,
          CHAIN_DEREGISTRATIONS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/deregistrations.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/stake-moves: network-wide stake-movement (re-delegation) activity across every
// subnet over a 7d/30d window, read from the account_events StakeMoved stream. The re-delegation-churn
// companion to chain/stake-flow (net capital flow); mirrors chain-registrations: window + limit
// params, HEAD probes normalized through the GET cache key so they cannot bypass the edge cache and
// repeatedly force the network-wide aggregations. The leaderboard is fixed to most-active-first
// (total StakeMoved events).
export async function handleChainStakeMoves(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
    maxLimit: CHAIN_STAKE_MOVES_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-stake-moves",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss. Postgres → schema-stable empty stub, never a live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainStakeMoves> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // network DISTINCT row + per-subnet aggregate from the lakehouse;
        // the shared builder owns ranking, the rollup, and the limit. See
        // src/chain-stake-moves-artifact.ts.
        (await loadChainStakeMovesFromArtifact(env, {
          window: label,
          limit,
        })) ??
        buildChainStakeMoves([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainStakeMoves>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-registrations).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-stake-moves",
          "short",
          cacheRequest,
          CHAIN_STAKE_MOVES_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/stake-moves.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// GET /api/v1/chain/stake-transfers: network-wide stake-transfer activity across every subnet over a
// 7d/30d window, read from the account_events StakeTransferred stream. The between-coldkeys companion
// to chain/stake-moves (within-account re-delegation churn); mirrors chain-stake-moves: window +
// limit params, HEAD probes normalized through the GET cache key so they cannot bypass the edge cache
// and repeatedly force the network-wide aggregations. The leaderboard is fixed to most-active-first
// (total StakeTransferred events).
export async function handleChainStakeTransfers(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
    maxLimit: CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    "chain-stake-transfers",
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a D1 query here would
      // always miss. Postgres → schema-stable empty stub, never a live D1 read.
      const data =
        ((await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )) as ReturnType<typeof buildChainStakeTransfers> | null) ??
        // The projection tier (#9146): a cron recomputes this window's
        // network DISTINCT row + per-subnet aggregate from the lakehouse;
        // the shared builder owns ranking, the rollup, and the limit. See
        // src/chain-stake-transfers-artifact.ts.
        (await loadChainStakeTransfersFromArtifact(env, {
          window: label,
          limit,
        })) ??
        buildChainStakeTransfers([], {
          window: label,
          limit,
        } as unknown as Parameters<typeof buildChainStakeTransfers>[1]);
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // intensity_distribution stay JSON-only (mirrors chain-stake-moves).
      if (csv) {
        return csvResponse(
          data.subnets,
          "chain-stake-transfers",
          "short",
          cacheRequest,
          CHAIN_STAKE_TRANSFERS_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/stake-transfers.json",
            data.observed_at,
          ),
        },
        "short",
      );
    },
    `${canonicalAnalyticsCacheRoute(url, { window: label, limit })}${csv ? "&format=csv" : ""}`,
  );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

// Fee/tip market analytics (#1988): a per-UTC-day fee series (totals, averages,
// exact medians) plus a windowed top-fee-payer list. COALESCE keeps NULL
// fees/tips out of the SUMs and medians.
export async function handleChainFees(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  const windowResult = analyticsWindow(url, ["limit", "call_module", "format"]);
  if ("error" in windowResult) return analyticsQueryError(windowResult.error);
  const { label, days: windowDays } = windowResult;
  const formatError = validateFormatParam(url);
  if (formatError) return analyticsQueryError(formatError);
  const limitResult = parseLimitParam(url, {
    defaultLimit: 25,
    maxLimit: 100,
  });
  if ("error" in limitResult) return analyticsQueryError(limitResult.error);
  const { limit } = limitResult;
  // Optional pallet scope (applies to both the daily series and the payer list),
  // backed by idx_extrinsics_module_block.
  const callModuleError = validateMaxLength(url, "call_module", 100);
  if (callModuleError) return analyticsQueryError(callModuleError);
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    "chain-fees",
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4909/#4772 D1 retirement: extrinsics' D1 write path is retired and
      // the table is dropped in production, so a D1 query here would always
      // miss. Postgres → schema-stable empty stub, never a live D1 read.
      let data: ReturnType<typeof buildChainFees> | null = null;
      if (env.METAGRAPH_EXTRINSICS_SOURCE === "postgres") {
        // The `&& env.DATA_API` this condition used to carry swallowed the
        // degradation signal (#9110): tryPostgresTier handles a missing
        // DATA_API itself and marks the fallback, and skipping the call meant
        // this route returned an unlabelled empty payload where every sibling
        // returned a labelled one. The rate limiter still only runs when there
        // is an upstream to protect.
        if (env.DATA_API) {
          const limited = await dataRateLimitResponse(cacheRequest, env);
          if (limited) return limited;
        }
        data = (await tryPostgresTier(
          env,
          cacheRequest,
          "METAGRAPH_EXTRINSICS_SOURCE",
        )) as ReturnType<typeof buildChainFees> | null;
      }
      // The projection tier (#9146): a cron recomputes this window's fee
      // series + payer leaderboard from the lakehouse; the reader slices to
      // the request's limit and feeds the same formatter, declining any
      // call_module scope. The #8242 trim below applies to it exactly as it
      // applies to a live answer. See src/chain-fees-artifact.ts.
      data ??= await loadChainFeesFromArtifact(env, {
        window: label,
        limit,
        callModule: url.searchParams.get("call_module"),
      });
      data ??= buildChainFees({
        window: label,
        observedAt: meta?.last_run_at || null,
      } as unknown as Parameters<typeof buildChainFees>[0]);
      // #8242: see handleChainActivity — trim the UTC-day buckets down to the
      // requested window so "7d" never reports 8 days.
      data = trimChainFeesToWindow(data, windowDays);
      if (csv) {
        return csvResponse(
          data.daily,
          "chain-fees",
          "short",
          cacheRequest,
          CHAIN_FEES_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
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
    },
    `${canonicalAnalyticsCacheRoute(url, {
      window: label,
      limit,
      call_module: url.searchParams.get("call_module"),
    })}${csv ? "&format=csv" : ""}`,
  );
}

// Shared analytics helpers also used by the deferred handler clusters (trajectory,
// metagraph, validators, uptime, history, leaderboards, compare, rpc-usage) that
// still live in api.ts — re-exported so api.ts can import them from one place
// until those clusters are extracted too.
export {
  analyticsMeta,
  analyticsQueryError,
  canonicalAnalyticsCacheRoute,
  analyticsWindow,
  markPostgresTierFallbackResponse,
  validateQueryParams,
};
