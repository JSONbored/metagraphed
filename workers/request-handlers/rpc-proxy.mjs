// The read-only RPC reverse-proxy subsystem (extracted from workers/api.mjs per
// #1763): the /rpc/v1/{network} JSON-RPC proxy, its B3 usage analytics, the
// GraphQL endpoint's shared rate-limit guard, the on-demand surface-verify probe,
// and everything those handlers depend on — endpoint selection + upstream-safety,
// the failover/streaming machinery, the per-method response-cache policy, and the
// pooled rpc/pools.json reader.
//
// RPC_HEALTH co-location (the analytics-module pattern): the in-isolate circuit
// breaker (`RPC_HEALTH` + `recordRpcFailure` / `recordRpcSuccess` /
// `isRpcEndpointEjected`) is the one piece of mutable state these handlers share.
// It MUST live with its readers and writers: `proxyWithFailover` mutates it on
// every upstream attempt, and `orderSafeRpcEndpoints` reads it to deprioritise
// ejected endpoints on the next request. Keeping the map and both call sites in
// this one file makes the breaker's eject/half-open contract reviewable in a
// single place — the same reason analytics.mjs co-locates its fallback counter
// with the cache guard. Tests still inject their own map via the `healthMap`
// option, so the module-default is only the production singleton.
//
// Dependency wiring: the query guards (`analyticsWindow`, `analyticsQueryError`,
// `analyticsMeta`) come from the sibling analytics.mjs (no cycle — analytics
// imports nothing from here). The one
// api.mjs-local helper, `readHealthMetaKv` (the in-isolate snapshot-meta memo that
// stays in api.mjs because other clusters + a test import it from there), is
// injected once via `configureRpcProxy({ readHealthMetaKv })` at api.mjs load
// time — exactly as analytics.mjs is wired — so this file never imports api.mjs.
// Everything else is a direct leaf import. api.mjs imports the handlers back and
// dispatches them, and re-exports the test-facing helpers from itself.

import { apiHeaders, errorResponse } from "../http.mjs";
import { readArtifact, readHealthKv } from "../storage.mjs";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.mjs";
import {
  analyticsMeta,
  analyticsQueryError,
  analyticsWindow,
} from "./analytics.mjs";
import {
  findSurface,
  verifySurfaceWithCache,
} from "../../src/surface-verify.mjs";
import { SURFACE_ALIASES_PATH } from "../../src/surface-aliases.mjs";
import {
  KV_HEALTH_RPC_POOL,
  workerResolvedUrlSafetyGuard,
  workerWebSocketConnector,
} from "../../src/health-prober.mjs";
import { ipv6EmbeddedIpv4 } from "../../src/ip-safety.mjs";
import { overlayRpcPoolEligibility } from "../../src/health-serving.mjs";
import { loadRpcUsage } from "../../src/rpc-usage-loader.mjs";
import { tryPostgresTier } from "../postgres-tier.mjs";
import {
  DENIED_RPC_PREFIXES,
  JSON_CONTENT_TYPE,
  MAX_RPC_BODY_BYTES,
  MAX_STATE_QUERY_KEY_HEX_CHARS,
  MAX_STATE_QUERY_KEYS_PAGE_SIZE,
  MAX_STATE_QUERY_RESPONSE_BYTES,
  resolveClientIp,
  SAFE_RPC_METHODS,
  SAFE_RPC_STATE_QUERY_METHODS,
  TRUSTED_RPC_UPSTREAM_ORIGINS,
} from "../config.mjs";

// Injected once from api.mjs (see configureRpcProxy). The in-isolate
// snapshot-meta read lives in api.mjs because the other handler clusters and a
// test still import it from there; injecting the stable function reference here
// keeps the import acyclic — the same wiring analytics.mjs uses for the same
// helper.
let readHealthMetaKv = () => {
  throw new Error("rpc-proxy handlers used before configureRpcProxy()");
};

// Called once at api.mjs module-init to wire the api.mjs-local KV reader.
export function configureRpcProxy(deps) {
  readHealthMetaKv = deps.readHealthMetaKv;
}

// rpc/pools.json is R2-only and static per-build (it changes only on redeploy).
// The RPC proxy reads it on every POST to /rpc/v1/* before failover, so a burst
// turns into N R2 reads of the same artifact (#1309). Memoize the successful read
// per-isolate (5 min TTL, same as the other in-isolate caches). The per-endpoint
// health that actually changes is overlaid separately from KV (readHealthKv) on
// every request, so caching the static pool never staleness-pins live eligibility.
// Keyed on env so tests / multi-binding callers never cross-read; only ok reads
// are cached so a transient R2 miss isn't sticky.
export const RPC_POOL_ARTIFACT_TTL_MS = 300_000;
let rpcPoolArtifactCache = { env: null, value: null, expiresAt: 0 };

export async function readRpcPoolArtifact(env, now = Date.now()) {
  if (
    rpcPoolArtifactCache.env === env &&
    now < rpcPoolArtifactCache.expiresAt
  ) {
    return rpcPoolArtifactCache.value;
  }
  const poolArtifact = await readArtifact(env, "/metagraph/rpc/pools.json");
  if (poolArtifact.ok) {
    rpcPoolArtifactCache = {
      env,
      value: poolArtifact,
      expiresAt: now + RPC_POOL_ARTIFACT_TTL_MS,
    };
  }
  return poolArtifact;
}

