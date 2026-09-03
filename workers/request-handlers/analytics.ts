import {
  withStampedEdgeCache,
  unmeasured,
  markDataApiTierFallbackResponse,
  edgeCacheScope,
  type EdgeCacheCtx,
} from "../edge-cache.ts";
export {
  DEGRADED_TIER_UNAVAILABLE,
  DEGRADED_HEADER,
  unmeasured,
  degradedSnapshot,
  labelDegradedResponse,
  edgeCacheScope,
  type EdgeCacheCtx,
} from "../edge-cache.ts";
// Analytics handlers + the edge-cache guard that protects them.
//
// D1 fully eliminated (2026-07-17, reconfirmed live 2026-07-25 -- zero D1
// databases remain on the account): every handler in this file now goes
// straight to a schema-stable empty payload on a Postgres-tier miss, never a
// live store read -- the store read path (`storeAll`) and its fallback-row bookkeeping
// (`markD1FallbackRows`/`hasD1FallbackRows`/the `d1FallbackGeneration`
// counter) were deleted once they had zero remaining callers.
//
// What's left is `markDataApiTierFallbackResponse` + the
// `DATA_API_TIER_FALLBACK_RESPONSES` WeakSet (renamed 2026-07-25 -- it means
// "this response used the degraded/empty-fallback path, not a real tier
// hit") and `withEdgeCache`, which reads that WeakSet to decide whether a
// 200 may be persisted into the edge cache: `markDataApiTierFallbackResponse`
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

import { observationsReadDb } from "../../src/observations-read-runner.ts";
import { withChainAlphaVolumeUsd } from "../../src/alpha-usd-overlay.ts";
import { readTaoUsdCurrentKv } from "../tao-usd-current.ts";
import { readStore } from "../../src/read-store.ts";
import { HEALTH_CHECK_TABLES } from "../../src/read-store-tables.ts";
import {
  ANALYTICS_WINDOW_PARAM,
  DEFAULT_ANALYTICS_WINDOW,
  MAX_INCIDENT_ROWS,
} from "../config.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "../../src/chain-network.ts";
import {
  analyticsWindow,
  pageLimit,
  parseRouteQuery,
  routeQuery,
  routeText,
  routeValue,
} from "../../src/route-query.ts";
import { loadChainServingColdTier } from "../../src/chain-serving-loader.ts";
import { loadChainServingFromArtifact } from "../../src/chain-serving-artifact.ts";
import { loadChainWeightsColdTier } from "../../src/chain-weights-loader.ts";
import { loadChainWeightsFromArtifact } from "../../src/chain-weights-artifact.ts";
import { loadChainWeightSettersColdTier } from "../../src/chain-weight-setters-loader.ts";
import { loadChainWeightSettersFromArtifact } from "../../src/chain-weight-setters-artifact.ts";
import { registerModuleStateReset } from "../../src/module-state-registry.ts";
import { errorResponse } from "../http.ts";
import { csvRequested, csvResponse } from "../csv.ts";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.ts";

import { loadBulkHealthTrends } from "../../src/bulk-health-trends.ts";

import { formatGlobalIncidents } from "../../src/health-serving.ts";
import {
  applyQueryFilters,
  paginationLinkHeader,
  type Pagination,
  type QueryError,
} from "../list-query.ts";
import {
  currentStoreReadFailureGeneration,
  loadGlobalIncidentRows,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
} from "../../src/analytics-live.ts";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  trimChainActivityToWindow,
  trimChainFeesToWindow,
  buildChainSigners,
} from "../../src/chain-analytics.ts";
import { buildChainTransferPairs } from "../../src/chain-transfer-pairs.ts";
import { buildChainTransfers } from "../../src/chain-transfers.ts";
import { buildChainServing } from "../../src/chain-serving.ts";
import { buildChainPrometheus } from "../../src/chain-prometheus.ts";
import { loadChainPrometheusColdTier } from "../../src/chain-prometheus-loader.ts";
import { loadChainPrometheusFromArtifact } from "../../src/chain-prometheus-artifact.ts";
import { buildChainAxonRemovals } from "../../src/chain-axon-removals.ts";
import { loadAxonRemovals } from "../../src/axon-removals-loader.ts";
import { buildChainRegistrations } from "../../src/chain-registrations.ts";
import { buildChainDeregistrations } from "../../src/chain-deregistrations.ts";
import {
  buildChainSubnetLifecycle,
  DEFAULT_SUBNET_LIFECYCLE_WINDOW,
  loadChainSubnetLifecycle,
} from "../../src/subnet-lifecycle-read.ts";
// The shared window parser, rather than a restated map -- see the handler.
import { parseHistoryWindow } from "../../src/neuron-history.ts";
import { buildChainStakeMoves } from "../../src/chain-stake-moves.ts";
import { buildChainStakeTransfers } from "../../src/chain-stake-transfers.ts";
import { buildChainWeights } from "../../src/chain-weights.ts";
import { buildChainWeightSetters } from "../../src/chain-weight-setters.ts";
import { buildChainStakeFlow } from "../../src/chain-stake-flow.ts";
import { loadChainTransfersFromArtifact } from "../../src/chain-transfers-artifact.ts";
import { loadChainStakeFlowFromArtifact } from "../../src/chain-stake-flow-artifact.ts";
import { loadChainRegistrationsFromArtifact } from "../../src/chain-registrations-artifact.ts";
import {
  loadChainDeregistrationsFromArtifact,
  markDeregistrationsNotDerived,
} from "../../src/chain-deregistrations-artifact.ts";
import { loadChainActivityFromArtifact } from "../../src/chain-activity-artifact.ts";
import { loadChainCallsFromArtifact } from "../../src/chain-calls-artifact.ts";
import { loadChainFeesFromArtifact } from "../../src/chain-fees-artifact.ts";
import { loadChainSignersFromArtifact } from "../../src/chain-signers-artifact.ts";
import { loadChainAlphaVolumeFromArtifact } from "../../src/chain-alpha-volume-artifact.ts";
import { resolveMarketCapIndex } from "../../src/market-cap-index.ts";
import { loadChainStakeTransfersFromArtifact } from "../../src/chain-stake-transfers-artifact.ts";
import { loadChainTransferPairsFromArtifact } from "../../src/chain-transfer-pairs-artifact.ts";
import { loadChainStakeMovesFromArtifact } from "../../src/chain-stake-moves-artifact.ts";
import { buildChainAlphaVolume } from "../../src/chain-alpha-volume.ts";
import { LIVE_CRON_PROBER } from "../../src/field-provenance.ts";
import { recordsOrEmpty } from "../../src/read-store.ts";

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

