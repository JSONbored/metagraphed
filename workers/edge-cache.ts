// Shared edge-cache and degradation handling, without analytics route startup.
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "../src/chain-network.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import { ifNoneMatchSatisfied, withCacheStatus } from "./http.ts";
import { contractVersion } from "./responses.ts";
import { currentDataApiTierFallbackGeneration } from "./data-api-tier.ts";
import { currentR2SqlFailureGeneration } from "../src/r2-sql.ts";
import { currentOffsetCapDeclineGeneration } from "../src/r2-sql-blocks.ts";
const DATA_API_TIER_FALLBACK_RESPONSES = new WeakSet<Response>();

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
 * An UNMEASURED answer is not the same thing as a DEGRADED one, and #10189
 * turns on keeping them apart.
 *
 * #9110 gave withEdgeCache one signal for both: tryDataApiTier's counter set
 * the `x-metagraph-degraded` header AND suppressed caching, which was right
 * while the two always coincided -- a tier that just failed will probably
 * succeed next minute, so caching the failure prolongs it.
 *
 * A projection decline is different. `loadChainFeesFromArtifact` and its
 * siblings return null on an absent artifact, an unknown window, or a scope
 * they never precompute -- states that are stable for the whole cache TTL, not
 * transient failures. Those answers SHOULD carry the header (a caller must not
 * read zeros as measured) and SHOULD still be cacheable, which is what the
 * suite already asserts in a dozen places ("chain-signers ... is
 * edge-cacheable", "a healthy CSV response is edge-cached").
 *
 * So this counter labels without suppressing, and tryDataApiTier's keeps
 * doing both. Wrapping the final `?? build…()` operand is what makes it exact:
 * `??` short-circuits, so it runs on precisely the requests that get an empty
 * body and never on one carrying data.
 *
 * Measured 2026-08-08, driving each route with no flag forced -- the
 * configuration production actually runs -- 9 of 12 answered `ok: true` with
 * zeros and no header at all.
 */
let unmeasuredGeneration = 0;

registerModuleStateReset("workers/edge-cache.ts:unmeasured", () => {
  unmeasuredGeneration = 0;
});

export function unmeasured<T>(stub: T): T {
  unmeasuredGeneration += 1;
  return stub;
}

/**
 * Set the degraded header, returning the SAME object where possible.
 *
 * Identity matters: `withEdgeCache` reads a WeakSet on the object it gets
 * back, and handlers pass this response straight on, so returning a copy would
 * break that invariant. A response read back out of the edge cache has
 * immutable headers -- that path does not reach here today, and copying is the
 * right fallback if it ever does, rather than throwing on a degraded response.
 */
function withDegradedHeader(response: Response): Response {
  try {
    response.headers.set(DEGRADED_HEADER, DEGRADED_TIER_UNAVAILABLE);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(DEGRADED_HEADER, DEGRADED_TIER_UNAVAILABLE);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Tag a response as having used the empty-fallback path, and say so to the
 * caller.
 *
 * Adds the never-cache WeakSet membership on top of the header (the #1760 bug
 * class it exists for): a tier that just failed will likely succeed on the next
 * request, so persisting the failure would prolong it. An UNMEASURED answer
 * takes the header alone -- see `unmeasured`.
 */
export function markDataApiTierFallbackResponse(response: Response): Response {
  const marked = withDegradedHeader(response);
  DATA_API_TIER_FALLBACK_RESPONSES.add(marked);
  return marked;
}

/**
 * Every "this answer was not measured" counter, read as one value (#10270).
 *
 * There are three of them and they lived in three modules, so each place that
 * wanted to know whether an answer was real had to remember the full list.
 * `withEdgeCache` remembered two; the r2-sql one it never knew about at all,
 * even though `src/r2-sql.ts` declares its counter with "same contract as the
 * Postgres tier's fallback generation: a caller can snapshot this before a
 * read and compare after". Nothing outside its own test file ever did --
 * measured repo-wide, `currentR2SqlFailureGeneration` had zero production
 * readers -- which is why `/accounts/{ss58}/counterparties` could answer
 * `counterparty_count: 0, transfers_scanned: 0` with `ok: true` and no header
 * while the lakehouse was rate-limited. That route's Postgres rung is
 * `"retired"` in wrangler.jsonc, so the r2-sql read IS the tier; a signal
 * nobody reads is the same as no signal.
 */
export interface DegradedSnapshot {
  postgresTier: number;
  r2Sql: number;
  unmeasured: number;
  /**
   * Reads that declined a too-deep offset WITHOUT issuing a query (#11142).
   *
   * A fourth counter because the other three cannot see this one. `r2Sql`
   * moves when a query fails; the emulated-offset cap is checked before any SQL
   * is built, so nothing is sent, nothing fails, and the answer went out as a
   * bare 200 whose body was byte-identical to end-of-feed -- on ten paginated
   * routes, edge-cached for the TTL.
   *
   * Counted at the single check in `offsetBeyondEmulationCap` rather than at
   * each route's `?? build...([])`, because there are 92 of those and the whole
   * design of this labelling is that no handler has to remember it.
   */
  offsetCapDeclined: number;
}

export function degradedSnapshot(): DegradedSnapshot {
  return {
    postgresTier: currentDataApiTierFallbackGeneration(),
    r2Sql: currentR2SqlFailureGeneration(),
    unmeasured: unmeasuredGeneration,
    offsetCapDeclined: currentOffsetCapDeclineGeneration(),
  };
}

/**
 * What moved since `before`, split by how long it will stay true.
 *
 * TRANSIENT is a tier that failed or backed off -- a DATA_API subrequest that
 * did not land, an r2-sql timeout, the account rate-limit breaker declining to
 * ask. It will likely succeed on the next request, so the answer is labelled
 * AND barred from the edge cache; persisting it would prolong the outage
 * (#1760).
 *
 * UNMEASURED is a stable decline: a projection this route never precomputes,
 * an artifact that is absent. Still labelled -- a caller must not read those
 * zeros as measured -- but cacheable for the whole TTL, because it will answer
 * the same way for the whole TTL (#10189).
 */
export function degradedSince(before: DegradedSnapshot): {
  transient: boolean;
  unmeasured: boolean;
} {
  const now = degradedSnapshot();
  return {
    transient:
      now.postgresTier !== before.postgresTier || now.r2Sql !== before.r2Sql,
    // An offset-cap decline is UNMEASURED, not transient: the same offset
    // declines identically for the whole TTL, so the answer stays cacheable and
    // merely stops claiming to be measured. Barring it from the cache would
    // re-run a refusal that cannot change.
    unmeasured:
      now.unmeasured !== before.unmeasured ||
      now.offsetCapDeclined !== before.offsetCapDeclined,
  };
}

/**
 * Label a response whose data tier declined while it was being served.
 *
 * Called from the router (`workers/api.ts`), which is the ONE point every
 * route passes -- the same argument #9110 made for labelling inside
 * `withEdgeCache` rather than in each handler, applied to the 71 tier-reading
 * handlers in `workers/request-handlers/entities.ts` that #9110 never covered
 * because not one of them uses `withEdgeCache`.
 *
 * HEADER ONLY, no cache-control rewrite. These routes have no server-side
 * cache to poison -- measured live 2026-08-09, an api.metagraph.sh response
 * carries no `cf-cache-status` at all, so the Workers Cache API inside
 * `withEdgeCache` is the only cache in play and it makes its own decision from
 * the same snapshot. Rewriting `cache-control` here would instead make every
 * response in an isolate uncacheable for the length of an r2-sql cooldown,
 * which is load amplification aimed at the exact condition the breaker exists
 * to relieve.
 *
 * A 304 is skipped: the caller already holds the body its ETag names, and
 * there is nothing in a 304 to mislabel. A response that already carries the
 * header is left alone rather than re-set, so a handler that classified its
 * own degradation keeps its own wording.
 *
 * IN PLACE, returning nothing, which is a deliberate difference from
 * `withDegradedHeader`'s copy-on-immutable fallback. The one response class
 * with immutable headers is a body read back out of the edge cache, and
 * `withEdgeCache` only ever stored a MEASURED answer there -- so a throw here
 * means a concurrent request degraded while this one was served from cache,
 * and relabelling a known-good cached body on that evidence would be the false
 * positive rather than the catch. Swallowing it is the correct answer, not the
 * convenient one. Mutating also keeps the router's return type exactly what
 * the dispatch inferred, so the label costs no signature change at ~40 return
 * sites.
 */
export function labelDegradedResponse(
  response: Response,
  before: DegradedSnapshot,
): void {
  if (response.status !== 200) return;
  if (response.headers.has(DEGRADED_HEADER)) return;
  const moved = degradedSince(before);
  if (!moved.transient && !moved.unmeasured) return;
  try {
    response.headers.set(DEGRADED_HEADER, DEGRADED_TIER_UNAVAILABLE);
  } catch {
    // An immutable-headers response: see above.
  }
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

/**
 * An edge-cache label scoped to its chain.
 *
 * MAINNET KEEPS ITS BARE LABEL, so every warm entry survives this change and a
 * mainnet request hits the key it hit before. The `/{network}/` prefix is
 * stripped before dispatch, so without this the two chains reach these handlers
 * with byte-identical paths and would share one cache entry -- and since their
 * shapes are identical, a testnet card served to a mainnet caller would look
 * completely well-formed.
 */
export function edgeCacheScope(
  label: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  return network === DEFAULT_CHAIN_NETWORK ? label : `${label}:${network}`;
}

export async function withStampedEdgeCache(
  request: Request,
  ctx: EdgeCacheCtx | undefined,
  env: Env,
  keyParts: string,
  buildResponse: (cacheRequest: Request) => Response | Promise<Response>,
  cachePathAndSearch: string | null,
  resolveCacheStamp: (env: Env) => Promise<string | null>,
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
    stamp = await resolveCacheStamp(env);
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
        return withCacheStatus(
          new Response(null, { status: 304, headers: hit.headers }),
          "hit",
        );
      }
      return withCacheStatus(
        normalizesHead
          ? new Response(null, { status: hit.status, headers: hit.headers })
          : hit,
        "hit",
      );
    }
  }
  const before = degradedSnapshot();
  const built = await buildResponse(cacheRequest);
  // #9110: the generation counter already told us the tier degraded while this
  // request was being served -- it is what suppresses caching two lines down.
  // Until now that was the ONLY thing it did, so 16 of the 21 tier-reading
  // handlers returned an unlabelled empty payload: `total: 0`, `ok: true`, and
  // no way for a caller to tell it from a measured zero.
  //
  // Labelling here rather than in each handler is deliberate. Only 5 of the 21
  // remembered to call markDataApiTierFallbackResponse; a per-handler flag is
  // exactly the thing the 22nd handler will forget. Every one of them already
  // goes through this function.
  //
  // The counter is module-global, so a CONCURRENT request degrading can label
  // this one too. That is the same trade the cache-suppression below already
  // makes, and it errs the safe way: a false "degraded" makes good data look
  // suspect, where the bug it replaces made missing data look measured.
  //
  // #10270: the r2-sql counter joined the two this used to read by name. It
  // was declared for exactly this comparison and had no reader -- see
  // `degradedSnapshot`. The suppression below is what it was declared FOR: an
  // r2-sql decline is a 60s account-wide breaker, and caching its empty answer
  // for the full TTL outlives the condition that produced it.
  const moved = degradedSince(before);
  const degraded =
    DATA_API_TIER_FALLBACK_RESPONSES.has(built) || moved.transient;
  // #10189: an unmeasured answer is labelled but NOT made uncacheable. See
  // `unmeasured` above for why the two signals have to be separate -- a
  // projection decline is stable for the whole TTL, where a tier failure is
  // transient and caching it would prolong the outage.
  const labelled = built.status === 200 && !built.headers.has(DEGRADED_HEADER);
  let response = built;
  if (labelled && degraded) {
    response = markDataApiTierFallbackResponse(built);
  } else if (labelled && moved.unmeasured) {
    response = withDegradedHeader(built);
  }
  // Never cache errors / non-200s (a cold Postgres tier still returns a 200
  // empty envelope; a 400 bad-window or 5xx must not be persisted).
  if (
    cache &&
    cacheKey &&
    response.status === 200 &&
    !DATA_API_TIER_FALLBACK_RESPONSES.has(response) &&
    !moved.transient
  ) {
    ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
  }
  // Stamped AFTER the `cache.put` above, which stores `response.clone()`, so
  // the stored copy stays unlabelled. See `withCacheStatus`.
  return withCacheStatus(
    normalizesHead
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response,
    "miss",
  );
}