// Best-effort Postgres mirror of a single rpc_proxy_events row -- the sole
// writer now (D1 write retired 2026-07-16, item 7 of the D1->Postgres
// cleanup: confirmed unconditionally called here, live since 2026-07-11 per
// METAGRAPH_RPC_USAGE_SOURCE's own wrangler.jsonc comment, so removing the
// redundant D1 INSERT below loses nothing). Unlike every other #4832 sync
// route (all cron/workflow batch writes), this fires once per live proxied
// request -- confirmed live 2026-07-11 the real volume is trivial (69 rows
// over ~25 days), so a plain per-request env.DATA_API.fetch() under the
// SAME ctx.waitUntil is safe; revisit if traffic grows enough to warrant
// batching. Never throws, never adds latency to the proxied call.
function syncRpcUsageEventToPostgres(env, ctx, event) {
  if (!env?.DATA_API || !env?.RPC_USAGE_SYNC_SECRET) return;
  if (typeof ctx?.waitUntil !== "function") return;
  const send = env.DATA_API.fetch(
    new Request("https://api.metagraph.sh/api/v1/internal/rpc-usage-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": env.RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify(event),
    }),
  ).catch(() => {});
  ctx.waitUntil(send);
}

// Best-effort, async usage telemetry for the RPC proxy (B3). A telemetry write
// must never add latency to, or fail, a proxied call — so it runs under
// ctx.waitUntil and swallows every error. When the binding/ctx is absent
// (tests, local dev) it is a no-op. The proxy degrades to "no analytics",
// never to "broken".
function recordRpcUsage(env, ctx, event) {
  syncRpcUsageEventToPostgres(env, ctx, event);
}

// RPC reverse-proxy usage analytics (B3): request volume, latency p50/p95,
// failover + error rate, cache-hit rate, and the per-endpoint distribution that
// shows whether the load balancer is actually spreading traffic. D1 fully
// eliminated (2026-07-17): rpc_proxy_events is Postgres-only now, so a tier
// miss returns a schema-stable zeroed payload rather than a live D1 query.
export async function handleRpcUsage(request, env, url) {
  const { label, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  const meta = await readHealthMetaKv(env);
  // #4832 gap-closure: reuses tryPostgresTier's usual "forward the caller's
  // request unchanged" contract (a clean 1:1 route, unlike handleCompare's
  // embedded-helper shape). METAGRAPH_RPC_USAGE_SOURCE flipped to "postgres"
  // in wrangler.jsonc 2026-07-12 after a one-time historical backfill closed
  // the gap (see wrangler.jsonc's inline comment for the verification
  // details) -- unlike METAGRAPH_HEALTH_SOURCE/METAGRAPH_SUBNET_SNAPSHOTS_SOURCE,
  // this table's reads are always window-bounded (7d/30d) and both stores
  // only ever hold that same rolling slice, so there was no long-tail
  // history a backfill could leave behind.
  const data =
    (await tryPostgresTier(env, request, "METAGRAPH_RPC_USAGE_SOURCE")) ??
    (await loadRpcUsage({
      window: label,
      observedAt: meta?.last_run_at || null,
    }));
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(env, "/metagraph/rpc/usage.json", null),
    },
    "short",
  );
}

async function verifyMeta(env) {
  return {
    artifact_path: null,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: null,
    published_at: await publishedAt(env),
    source: "live-probe",
  };
}