// Normalizes per-subnet health analytics URLs so a bare ?-free request and an
// explicit ?window=7d request both resolve to the same edge-cache entry — mirrors
// canonicalEconomicsTrendsCachePath in analytics-routes.ts.
export function canonicalHealthWindowCachePath(url: URL): string {
  // A request the router will reject keys on its raw search, so the 400 is not
  // served from -- or written to -- the slot a valid request shares.
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = analyticsWindow(url);
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

// dataRateLimitResponse lived here until the chain-fees Postgres tier above was
// deleted, which left it with no callers. Nothing is unprotected by its going:
// the anonymous DATA_RATE_LIMITER policy is applied centrally by the router
// (workers/api.ts's DATA_RATE_LIMIT_POLICIES, 60/60s), so this was a second,
// route-local application of the same binding that had not run since
// METAGRAPH_EXTRINSICS_SOURCE went to "retired".

function analyticsQueryError(error: QueryError): Response {
  return errorResponse("invalid_query", error.message, 400, {
    parameter: error.parameter,
  });
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
    source: LIVE_CRON_PROBER,
  };
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
  // #9989: three narrowing parameters, all optional. Absent means "everything",
  // which is what this route served before it had any -- so no existing caller
  // changes behaviour. Anything else is still rejected outright.
  for (const key of url.searchParams.keys()) {
    if (key === "window" || key === "limit" || key === "offset") continue;
    return errorResponse(
      "invalid_query",
      `${key} is not supported for this route.`,
      400,
      { parameter: key },
    );
  }
  const {
    window: trendsWindow,
    limit: trendsLimit,
    offset: trendsOffset,
  } = routeQuery(url);

  return withEdgeCache(
    request,
    ctx,
    env,
    "bulk-trends",
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4832 gap-closure: METAGRAPH_HEALTH_SOURCE was left unset in
      // wrangler.jsonc for a long stretch after this tier's tryDataApiTier
      // wiring landed -- surface_checks/surface_uptime_daily only started
      // accumulating from the dual-write landing (#4881/#4885), with no
      // historical backfill, and an empty/short Postgres window is still a
      // valid 200 response that tryDataApiTier's error-only fallback can't
      // tell apart from "technically fine but missing D1's history". FLIPPED
      // to "postgres" (D1 retirement, 2026-07-16) once Postgres accumulated a
      // real window: direct `psql` confirmed surface_checks holds 111,088 rows
      // and surface_uptime_daily holds 1,182 rows spanning 2026-07-11 through
      // 2026-07-16, a full rolling window. See wrangler.jsonc's own comment on
      // this flag for the complete verification writeup.
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from every wrangler config and is
      // absent from FORWARDABLE_TIER_FLAGS, so the tier read that used to
      // initialise `data` resolved to null on every request -- which made the
      // branch below the only path, not the fallback.
      // store-served payloads are cacheable; only a genuinely empty one is not.
      // `isFallback` bars the edge cache, so it must mean "this payload is
      // the schema-stable empty", not merely "the Postgres tier missed" --
      // since 2026-08-03 a tier miss is the NORMAL path and the store answers it
      // with real rows. Mirrors handleSubnetUptime in analytics-routes.ts.
      const storeGeneration = currentStoreReadFailureGeneration();
      const result = await loadBulkHealthTrends({
        observedAt: meta?.last_run_at || null,
        db: observationsReadDb(env, ctx),
        window: trendsWindow ?? null,
        limit: trendsLimit ?? null,
        offset: trendsOffset ?? 0,
      });
      const data = result.data;
      const isFallback =
        !env.HYPERDRIVE?.connectionString ||
        currentStoreReadFailureGeneration() !== storeGeneration;
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
            source: LIVE_CRON_PROBER,
          },
        },
        "short",
      );
      return isFallback ? markDataApiTierFallbackResponse(response) : response;
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
  return withEdgeCache(request, ctx, env, "trends", async (cacheRequest) => {
    // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
    // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from every wrangler config and is
    // absent from FORWARDABLE_TIER_FLAGS, so the tier read that used to
    // initialise `data` resolved to null on every request -- which made the
    // branch below the only path, not the fallback.
    // Read through the shared storeAll (rather than handing the loader the bare
    // db) so a failure is still logged + marked as a store fallback (the
    // dark-serve log contract) — a Postgres-tier miss now falls straight
    // through to the pure formatter with no rows (never a live store query),
    // so it's always marked a fallback (never edge-cache a schema-stable
    // empty payload).
    // Only an EMPTY payload is barred from the edge cache — no store binding,
    // or a store read that failed mid-load (tracked by the failure generation,
    // the same contract the Postgres tier uses). A store-served response
    // carries real rows and caches like any tier hit (the pre-elimination
    // behavior this route always had).
    const storeGeneration = currentStoreReadFailureGeneration();
    const meta = await readHealthMetaKv(env);
    const data = await loadSubnetHealthTrends(netuid, {
      observedAt: meta?.last_run_at || null,
      db: observationsReadDb(env, ctx),
    });
    const usedFallback =
      !env.HYPERDRIVE?.connectionString ||
      currentStoreReadFailureGeneration() !== storeGeneration;
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
          source: LIVE_CRON_PROBER,
        },
      },
      "short",
    );
    return usedFallback ? markDataApiTierFallbackResponse(response) : response;
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
  const { label } = analyticsWindow(url);
  return withEdgeCache(
    request,
    ctx,
    env,
    "percentiles",
    async (cacheRequest) => {
      // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from every wrangler config and is
      // absent from FORWARDABLE_TIER_FLAGS, so the tier read that used to
      // initialise `data` resolved to null on every request -- which made the
      // branch below the only path, not the fallback.
      // A Postgres-tier miss now falls straight through to the pure
      // formatter with no rows (never a live store query), so it's always
      // marked a fallback (mirrors handleHealthTrends).
      // Cacheable when store-served — see handleHealthTrends' comment.
      const storeGeneration = currentStoreReadFailureGeneration();
      const meta = await readHealthMetaKv(env);
      const data = await loadSubnetPercentiles(netuid, {
        window: label,
        observedAt: meta?.last_run_at || null,
        db: observationsReadDb(env, ctx),
      });
      const usedFallback =
        !env.HYPERDRIVE?.connectionString ||
        currentStoreReadFailureGeneration() !== storeGeneration;
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
        ? markDataApiTierFallbackResponse(response)
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
  const { label } = analyticsWindow(url);
  return withEdgeCache(
    request,
    ctx,
    env,
    "incidents",
    async (cacheRequest) => {
      // See handleBulkHealthTrends' own comment on METAGRAPH_HEALTH_SOURCE.
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from every wrangler config and is
      // absent from FORWARDABLE_TIER_FLAGS, so the tier read that used to
      // initialise `data` resolved to null on every request -- which made the
      // branch below the only path, not the fallback.
      // A Postgres-tier miss now falls straight through to the pure
      // formatter with no rows (never a live store query), so it's always
      // marked a fallback (mirrors handleHealthTrends / handleHealthPercentiles).
      // Cacheable when store-served — see handleHealthTrends' comment.
      const storeGeneration = currentStoreReadFailureGeneration();
      const meta = await readHealthMetaKv(env);
      const data = await loadSubnetIncidents(netuid, {
        window: label,
        observedAt: meta?.last_run_at || null,
        db: observationsReadDb(env, ctx),
      });
      const usedFallback =
        !env.HYPERDRIVE?.connectionString ||
        currentStoreReadFailureGeneration() !== storeGeneration;
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
        ? markDataApiTierFallbackResponse(response)
        : response;
    },
    canonicalHealthWindowCachePath(url),
  );
}

// Global, cross-subnet incident ledger — the same gap-island grouping as the
// per-subnet route but with no netuid filter, grouped by (netuid, surface_id)
// and capped. Powers a public status page's "recent incidents" feed.
//
// Reached only on a Postgres-tier miss, which is now every request: the tier
// this fell back FROM was retired with the box (#9193), so this read is where
// the incident ledger actually comes from.
export async function loadGlobalIncidentsLedger(
  env: Env,
  { label = "7d", days = 7 }: { label?: string; days?: number } = {},
) {
  // readStore, NOT observationsReadDb, and that is the difference between this
  // ledger having rows and being empty. observationsReadDb needs a `ctx` to
  // park the pooled connection's teardown on and answers `undefined` without
  // one -- and none of this function's three callers has one to give: the REST
  // route reaches it through resolveGlobalIncidents, the feed through
  // resolveGlobalIncidentsForFeed, and the GraphQL resolver calls it directly.
  // `undefined` reads as zero rows in loadGlobalIncidentRows, so all three
  // published "no incidents" while the MCP tool -- which already read this
  // through readStore(HEALTH_CHECK_TABLES) -- served the real list.
  //
  // readStore awaits its own teardown, so there is no ctx to thread and no
  // caller left that can forget one. surface_checks is the only table the
  // statement names.
  const incidentRows = await loadGlobalIncidentRows(
    readStore(env, HEALTH_CHECK_TABLES),
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
 * `request` matters here, not just as plumbing: `tryDataApiTier` forwards it
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
  // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from every wrangler config
  // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read that guarded an
  // early return here resolved to null before it could touch DATA_API.
  const storeGeneration = currentStoreReadFailureGeneration();
  const result = await loadGlobalIncidentsLedger(env, { label, days });
  return {
    data: result.data,
    // Only an EMPTY ledger counts as a fallback for caching purposes — no
    // store bound, or a read failure mid-load. A store-served ledger carries
    // real rows.
    isFallback:
      !env.HYPERDRIVE?.connectionString ||
      currentStoreReadFailureGeneration() !== storeGeneration,
  };
}

/**
 * The one correct way for /api/v1/feeds/incidents to reach the same data
 * /status shows (metagraphed#8353).
 *
 * resolveGlobalIncidents's `request` argument isn't incidental — tryDataApiTier
 * forwards it, unmodified, to the DATA_API service binding, so whatever path
 * that request carries is the path DATA_API tries to route. The feed handler's
 * OWN incoming request is for /api/v1/feeds/incidents(.json|.rss|.atom), a path
 * DATA_API has no route for at all; forwarding it verbatim (what #8242's fix
 * did) makes DATA_API 404, which tryDataApiTier reads as a tier miss and
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

export async function handleGlobalIncidents(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const { label, days } = analyticsWindow(url);
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
  return isFallback ? markDataApiTierFallbackResponse(response) : response;
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
  // USD twins (#10383), converted at the window's close rate. Empty when the
  // index is unavailable -- an export that dropped the columns entirely would
  // be a quietly different answer to the same question.
  "buy_volume_usd",
  "sell_volume_usd",
  "total_volume_usd",
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

// The whole row (#10263): five flat scalars, no nested object to serialize.
// Exported: the per-subnet lifecycle route serves the SAME row shape and
// restated this list by hand (#10987 follow-up).
export const LIFECYCLE_CSV_COLUMNS = [
  "netuid",
  "event",
  "block_number",
  "observed_at",
  "predates_capture",
];
const CHAIN_SUBNET_LIFECYCLE_CSV_COLUMNS = LIFECYCLE_CSV_COLUMNS;
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

// Daily network-activity aggregates over the first-party chain store tiers (#1987):
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label, days: windowDays } = analyticsWindow(url);
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    edgeCacheScope("chain-activity", network),
    async (cacheRequest) => {
      // #4909 D1 retirement: extrinsics'/blocks' D1 write path is retired
      // (#4772) and the tables are dropped in production, so a D1 query here
      // would always miss. Postgres → schema-stable empty stub, never a live
      // store read.
      // #8242: the upstream aggregation buckets by UTC day across a
      // `now - N days` range, so a 7d window comes back as 8 calendar days (a
      // partial today plus a partial tail day). Trim to the window the caller
      // actually asked for so day_count can't contradict the window label.
      const data = trimChainActivityToWindow(
        // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // daily series from the lakehouse; the reader feeds the same
        // formatter, and the #8242 trim below applies to it exactly as it
        // applies to a live answer. See src/chain-activity-artifact.ts.
        (await loadChainActivityFromArtifact(
          env,
          { window: label },
          network,
        )) ??
          unmeasured(
            buildChainActivity({
              window: label,
              // The health sweep's last_run_at is not a chain observation.
              // Reusing it here made a missing or stale activity projection
              // look freshly measured. Unknown activity stays explicitly
              // unmeasured until the projection can prove current coverage.
              observedAt: null,
            }),
          ),
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const groupBy = routeText(url, "group_by") || "module";
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    edgeCacheScope("chain-calls", network),
    async (cacheRequest) => {
      // #4772 D1 retirement: the `extrinsics` D1 table is dropped in production, so
      // a postgres-tier miss now falls straight back to the pure builder with no
      // rows (never a live store query) -- always mark that response as a fallback
      // (never edge-cache a schema-stable empty payload).
      let usedFallback = false;
      const meta = await readHealthMetaKv(env);
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so the tier
      // read that used to initialise `data` resolved to null on every request --
      // the projection below has been the first rung that can answer.
      //
      // The projection tier (#9146): a cron recomputes this window's call mix
      // (both group_by variants) from the lakehouse; the reader slices to the
      // request's limit and feeds the same formatter, declining any call_module
      // scope. A projected answer is a real answer, so it is never marked as a
      // fallback. See src/chain-calls-artifact.ts.
      let data = await loadChainCallsFromArtifact(env, {
        window: label,
        groupBy,
        limit,
        callModule: routeText(url, "call_module"),
      });
      if (!data) {
        usedFallback = true;
        data = buildChainCalls({
          window: label,
          groupBy,
          observedAt: meta?.last_run_at || null,
          total: 0,
          rows: [],
        });
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
        return usedFallback ? markDataApiTierFallbackResponse(csvRes) : csvRes;
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
        ? markDataApiTierFallbackResponse(response)
        : response;
    },
    `${canonicalAnalyticsCacheRoute(url, {
      window: label,
      group_by: groupBy,
      limit,
      call_module: routeText(url, "call_module"),
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  // limit/call_module no longer feed a live store read (see the retirement note
  // below) but are still shape-validated so the REST contract stays stable.
  const limit = pageLimit(url);
  const sort = routeValue<string>(url, "sort");
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    edgeCacheScope("chain-signers", network),
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and
      // the table is dropped in production, so a store query here would always
      // miss (#6013). Postgres → schema-stable empty stub, never a live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // leaderboard (both sorts) from the lakehouse; the reader slices to
        // the request's limit and feeds the same formatter, declining any
        // call_module scope. See src/chain-signers-artifact.ts.
        (await loadChainSignersFromArtifact(env, {
          window: label,
          sort,
          limit,
          callModule: routeText(url, "call_module"),
        })) ??
        unmeasured(
          buildChainSigners({
            window: label,
            sort,
            observedAt: meta?.last_run_at || null,
            rows: [],
          }),
        );
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
      call_module: routeText(url, "call_module"),
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  // limit no longer feeds a live store read (see the retirement note below) but
  // is still shape-validated so the REST contract stays stable.
  const limit = pageLimit(url);
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
    edgeCacheScope("chain-transfers", network),
    async () => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // scorecard from the lakehouse; the artifact reader slices to the
        // request's limit and feeds the same formatter. See
        // src/chain-transfers-artifact.ts.
        (await loadChainTransfersFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainTransfers({
            window: label,
            observedAt: meta?.last_run_at || null,
          }),
        );
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  // limit no longer feeds a live store read (see the retirement note below) but
  // is still shape-validated so the REST contract stays stable.
  const limit = pageLimit(url);
  const sort = routeValue<string>(url, "sort");
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-transfer-pairs", network),
    async () => {
      const meta = await readHealthMetaKv(env);
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // corridor leaderboard (both sorts) from the lakehouse; the reader
        // slices to the request's limit and feeds the same formatter. See
        // src/chain-transfer-pairs-artifact.ts.
        (await loadChainTransferPairsFromArtifact(
          env,
          {
            window: label,
            sort,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainTransferPairs({
            window: label,
            sort,
            observedAt: meta?.last_run_at || null,
          }),
        );
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
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
    edgeCacheScope("chain-stake-flow", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // per-(netuid, event_kind) aggregate from the lakehouse; the shared
        // builder owns ranking and the limit. See
        // src/chain-stake-flow-artifact.ts.
        (await loadChainStakeFlowFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainStakeFlow([], {
            window: label,
            limit,
          }),
        );
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
  // The parsed value, not the raw string: `?limit=020` and `?limit=20` are
  // one request and must not be two cache entries (#10060).
  const limitParam = routeQuery(url).limit;
  if (limitParam !== undefined) search.set("limit", String(limitParam));
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const limit = pageLimit(url);
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
    edgeCacheScope("chain-alpha-volume", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes the fixed 24h
        // per-(netuid, event_kind) aggregate from the lakehouse; the shared
        // builder owns ranking and the limit. See
        // src/chain-alpha-volume-artifact.ts.
        // marketCapByNetuid is vol_mcap_ratio's denominator (#9526), resolved
        // here rather than inside the reader so an unreachable economics tier
        // costs a null ratio and not the whole leaderboard.
        (await loadChainAlphaVolumeFromArtifact(
          env,
          { limit, marketCapByNetuid: await resolveMarketCapIndex(env) },
          network,
        )) ??
        unmeasured(
          buildChainAlphaVolume([], {
            limit,
          }),
        );
      // USD on the network rollup, the spread and every per-subnet row
      // (#10383). Overlaid before the CSV branch so both formats carry the
      // same answer, and at ONE named rate -- the window's close -- because
      // the window is fixed at 24h. See src/alpha-usd-overlay.ts.
      const priced = withChainAlphaVolumeUsd(
        data,
        await readTaoUsdCurrentKv(env),
        Date.now(),
      );
      // CSV exports the row-shaped per-subnet leaderboard; the network rollup +
      // volume_distribution stay JSON-only (mirrors chain-stake-flow).
      if (csv) {
        return csvResponse(
          priced.subnets,
          "chain-alpha-volume",
          "short",
          cacheRequest,
          CHAIN_ALPHA_VOLUME_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data: priced,
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
  /** Which chain's projection to serve (#11418). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-weights", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // Same shared loader MCP and GraphQL call, so all three surfaces
        // answer from one implementation. Declines (null) rather than
        // half-answering, leaving the empty payload below as the fallback.
        // THE PROJECTION TIER FIRST (#11418), same ladder as its serving and
        // prometheus siblings. The cold tier below is MAINNET-ONLY and must
        // decline off it: its SQL reaches `account_events` through a network
        // now, but this route only has a card for chains whose lane has
        // ticked, and answering from mainnet's rows would be undetectable.
        (await loadChainWeightsFromArtifact(
          env,
          { window: label, limit },
          network,
        )) ??
        (network === DEFAULT_CHAIN_NETWORK
          ? await loadChainWeightsColdTier(env, { window: label, limit })
          : null) ??
        unmeasured(
          buildChainWeights([], {
            window: label,
            limit,
          }),
        );
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
  /** Which chain's projection to serve (#11418). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-weight-setters", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss. Postgres → schema-stable empty stub, never a live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The same WeightsSet stream /chain/weights already reads, grouped one
        // level finer (#9249). Through the shared loader so MCP and GraphQL get
        // it too rather than being wired one surface at a time.
        // THE PROJECTION TIER FIRST (#11418), same ladder as its serving and
        // prometheus siblings. The cold tier below is MAINNET-ONLY and must
        // decline off it: its SQL reaches `account_events` through a network
        // now, but this route only has a card for chains whose lane has
        // ticked, and answering from mainnet's rows would be undetectable.
        (await loadChainWeightSettersFromArtifact(
          env,
          { window: label, limit },
          network,
        )) ??
        (network === DEFAULT_CHAIN_NETWORK
          ? await loadChainWeightSettersColdTier(env, { window: label, limit })
          : null) ??
        unmeasured(buildChainWeightSetters([], null, { window: label, limit }));
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
  /** Which chain's projection to serve (#11419). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-serving", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The box's Postgres is gone, so the tier above always misses. The
        // shared loader is the one MCP and GraphQL call too, so all three
        // surfaces answer from a single implementation rather than three
        // copies that can drift. It declines (null) rather than
        // half-answering, leaving the empty payload below as the fallback.
        // THE PROJECTION TIER FIRST (#11419). A cron recomputes this window
        // from the lakehouse; a caller then pays one R2 GET. The cold tier
        // stays underneath as the fallback for a lane that has not run yet --
        // it is the same builder either way, so the payload is identical and
        // only the variance moves.
        //
        (await loadChainServingFromArtifact(
          env,
          { window: label, limit },
          network,
        )) ??
        // THE COLD TIER IS MAINNET-ONLY, and must DECLINE off it rather
        // than answer. Its SQL names `chain.account_events` directly --
        // no network parameter -- so letting it run for another chain
        // would hand back mainnet's history under a testnet path: well
        // formed, and undetectable downstream. Same guard
        // `coldTierChainEventsPayload` draws with `mainnetOnlyBranch`.
        (network === DEFAULT_CHAIN_NETWORK
          ? await loadChainServingColdTier(env, { window: label, limit })
          : null) ??
        unmeasured(
          buildChainServing([], {
            window: label,
            limit,
          }),
        );
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
  /** Which chain's projection to serve (#11419). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-prometheus", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The rung this route never had (#10248). Its axon twin has read the
        // lakehouse rollup here since #9216; prometheus fell straight from a
        // tier that always misses to the empty stub, so it published a
        // confident zero no amount of curation could have fixed.
        // THE PROJECTION TIER FIRST (#11419). A cron recomputes this window
        // from the lakehouse; a caller then pays one R2 GET. The cold tier
        // stays underneath as the fallback for a lane that has not run yet --
        // it is the same builder either way, so the payload is identical and
        // only the variance moves.
        //
        (await loadChainPrometheusFromArtifact(
          env,
          { window: label, limit },
          network,
        )) ??
        // THE COLD TIER IS MAINNET-ONLY, and must DECLINE off it rather
        // than answer. Its SQL names `chain.account_events` directly --
        // no network parameter -- so letting it run for another chain
        // would hand back mainnet's history under a testnet path: well
        // formed, and undetectable downstream. Same guard
        // `coldTierChainEventsPayload` draws with `mainnetOnlyBranch`.
        (network === DEFAULT_CHAIN_NETWORK
          ? await loadChainPrometheusColdTier(env, { window: label, limit })
          : null) ??
        buildChainPrometheus([], {
          window: label,
          limit,
        });
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
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
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
      // DERIVED FROM STATE, not from an event (#10805). `AxonInfoRemoved` has
      // zero occurrences in the complete pallet-level stream, genesis to head
      // -- the runtime does not emit it -- so this route answered a confident
      // 0 for its whole life. The transition is real and we already store it:
      // `neuron_daily.axon` going from non-null to null, with UID reuse
      // subtracted and a second absent reading required. See
      // src/axon-removal-derivation.ts for why both corrections are mandatory.
      //
      // A null rollup means there was no store to read, NOT that nothing was
      // removed, so the builder keeps its schema-stable empty in that case --
      // the same distinction the degraded marker was carrying.
      const rollup = await loadAxonRemovals(env);
      const data = buildChainAxonRemovals(rollup?.subnets ?? [], {
        window: label,
        limit,
        networkDistinct: rollup?.network,
        derivation: rollup?.derivation,
      });
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-registrations", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // #9146: served from the chain-registrations PROJECTION lane rather
        // than a request-time read. The request-time form cannot answer the
        // 30d window at all: R2 SQL rejects
        // `COUNT(DISTINCT hotkey) ... GROUP BY netuid` over it with
        // `40015: scan budget exceeded`, which is why /chain/registrations
        // served real 7d numbers and an empty 30d block in production. The
        // lane distributes that aggregation (GROUP BY netuid, hotkey) and
        // reduces it writer-side, exactly and once per tick.
        (await loadChainRegistrationsFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainRegistrations([], {
            window: label,
            limit,
          }),
        );
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
// GET /api/v1/chain/subnet-lifecycle: every subnet's registrations and
// deregistrations, newest first (#10263) — the network-wide view of the same
// subnet_lifecycle table `/subnets/{netuid}/lifecycle` reads per subnet.
//
// HISTORY_WINDOWS, deliberately NOT analyticsWindow. That helper understands
// only 7d/30d and clamps anything else to 400 days, which would silently
// mistranslate the 90d/1y/all this route publishes. Same reasoning
// src/neuron-history.ts records for its own window set.
//
// Defaults to `all` rather than the family's 30d: a subnet registers or
// deregisters a handful of times in its LIFETIME, so a 30d default would
// answer "nothing happened" almost every day and read as a broken feed.
export async function handleChainSubnetLifecycle(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
): Promise<Response> {
  // #10218: the router parsed and rejected against this route's schema before
  // the handler ran -- including the `window` enum and the `limit` ceiling --
  // so this reads the result rather than re-checking it. The ceiling still
  // REJECTS rather than clamps; that is the schema's doing, not the handler's.
  const { window = DEFAULT_SUBNET_LIFECYCLE_WINDOW } = routeQuery(url);
  const limit = pageLimit(url);
  // `days === null` means `all` (no lower bound) -- a real answer, so this must
  // not become a truthiness test. The label is already schema-valid here.
  const parsed = parseHistoryWindow(window);
  if ("error" in parsed) return analyticsQueryError(parsed.error);
  const { days } = parsed;

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  return withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-subnet-lifecycle", DEFAULT_CHAIN_NETWORK),
    async () => {
      const rows = await loadChainSubnetLifecycle(env, {
        limit,
        offset: 0,
        sinceMs: days === null ? null : Date.now() - days * 86_400_000,
      });
      const data = buildChainSubnetLifecycle(rows, { limit, offset: null });
      if (csvRequested(url, cacheRequest)) {
        return csvResponse(
          data.entries as unknown[],
          "chain-subnet-lifecycle",
          "short",
          cacheRequest,
          CHAIN_SUBNET_LIFECYCLE_CSV_COLUMNS,
        );
      }
      return envelopeResponse(
        cacheRequest,
        {
          data,
          meta: await analyticsMeta(
            env,
            "/metagraph/chain/subnet-lifecycle.json",
            recordsOrEmpty(data.entries)[0]?.observed_at ?? null,
          ),
        },
        "short",
      );
    },
  );
}

export async function handleChainDeregistrations(
  request: Request,
  env: Env,
  url: URL,
  ctx: EdgeCacheCtx = {},
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-deregistrations", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss (#6013). Postgres → schema-stable empty stub, never a
      // live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // #9307: NeuronDeregistered has never been emitted, so the filter this
        // route was built on matched nothing and it published a permanent 0.
        // The feed is DERIVED from UID reuse in the NeuronRegistered stream by
        // the chain-deregistrations projection lane — see
        // src/deregistration-derivation.ts.
        (await loadChainDeregistrationsFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        // Still the schema-stable empty when nothing derived it — but MARKED,
        // so a caller can tell "no evictions" from "we could not look".
        //
        // Two markers, deliberately, because they speak to different readers:
        // markDeregistrationsNotDerived writes `degraded.reason` into the BODY
        // (this route's own long-standing contract), and unmeasured adds
        // #9110's header so the route degrades the same way its twelve
        // siblings do and the edge cache declines to store it (#10189).
        unmeasured(
          markDeregistrationsNotDerived(
            buildChainDeregistrations([], {
              window: label,
              limit,
            }),
          ),
        );
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-stake-moves", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss. Postgres → schema-stable empty stub, never a live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // network DISTINCT row + per-subnet aggregate from the lakehouse;
        // the shared builder owns ranking, the rollup, and the limit. See
        // src/chain-stake-moves-artifact.ts.
        (await loadChainStakeMovesFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainStakeMoves([], {
            window: label,
            limit,
          }),
        );
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label } = analyticsWindow(url);
  const limit = pageLimit(url);
  const csv = csvRequested(url, request);

  const cacheRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const response = await withEdgeCache(
    cacheRequest,
    ctx,
    env,
    edgeCacheScope("chain-stake-transfers", network),
    async () => {
      // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
      // and the table is dropped in production, so a store query here would
      // always miss. Postgres → schema-stable empty stub, never a live store read.
      const data =
        // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
        // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
        // resolved to null before it could touch DATA_API.
        // The projection tier (#9146): a cron recomputes this window's
        // network DISTINCT row + per-subnet aggregate from the lakehouse;
        // the shared builder owns ranking, the rollup, and the limit. See
        // src/chain-stake-transfers-artifact.ts.
        (await loadChainStakeTransfersFromArtifact(
          env,
          {
            window: label,
            limit,
          },
          network,
        )) ??
        unmeasured(
          buildChainStakeTransfers([], {
            window: label,
            limit,
          }),
        );
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
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Response> {
  const { label, days: windowDays } = analyticsWindow(url);
  const limit = pageLimit(url);
  // Optional pallet scope (applies to both the daily series and the payer list),
  // backed by idx_extrinsics_module_block.
  const csv = csvRequested(url, request);
  return withEdgeCache(
    request,
    ctx,
    env,
    edgeCacheScope("chain-fees", network),
    async (cacheRequest) => {
      const meta = await readHealthMetaKv(env);
      // #4909/#4772 D1 retirement: extrinsics' D1 write path is retired and
      // the table is dropped in production, so a store query here would always
      // miss.
      //
      // The Postgres tier this route used to try FIRST is gone with it. It sat
      // behind an inline `env.METAGRAPH_EXTRINSICS_SOURCE === "postgres"`
      // pre-check, and the var has read "retired" since #9193 -- so the whole
      // block, its rate-limiter call included, had stopped executing. Three
      // independent facts make it unrevivable rather than merely parked: the
      // flag is not in data-api-tier.ts's FORWARDABLE_TIER_FLAGS, so a "d1" value
      // would not forward either; DATA_API serves no chain-fees route to
      // forward TO; and no deployed flag anywhere holds "postgres" now.
      // Deleting it is what the route already does at runtime.
      //
      // Note this route was the only extrinsics reader with such a pre-check;
      // its siblings (handleChainActivity, -Calls, -Signers) call
      // tryDataApiTier bare and let it own the gate. Those calls are equally
      // inert today, but they are invisible to tsc and are left alone here --
      // retiring them is a separate sweep (#10190), not a types change.
      //
      // The projection tier (#9146), now this route's FIRST tier rather than
      // its second: a cron recomputes this window's fee series + payer
      // leaderboard from the lakehouse; the reader slices to the request's
      // limit and feeds the same formatter, declining any call_module scope.
      // The #8242 trim below applies to it exactly as it applies to a live
      // answer. See src/chain-fees-artifact.ts.
      let data: ReturnType<typeof buildChainFees> | null =
        await loadChainFeesFromArtifact(env, {
          window: label,
          limit,
          callModule: routeText(url, "call_module"),
        });
      data ??= unmeasured(
        buildChainFees({
          window: label,
          observedAt: meta?.last_run_at || null,
        }),
      );
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
      call_module: routeText(url, "call_module"),
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
  markDataApiTierFallbackResponse,
};

export async function withEdgeCache(
  request: Request,
  ctx: EdgeCacheCtx | undefined,
  env: Env,
  keyParts: string,
  buildResponse: (cacheRequest: Request) => Response | Promise<Response>,
  cachePathAndSearch: string | null = null,
  resolveCacheStamp: ((env: Env) => Promise<string | null>) | null = null,
): Promise<Response> {
  return withStampedEdgeCache(
    request,
    ctx,
    env,
    keyParts,
    buildResponse,
    cachePathAndSearch,
    resolveCacheStamp ??
      (async (source) => (await readHealthMetaKv(source))?.last_run_at ?? null),
  );
}