// #358: live-probe one catalogued surface on demand. Safe by construction — the
// URL always comes from operational-surfaces.json (already public_safe, the exact
// URLs the 15-minute cron probes), never the caller. Gated by the RPC rate limiter
// plus a 60s per-surface Cache-API entry so repeat calls can't fan out into real
// outbound probes. An agent (or the verify_integration MCP tool) calls this to
// confirm "callable right now" before wiring.
export async function handleSurfaceVerify(request, env, surfaceId, ctx = {}) {
  // No request body — path param only — so this is a GET/HEAD action endpoint
  // (same method set as handleBadgeSvgRequest). Reject anything else before the
  // rate limiter or outbound probe can run (#6015).
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      "method_not_allowed",
      "Surface verify only accepts GET and HEAD.",
      405,
      {},
      {
        allow: "GET, HEAD, OPTIONS",
      },
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const clientKey = `verify:${resolveClientIp(request)}`;
    const { success } = await env.RPC_RATE_LIMITER.limit({ key: clientKey });
    if (!success) {
      return errorResponse(
        "verify_rate_limited",
        "Too many verify requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const catalog = await readArtifact(
    env,
    "/metagraph/operational-surfaces.json",
  );
  if (!catalog.ok) {
    return errorResponse(
      "surfaces_unavailable",
      "The operational-surface catalog is unavailable.",
      503,
    );
  }
  let surface = findSurface(catalog.data?.surfaces, surfaceId);
  if (!surface) {
    const aliases = await readArtifact(env, SURFACE_ALIASES_PATH);
    if (aliases.ok) {
      surface = findSurface(catalog.data?.surfaces, surfaceId, aliases.data);
    }
  }
  if (!surface) {
    return errorResponse(
      "surface_not_found",
      `No catalogued surface with id, key, or deprecated id "${surfaceId}".`,
      404,
      { surface_id: surfaceId },
    );
  }

  const result = await verifySurfaceWithCache(
    surface,
    {
      isUnsafeUrl: workerResolvedUrlSafetyGuard({
        fetchImpl: globalThis.fetch,
      }),
      connect: workerWebSocketConnector(globalThis.fetch),
    },
    {
      waitUntil: (promise) => ctx?.waitUntil?.(promise),
    },
  );
  return envelopeResponse(
    request,
    { data: result, meta: await verifyMeta(env) },
    "short",
  );
}

export async function handleRpcProxyRequest(request, env, url, ctx = {}) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "The RPC proxy only accepts POST requests.",
      405,
      {},
      {
        allow: "POST, OPTIONS",
      },
    );
  }

  if (env.METAGRAPH_ENABLE_RPC_PROXY !== "true") {
    return errorResponse(
      "rpc_proxy_disabled",
      "Read-only RPC proxying is intentionally disabled until endpoint scoring, abuse controls, and method filtering are enabled.",
      501,
    );
  }

  // Per-client abuse control. Skipped when the ratelimit binding is absent
  // (local dev / not yet provisioned) so tests and local runs are unaffected;
  // enforced on Cloudflare where the binding is bound.
  if (env.RPC_RATE_LIMITER?.limit) {
    const clientKey = `rpc:${resolveClientIp(request)}`;
    const { success } = await env.RPC_RATE_LIMITER.limit({ key: clientKey });
    if (!success) {
      return errorResponse(
        "rpc_rate_limited",
        "Too many RPC proxy requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const contentLength = Number(declaredLength);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return errorResponse(
        "rpc_invalid_content_length",
        "Invalid Content-Length header.",
        400,
      );
    }
    if (contentLength > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "rpc_body_too_large",
        "RPC request body is too large for the read-only proxy.",
        413,
      );
    }
  }

  let bodyText;
  let rpcBody;
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "rpc_body_too_large",
        "RPC request body is too large for the read-only proxy.",
        413,
      );
    }
    rpcBody = JSON.parse(bodyText);
  } catch {
    return errorResponse(
      "rpc_invalid_json",
      "RPC request body must be a JSON object.",
      400,
    );
  }

  if (
    !rpcBody ||
    Array.isArray(rpcBody) ||
    typeof rpcBody !== "object" ||
    typeof rpcBody.method !== "string"
  ) {
    return errorResponse(
      "rpc_invalid_request",
      "Only single JSON-RPC request objects are supported.",
      400,
    );
  }

  // State-query methods (#4344/9.2): a second, narrower allowlist for
  // state_getStorage/state_getKeysPaged. Membership alone isn't sufficient --
  // unlike every SAFE_RPC_METHODS entry, these take a caller-supplied key/
  // prefix with no natural bound, so they additionally require the param
  // validation + separate rate-limit budget below before forwarding. See
  // docs/block-explorer-data-model.md's design spike.
  const isStateQueryMethod = isSafeRpcStateQueryMethod(rpcBody.method);
  if (!isSafeRpcMethod(rpcBody.method) && !isStateQueryMethod) {
    return errorResponse(
      "rpc_method_blocked",
      `RPC method is not allowed through this proxy: ${rpcBody.method}`,
      403,
      {
        allowed_methods: [
          ...SAFE_RPC_METHODS,
          ...SAFE_RPC_STATE_QUERY_METHODS,
        ].sort(),
      },
    );
  }

  if (isStateQueryMethod) {
    // Own, stricter rate-limit budget (separate binding, not a lower shared
    // bucket) -- consumed IN ADDITION TO the general RPC_RATE_LIMITER check
    // above, so heavy state-query traffic from one client can't starve that
    // same client's ordinary chain_getBlock/system_health calls through the
    // same proxy, and vice versa.
    if (env.STATE_QUERY_RATE_LIMITER?.limit) {
      const clientKey = `rpc-state-query:${resolveClientIp(request)}`;
      const { success } = await env.STATE_QUERY_RATE_LIMITER.limit({
        key: clientKey,
      });
      if (!success) {
        return errorResponse(
          "rpc_state_query_rate_limited",
          "Too many state-query RPC requests from this client; slow down.",
          429,
          {},
          {
            "retry-after": String(STATE_QUERY_RATE_LIMIT.windowSeconds),
            "x-ratelimit-limit": String(STATE_QUERY_RATE_LIMIT.limit),
            "x-ratelimit-policy": `${STATE_QUERY_RATE_LIMIT.limit};w=${STATE_QUERY_RATE_LIMIT.windowSeconds}`,
            "x-ratelimit-remaining": "0",
          },
        );
      }
    }

    const validated = validateStateQueryParams(rpcBody.method, rpcBody.params);
    if (!validated.ok) {
      return errorResponse("rpc_invalid_request", validated.message, 400);
    }
    // state_getKeysPaged's count is clamped (not rejected) server-side --
    // rewrite both the parsed body and the raw text forwarded upstream so
    // proxyWithFailover (which forwards `bodyText`, not `rpcBody`) sees the
    // clamped value too.
    if (validated.params !== rpcBody.params) {
      rpcBody.params = validated.params;
      bodyText = JSON.stringify(rpcBody);
    }
  }

  const poolArtifact = await readRpcPoolArtifact(env);
  if (!poolArtifact.ok) {
    return errorResponse(
      poolArtifact.code,
      poolArtifact.message,
      poolArtifact.status,
      {
        artifact_path: "/metagraph/rpc/pools.json",
      },
    );
  }

  // The proxy forwards an HTTP JSON-RPC POST, so it can only reach HTTP(S)
  // upstreams. The /wss route points at WebSocket-only endpoints that cannot be
  // HTTP-POSTed, so reject it with a clear error instead of failing the upstream
  // fetch (which would surface as a 500).
  if (url.pathname.endsWith("/wss")) {
    return errorResponse(
      "rpc_websocket_unsupported",
      "WebSocket JSON-RPC is not available through this HTTP proxy. POST to /rpc/v1/finney for HTTP JSON-RPC, or connect to a public WSS endpoint directly.",
      400,
    );
  }
  // Network-aware pool selection: /rpc/v1/{network} → its pool (finney→finney-rpc,
  // test→test-rpc). An unknown network 404s instead of silently routing to
  // mainnet. `network` also tags the B3 usage telemetry below.
  const network = url.pathname.split("/")[3] || "";
  const poolId = RPC_PROXY_POOLS[network];
  if (!poolId) {
    return errorResponse(
      "rpc_network_unsupported",
      `Unknown RPC network "${network || "(none)"}". Supported networks: ${Object.keys(RPC_PROXY_POOLS).join(", ")}.`,
      404,
      { supported_networks: Object.keys(RPC_PROXY_POOLS) },
    );
  }
  const staticPool = (poolArtifact.data.pools || []).find(
    (candidate) => candidate.id === poolId,
  );
  // Overlay the 15-minute cron health so the proxy avoids sustained-down endpoints
  // (the in-isolate breaker still handles instantaneous failures). Falls back to
  // the static pool when the live snapshot is cold (always the case for the static
  // testnet pool, which is intentionally not probe-derived).
  const liveRpcPool = await readHealthKv(env, KV_HEALTH_RPC_POOL);
  const pool = overlayRpcPoolEligibility(staticPool, liveRpcPool);
  // startedAt anchors end-to-end proxy latency for the B3 usage telemetry; the
  // recorder is best-effort + async (never adds latency to / fails the call).
  const startedAt = Date.now();
  const { endpoints: candidates, unsafeEndpoint } = orderSafeRpcEndpoints(pool);
  if (!candidates.length) {
    recordRpcUsage(env, ctx, {
      observed_at: startedAt,
      network,
      endpoint_id: null,
      provider: null,
      ok: false,
      status: unsafeEndpoint ? 502 : 503,
      attempts: 0,
      latency_ms: Date.now() - startedAt,
      cache: "bypass",
    });
    if (unsafeEndpoint) {
      return errorResponse(
        "rpc_endpoint_unsafe",
        "Eligible RPC endpoint URL is not allowed by the Worker upstream safety policy.",
        502,
        { endpoint_id: unsafeEndpoint.id || null, pool_id: poolId },
      );
    }
    return errorResponse(
      "rpc_endpoint_unavailable",
      "No eligible public RPC endpoint is available for proxy routing.",
      503,
      { pool_id: poolId },
    );
  }

  // Response cache for idempotent reads (Cache API). Cache hit short-circuits
  // the upstream call; a successful, cacheable response is stored async.
  const cachePolicy = rpcCachePolicy(rpcBody.method, rpcBody.params);
  const cache = cachePolicy.cacheable ? globalThis.caches?.default : null;
  let cacheKey = null;
  if (cache) {
    cacheKey = await rpcCacheKey(network, rpcBody.method, rpcBody.params);
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Only the JSON-RPC `result` is cached (never caller-controlled envelope
      // fields like `id`), so rebuild the envelope with THIS request's id. This
      // stops a cache entry primed by one caller from replaying that caller's id
      // back to a later requester.
      let cachedPayload = null;
      try {
        cachedPayload = JSON.parse(await hit.text());
      } catch {
        // Malformed cache entry; treat as a miss and re-fetch below.
      }
      if (cachedPayload && cachedPayload.result !== undefined) {
        const headers = new Headers(hit.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-metagraph-rpc-cache", "hit");
        setRpcRateLimitHeaders(headers);
        recordRpcUsage(env, ctx, {
          observed_at: startedAt,
          network,
          endpoint_id: null,
          provider: null,
          ok: true,
          status: 200,
          attempts: 0,
          latency_ms: Date.now() - startedAt,
          cache: "hit",
        });
        return new Response(
          JSON.stringify(rpcResultEnvelope(rpcBody, cachedPayload.result)),
          { status: 200, headers },
        );
      }
    }
  }

  const response = await proxyWithFailover(candidates, { bodyText, poolId });
  // The endpoint headers are set ONLY when an upstream served (streamRpcResponse);
  // the all-failed path returns a bare 502, so a missing endpoint-id header marks
  // a routing failure (ok=false). Recorded once here — every downstream return
  // reuses this same response, so its served-endpoint/status/attempts are stable.
  const servedEndpointId = response.headers.get("x-metagraph-rpc-endpoint-id");
  recordRpcUsage(env, ctx, {
    observed_at: startedAt,
    network,
    endpoint_id: servedEndpointId,
    provider: response.headers.get("x-metagraph-rpc-provider"),
    ok: Boolean(servedEndpointId),
    status: response.status,
    // The exhausted-pool path (proxyWithFailover's final errorResponse) never
    // sets x-metagraph-rpc-attempts, so this falls through to the uncapped
    // candidate count unless clamped to the same limit proxyWithFailover
    // itself attempts against (Math.min(orderedEndpoints.length, maxAttempts)).
    attempts:
      Number(response.headers.get("x-metagraph-rpc-attempts")) ||
      Math.min(candidates.length, RPC_MAX_ATTEMPTS),
    latency_ms: Date.now() - startedAt,
    cache: cacheKey ? "miss" : "bypass",
  });
  // Post-fetch response-size cap for state-query methods (#4344/9.2): even
  // with state_getKeysPaged's count clamped above, a pathological prefix (or a
  // future param-validation gap) could still return a large payload -- cap the
  // decoded upstream body rather than relay it. Only inspected for these two
  // methods; every other proxied response is unaffected.
  if (isStateQueryMethod && response.status === 200) {
    let sizeCheck;
    try {
      sizeCheck = await readResponseTextWithLimit(
        response.clone(),
        MAX_STATE_QUERY_RESPONSE_BYTES,
      );
    } catch {
      // proxyWithFailover already tees the upstream body and fully drains its
      // own inspection branch before ever returning a 200 here (see its
      // "body-read-error" handling above) -- this sibling tee branch failing
      // independently at this point isn't reachable in practice. Kept for the
      // same reason the pre-existing cache-classification catch below is.
      /* v8 ignore next */
      sizeCheck = null;
    }
    if (sizeCheck?.truncated) {
      return errorResponse(
        "rpc_response_too_large",
        "The upstream response for this state-query method exceeded the size limit for the public proxy.",
        502,
      );
    }
  }

  if (!cacheKey) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("x-metagraph-rpc-cache", "miss");
  if (response.status !== 200) {
    return new Response(response.body, { status: response.status, headers });
  }

  // Cacheable method, cache miss: inspect a bounded clone so oversized upstream
  // results are streamed back to the client instead of buffered in the Worker.
  let inspect;
  try {
    inspect = await readResponseTextWithLimit(
      response.clone(),
      RPC_CLASSIFY_BODY_LIMIT_BYTES,
    );
  } catch {
    // Classification is best-effort: a flaky upstream body should not turn a
    // proxied response into a Worker exception while cache inspection is active.
    return new Response(response.body, { status: response.status, headers });
  }
  if (!inspect.truncated) {
    let parsed = null;
    try {
      parsed = JSON.parse(inspect.text);
    } catch {
      // body is not JSON; leave parsed null so it is not cached.
    }
    if (
      parsed &&
      parsed.result !== undefined &&
      parsed.result !== null &&
      parsed.error === undefined
    ) {
      // A `null` result is the "not available yet" sentinel for these reads —
      // chain_getBlockHash(N) returns null until block N is produced — so it is
      // NOT immutable and must never be pinned under the long block-read TTL, or
      // callers keep replaying the stale null after the real hash exists.
      // Persist ONLY the cacheable `result` — not the upstream envelope, which
      // carries the priming caller's `id`. The envelope is rebuilt per request
      // on a cache hit above.
      const cached = new Response(JSON.stringify({ result: parsed.result }), {
        status: 200,
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          "cache-control": `public, s-maxage=${cachePolicy.ttl}`,
        },
      });
      ctx?.waitUntil?.(cache.put(cacheKey, cached));
    }
  }
  return new Response(response.body, { status: response.status, headers });
}

// Exported so tests/docs-content-drift.test.mjs can assert content/docs/rpc.mdx
// documents the real values instead of a second hand-copied literal.
export const RPC_MAX_ATTEMPTS = 3;
const RPC_ATTEMPT_TIMEOUT_MS = 6000;
const RPC_CLASSIFY_BODY_LIMIT_BYTES = 64 * 1024;
// /rpc/v1/{network} → the pool id served from rpc/pools.json. Adding a network
// here (plus its pool + allowlisted origins) is all the proxy needs to serve it.
export const RPC_PROXY_POOLS = { finney: "finney-rpc", test: "test-rpc" };
// Max blocks an endpoint may trail the freshest reported tip before the proxy
// demotes it behind synced nodes. Bittensor block time is ~12s, so ~10 blocks
// (~15 min) tolerates cross-provider probe-timing skew while still routing around
// a genuinely stalled/lagging node.
const BLOCK_LAG_TOLERANCE = 10;

// JSON-RPC error codes that signal node trouble (retry another upstream) rather
// than a client/application error (return immediately so we don't mask a real
// error by trying every node).
const TRANSIENT_RPC_ERROR_CODES = new Set([-32603]); // internal error

// In-isolate circuit breaker: count consecutive transient failures per endpoint
// and temporarily eject (deprioritise) repeat offenders. Per-isolate only (no
// global view, resets on cold start) — cheap and enough to ride out the burst
// that matters. RPC_HEALTH is the module-default map; injectable for tests.
const RPC_HEALTH = new Map(); // endpointId -> { fails, ejectedUntil }
const RPC_EJECT_THRESHOLD = 3;
const RPC_EJECT_COOLDOWN_MS = 30_000;

export function recordRpcFailure(map, id, now) {
  const entry = map.get(id) || { fails: 0, ejectedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= RPC_EJECT_THRESHOLD && entry.ejectedUntil <= now) {
    entry.ejectedUntil = now + RPC_EJECT_COOLDOWN_MS;
  }
  map.set(id, entry);
}

export function recordRpcSuccess(map, id) {
  map.delete(id);
}

export function isRpcEndpointEjected(map, id, now) {
  const entry = map.get(id);
  return Boolean(entry && entry.ejectedUntil > now);
}

// Per-method response-cache policy for idempotent reads. Default-deny: only
// block-pinned (by an explicit block number/hash param) or quasi-static reads
// are cacheable; head-moving forms (param-less block reads, finalized head,
// system_health) are never cached.
export function rpcCachePolicy(method, params) {
  const args = Array.isArray(params) ? params : [];
  switch (method) {
    case "chain_getBlockHash":
      return args.length &&
        (typeof args[0] === "number" || /^\d+$/.test(String(args[0])))
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "chain_getBlock":
    case "chain_getHeader":
      return args.length &&
        typeof args[0] === "string" &&
        args[0].startsWith("0x")
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "state_getRuntimeVersion":
    case "system_chain":
    case "system_name":
    case "system_version":
    case "system_properties":
    case "rpc_methods":
      return { cacheable: true, ttl: 300 };
    default:
      return { cacheable: false, ttl: 0 };
  }
}

// Build a minimal JSON-RPC success envelope around a cached `result`, echoing
// the current request's `id` (when present) so cache hits never replay another
// caller's id.
function rpcResultEnvelope(requestBody, result) {
  const envelope = { jsonrpc: "2.0" };
  if (Object.prototype.hasOwnProperty.call(requestBody, "id")) {
    envelope.id = requestBody.id;
  }
  envelope.result = result;
  return envelope;
}

async function rpcCacheKey(network, method, params) {
  const normalized = JSON.stringify([
    network,
    method,
    Array.isArray(params) ? params : [],
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(
    `https://rpc-cache.metagraph.internal/${network}/${method}/${hash}`,
  );
}

// Decide how to treat one upstream attempt: "transient" (fail over to the next
// endpoint), "success"/"fatal" (return this upstream's response to the client).
export function classifyUpstreamAttempt({ thrown, status, parsedBody }) {
  if (thrown) return "transient"; // network error or AbortSignal timeout
  if (status >= 500 || status === 429) return "transient";
  // A redirect (3xx) or the opaqueredirect sentinel (status 0, produced by the
  // `redirect: "manual"` fetch below) is never a valid JSON-RPC response. The
  // allowlist only vetted the INITIAL upstream, so a redirect must not be
  // followed OR accepted. Classify it as transient — NOT fatal: the success
  // branch in proxyWithFailover gates on `status < 400` (not the classification),
  // so a "fatal" 3xx would still slip through there and be returned to the
  // client with recordRpcSuccess. "transient" is caught first, so the attempt is
  // recorded as failed and we fail over to the next allowlisted endpoint.
  if (status === 0 || (status >= 300 && status < 400)) return "transient";
  if (status >= 400) return "fatal"; // upstream rejected the request itself
  if (parsedBody && typeof parsedBody === "object" && parsedBody.error) {
    if (TRANSIENT_RPC_ERROR_CODES.has(Number(parsedBody.error.code))) {
      return "transient";
    }
  }
  return "success";
}

async function readResponseTextWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: new TextEncoder().encode(text).byteLength > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {});
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

function streamRpcResponse(upstream, endpoint, attempts, status) {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-rpc-endpoint-id", endpoint.id);
  headers.set("x-metagraph-rpc-provider", endpoint.provider);
  headers.set("x-metagraph-rpc-attempts", String(attempts.length + 1));
  setRpcRateLimitHeaders(headers);
  return new Response(upstream.body, { status: status || 502, headers });
}

// Advisory rate-limit headers on RPC proxy responses. The Cloudflare rate-limit
// binding (RPC_RATE_LIMITER) only returns {success}, so an exact remaining/reset
// is unavailable — we surface the static policy (mirrors wrangler.jsonc:
// 100 requests / 60s) plus Retry-After on a 429. Exported (see
// RPC_MAX_ATTEMPTS above) for the docs-content drift test.
export const RPC_RATE_LIMIT = { limit: 100, windowSeconds: 60 };
// Mirrors wrangler.jsonc's STATE_QUERY_RATE_LIMITER binding (#4344/9.2) --
// a fifth of the general proxy's budget, its own separate bucket.
export const STATE_QUERY_RATE_LIMIT = { limit: 20, windowSeconds: 60 };
function setRpcRateLimitHeaders(headers) {
  headers.set("x-ratelimit-limit", String(RPC_RATE_LIMIT.limit));
  headers.set(
    "x-ratelimit-policy",
    `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
  );
}

// Per-client abuse control for the GraphQL endpoint. GraphQL is POST-only and
// runs before the read-only method gate, so — unlike the GET REST routes that
// the edge can cache — every call hits the worker and fans out into one or more
// artifact reads + query execution. That makes it at least as expensive as the
// RPC proxy, so it shares the SAME strict limiter binding, bucket strategy
// (cf-connecting-ip only; see resolveClientIp), policy, and 429 shape. The key is
// namespaced (`gql:`) so each surface draws its own independent 100/60s budget —
// matching the per-surface x-ratelimit headers each one advertises, instead of a
// caller's RPC traffic silently consuming the GraphQL budget (or vice versa).
// Skipped only when the binding is absent (local dev / CI), matching the RPC/MCP
// paths. Returns a 429 Response when the caller is over the limit, else null.
export async function graphqlRateLimited(request, env) {
  if (!env.RPC_RATE_LIMITER?.limit) return null;
  const { success } = await env.RPC_RATE_LIMITER.limit({
    key: `gql:${resolveClientIp(request)}`,
  });
  if (success) return null;
  return errorResponse(
    "graphql_rate_limited",
    "Too many GraphQL requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

// Try each ordered endpoint in turn; return the first success / non-transient
// response, and a clean 502 only when every attempt is a transient failure.
// Transient HTTP statuses are classified before reading bodies, and JSON-RPC
// error-envelope inspection is bounded so large upstream responses can stream.
export async function proxyWithFailover(
  orderedEndpoints,
  {
    bodyText,
    poolId,
    fetchFn = fetch,
    maxAttempts = RPC_MAX_ATTEMPTS,
    timeoutMs = RPC_ATTEMPT_TIMEOUT_MS,
    healthMap = RPC_HEALTH,
  },
) {
  const attempts = [];
  const limit = Math.min(orderedEndpoints.length, maxAttempts);
  for (let index = 0; index < limit; index += 1) {
    const endpoint = orderedEndpoints[index];
    let status = 0;
    let upstream = null;
    let parsedBody = null;
    let thrown = false;
    try {
      upstream = await fetchFn(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        // Never auto-follow an upstream redirect: only the initial endpoint was
        // checked against TRUSTED_RPC_UPSTREAM_ORIGINS, so following a 3xx would
        // re-POST the caller's body to an unvetted host. A 3xx/opaqueredirect is
        // classified transient (see classifyUpstreamAttempt) → failed attempt.
        // Mirrors the redirect:"manual" invariant in webhooks.mjs /
        // health-probe-core.mjs.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = upstream.status;
    } catch {
      thrown = true;
    }

    if (
      classifyUpstreamAttempt({ thrown, status, parsedBody }) === "transient"
    ) {
      await upstream?.body?.cancel?.();
      recordRpcFailure(healthMap, endpoint.id, Date.now());
      attempts.push({
        endpoint_id: endpoint.id,
        reason: thrown ? "unreachable" : `status-${status}`,
      });
      continue;
    }

    if (upstream && status < 400) {
      let clientBodyToCancel = null;
      try {
        if (upstream.body?.tee) {
          const [inspectBody, clientBody] = upstream.body.tee();
          clientBodyToCancel = clientBody;
          const inspect = await readResponseTextWithLimit(
            new Response(inspectBody),
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              await clientBody.cancel();
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(clientBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        } else {
          const inspect = await readResponseTextWithLimit(
            upstream,
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(inspect.text, {
            status,
            headers: upstream.headers,
          });
        }
      } catch {
        await clientBodyToCancel?.cancel?.().catch(() => {});
        await upstream?.body?.cancel?.().catch(() => {});
        recordRpcFailure(healthMap, endpoint.id, Date.now());
        attempts.push({
          endpoint_id: endpoint.id,
          reason: "body-read-error",
        });
        continue;
      }
    }

    // The endpoint responded (success, or an application-level error) — it is
    // reachable, so clear any breaker state for it.
    recordRpcSuccess(healthMap, endpoint.id);
    return streamRpcResponse(upstream, endpoint, attempts, status);
  }

  // Every attempt failed transiently. Return a fixed message — never echo an
  // upstream error body (leak hygiene).
  return errorResponse(
    "rpc_upstream_unavailable",
    "All eligible RPC upstreams failed; try again shortly.",
    502,
    {
      pool_id: poolId,
      attempts: attempts.map((a) => a.endpoint_id),
      last_reason: attempts.at(-1)?.reason || null,
    },
  );
}

// Build the FULL ordered candidate list of eligible, upstream-safe, HTTP(S)
// endpoints for the proxy to fail over across. Ordering is a weighted shuffle
// (favour higher score, keep load spread) so failover walks best→worst without
// always hammering one upstream. wss:// endpoints are dropped (not HTTP-
// proxyable); a genuinely unsafe URL is reported (for a 502) only when no safe
// endpoint exists. Circuit-breaker-ejected endpoints are deprioritised to the
// back (never removed) so a fully-ejected pool still self-heals via half-open
// retries. randomFn / healthMap / now / trustedOrigins injectable for tests
// and for the isolated fullnode gate (#6835/ADR 0021), which passes its own
// origin allowlist + its own healthMap so its circuit-breaker state never
// mixes with the public pool's.
export function orderSafeRpcEndpoints(
  pool,
  randomFn = Math.random,
  {
    healthMap = RPC_HEALTH,
    now = Date.now(),
    trustedOrigins = TRUSTED_RPC_UPSTREAM_ORIGINS,
  } = {},
) {
  const safe = [];
  let unsafeEndpoint = null;
  for (const endpoint of pool?.endpoints || []) {
    if (!endpoint?.pool_eligible) {
      continue;
    }
    if (!isSafeRpcEndpointUrl(endpoint.url, trustedOrigins)) {
      unsafeEndpoint ||= endpoint;
      continue;
    }
    // Safe origin but wss:// — not HTTP-POST-able; skip without flagging unsafe.
    if (endpoint.url.startsWith("https://")) {
      safe.push(endpoint);
    }
  }

  const remaining = [...safe];
  const shuffled = [];
  while (remaining.length) {
    const pick = weightedPickEndpoint(remaining, randomFn);
    shuffled.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  const live = shuffled.filter(
    (e) => !isRpcEndpointEjected(healthMap, e.id, now),
  );
  const ejected = shuffled.filter((e) =>
    isRpcEndpointEjected(healthMap, e.id, now),
  );
  // Prefer the most-synced live nodes (like cosmos.directory's "most up-to-date"
  // routing): any endpoint more than BLOCK_LAG_TOLERANCE behind the freshest
  // reported tip is demoted behind the synced set — it would serve stale reads.
  // Endpoints with no readable block height keep their place (can't judge them);
  // the weighted-random order within each band is preserved for load spread.
  const liveBlocks = live
    .map((e) => Number(e.latest_block))
    .filter((b) => Number.isFinite(b) && b > 0);
  const maxBlock = liveBlocks.length ? Math.max(...liveBlocks) : null;
  const isLagging = (endpoint) => {
    const block = Number(endpoint.latest_block);
    return (
      maxBlock != null &&
      Number.isFinite(block) &&
      block > 0 &&
      maxBlock - block > BLOCK_LAG_TOLERANCE
    );
  };
  const synced = live.filter((endpoint) => !isLagging(endpoint));
  const lagging = live.filter(isLagging);
  const ordered = [...synced, ...lagging, ...ejected];
  return {
    endpoints: ordered,
    unsafeEndpoint: ordered.length ? null : unsafeEndpoint,
  };
}

// Back-compat single-pick wrapper (still used by tests): the first of the
// weighted-ordered list.
export function selectSafeRpcEndpoint(pool, randomFn = Math.random) {
  const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints(pool, randomFn);
  return { endpoint: endpoints[0] ?? null, unsafeEndpoint };
}

// Weighted-random pick favouring higher-scored (healthier/faster) endpoints,
// falling back to uniform weighting when scores are absent so traffic still
// spreads. randomFn is injectable for deterministic tests.
export function weightedPickEndpoint(endpoints, randomFn = Math.random) {
  if (endpoints.length === 1) {
    return endpoints[0];
  }
  const weights = endpoints.map((endpoint) =>
    Number.isFinite(endpoint.score) && endpoint.score > 0 ? endpoint.score : 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = randomFn() * total;
  for (let index = 0; index < endpoints.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) {
      return endpoints[index];
    }
  }
  return endpoints[endpoints.length - 1];
}

// trustedOrigins defaults to the public pool's allowlist so every existing
// call site is unaffected; the isolated fullnode gate (#6835/ADR 0021) passes
// its own separate Set so a public-pool origin can never satisfy a gated
// request's safety check, or vice versa.
function isSafeRpcEndpointUrl(
  value,
  trustedOrigins = TRUSTED_RPC_UPSTREAM_ORIGINS,
) {
  if (typeof value !== "string") {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!["https:", "wss:"].includes(parsed.protocol)) {
    return false;
  }

  if (!trustedOrigins.has(parsed.origin)) {
    return false;
  }

  return !isPrivateOrLocalHostname(parsed.hostname);
}

// Shared IPv4 private/CGNAT-range predicate — applied both to a bare IPv4
// hostname and to the v4 address embedded in an IPv4-mapped/compatible/6to4/
// NAT64 IPv6 literal (see below). [first, second] are the leading two octets.
function isPrivateIpv4Octets([first, second]) {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    // 100.64.0.0/10 CGNAT — the webhook, build, and health-probe SSRF guards
    // already block this range (#2312/#2313); keep this guard at parity.
    (first === 100 && second >= 64 && second <= 127)
  );
}

// Exported for direct unit testing: TRUSTED_RPC_UPSTREAM_ORIGINS is a fixed set
// of registered domains, so no currently-configured origin can ever reach the
// private-IP branches below through isSafeRpcEndpointUrl alone — this is
// defense in depth against a future origin entry resolving privately, the same
// posture health-probe-core.mjs's isUnsafePublicUrl documents for its guard.
export function isPrivateOrLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4Address(host);
  if (ipv4) {
    return isPrivateIpv4Octets(ipv4);
  }

  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80")
  ) {
    return true;
  }

  // The WHATWG URL parser re-serializes an IPv4-mapped/compatible/6to4/NAT64
  // IPv6 literal into hex-tail form (e.g. the bracketed literal for
  // ::ffff:100.64.0.1 becomes ::ffff:6440:1 in `new URL(...).hostname`), so a
  // dotted-quad string-prefix match against that value never fires on the real
  // request path. Parse the embedded v4 the same way src/webhooks.mjs and
  // src/health-probe-core.mjs already do (via the shared src/ip-safety.mjs
  // leaf) and re-check it against the same private-range policy.
  const embedded = ipv6EmbeddedIpv4(host);
  return embedded ? isPrivateIpv4Octets(embedded) : false;
}

function parseIpv4Address(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }

  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isSafeRpcMethod(method) {
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_METHODS.has(method);
}

// #4344/9.2: same DENIED_RPC_PREFIXES defense-in-depth as isSafeRpcMethod,
// then membership in the narrower state-query set.
function isSafeRpcStateQueryMethod(method) {
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_STATE_QUERY_METHODS.has(method);
}

// A real storage key/prefix is always 0x-prefixed hex -- reject anything else
// or anything past MAX_STATE_QUERY_KEY_HEX_CHARS outright (no real key/prefix
// legitimately needs more).
function isValidStateQueryHex(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_STATE_QUERY_KEY_HEX_CHARS + 2 &&
    /^0x[0-9a-fA-F]*$/.test(value)
  );
}

// Substrate block hashes are H256 -- exactly 32 bytes as 0x-prefixed hex.
// Narrower than isValidStateQueryHex (variable-length storage keys): an
// optional `at` param that isn't this shape must not reach upstream (#6014).
function isValidBlockHashHex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

// Validates + (for state_getKeysPaged) clamps the caller-supplied params for
// a state-query method (#4344/9.2). Returns {ok:true, params} -- `params` is
// the SAME array reference when nothing needed clamping, a new one otherwise,
// so the caller can cheaply tell whether the request body needs re-serializing.
// Returns {ok:false, message} on a malformed key/prefix -- the same
// rpc_invalid_request shape the existing body-shape check above uses, no new
// error taxonomy needed.
function validateStateQueryParams(method, params) {
  const args = Array.isArray(params) ? params : [];
  if (method === "state_getStorage") {
    // state_getStorage: [key, at?]
    if (!isValidStateQueryHex(args[0])) {
      return {
        ok: false,
        message:
          "state_getStorage requires params[0] to be a 0x-prefixed hex storage key.",
      };
    }
    // at (params[1]), when present, is a block hash (H256).
    if (args[1] !== undefined && !isValidBlockHashHex(args[1])) {
      return {
        ok: false,
        message:
          "state_getStorage requires params[1] (at), when present, to be a 0x-prefixed 32-byte block hash.",
      };
    }
    return { ok: true, params };
  }
  // state_getKeysPaged: [prefix, count, startKey?, at?]
  if (!isValidStateQueryHex(args[0])) {
    return {
      ok: false,
      message:
        "state_getKeysPaged requires params[0] to be a 0x-prefixed hex key prefix.",
    };
  }
  // startKey (params[2]), when present, is also a storage key.
  if (args[2] !== undefined && !isValidStateQueryHex(args[2])) {
    return {
      ok: false,
      message:
        "state_getKeysPaged requires params[2] (startKey), when present, to be a 0x-prefixed hex key.",
    };
  }
  // at (params[3]), when present, is a block hash (H256).
  if (args[3] !== undefined && !isValidBlockHashHex(args[3])) {
    return {
      ok: false,
      message:
        "state_getKeysPaged requires params[3] (at), when present, to be a 0x-prefixed 32-byte block hash.",
    };
  }
  const rawCount = args[1];
  const count =
    typeof rawCount === "number" && Number.isFinite(rawCount)
      ? Math.trunc(rawCount)
      : Number.NaN;
  if (!Number.isFinite(count) || count < 0) {
    return {
      ok: false,
      message:
        "state_getKeysPaged requires params[1] (count) to be a non-negative integer.",
    };
  }
  const clamped = Math.min(count, MAX_STATE_QUERY_KEYS_PAGE_SIZE);
  if (clamped === rawCount) return { ok: true, params };
  const nextParams = [...args];
  nextParams[1] = clamped;
  return { ok: true, params: nextParams };
}
