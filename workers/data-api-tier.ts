import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import { maskRouteParams } from "../src/route-label.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";

// DATA_API-forwarding serving gate, one env flag per data source (originally
// ADR 0013 Sequencing step 3's gated D1 -> Postgres cutover; D1 fully
// eliminated 2026-07-17 -- reconfirmed 2026-08-11, zero `d1_databases` blocks
// in any wrangler config and no store binding on any deployed Worker).
//
// WHAT THE FLAGS ACTUALLY READ, measured across all three configs 2026-08-11:
// 8 read "retired", 8 read "d1", and NONE reads "postgres". The
// `value === "postgres"` disjunct below is therefore unreachable in
// production. It survives because 657 sites in tests/ use "postgres" as the
// "forward this" value, so deleting it is a test migration rather than a
// dead-branch removal -- #10223 step 2, after #10190's sweep.
//
// A READER WHO TRUSTS THESE NAMES WILL BE WRONG TWICE: "d1" is the live
// forwarding value and names no D1, and "postgres" names no Postgres box --
// both stores were wiped. The forward lands on DATA_API, which reads Neon
// through Hyperdrive. Renaming the surviving concept is #10223's step 3, and
// it wants the sweep to land first so 407 call sites are not churned twice.
//
// Each tier keeps its own flag as a kill switch: a failure here degrades to a
// schema-stable EMPTY response (there is no second store left to fall back
// to), so a maintainer can force that same degraded-but-never-erroring state
// with a single flag flip if a specific tier needs to be taken offline, with
// no code change or redeploy.
// `request` is forwarded to the DATA_API service binding after normalizing HEAD
// probes to GET: DATA_API is GET-only, while the public API computes HEAD
// metadata from the GET representation and strips the body later. The caller
// has already run its own validation (or, for an MCP tool caller, already
// validated via its own inputSchema), so this trusts well-formed params and
// treats ANY failure (binding absent, network error, non-2xx, unparseable/
// malformed body) as "degrade to the empty response," never as a
// client-facing error.
//
// Extracted from workers/request-handlers/entities.ts (#4668/#4686) into this
// neutral module so src/mcp-server.ts (#4694) can share the identical
// contract without importing a route-handler file or duplicating the fallback
// logic -- REST's handleBlocks/handleExtrinsics and MCP's list_extrinsics/
// get_extrinsic all call this same function.
//
// Every branch below logs + captures before falling back (#4686 logging;
// error-tracking capture added 2026-07-25) -- prior to the original #4686 fix,
// a canceled/failed DATA_API subrequest was indistinguishable from "the flag
// isn't on," which let a silently-unreliable Postgres tier look shipped while
// actually degrading to empty on most requests (see the blocks-tier incident
// this was added for: METAGRAPH_BLOCKS_SOURCE was flipped, live re-testing
// found DATA_API subrequests reporting outcome "canceled" on a real fraction
// of requests, and there was no signal anywhere to catch it before a wider
// live-testing pass happened to notice). The same silent-degradation risk is
// why this also now reaches PostHog, not just Wrangler's own log tail.
let postgresTierFallbackGeneration = 0;

registerModuleStateReset("workers/data-api-tier.ts", () => {
  postgresTierFallbackGeneration = 0;
});

function markDataApiTierFallback(): null {
  postgresTierFallbackGeneration += 1;
  return null;
}

export function currentDataApiTierFallbackGeneration(): number {
  return postgresTierFallbackGeneration;
}

// PostHog $exception capture for a Postgres-tier degradation -- same
// no-throw, awaited-not-waitUntil'd contract as workers/data-api.ts's
// captureDataApiError (this module has no ExecutionContext threaded down
// from either of its callers, REST or MCP, to hand a background task to).
// tryDataApiTier is a shared chokepoint across every data source (blocks,
// health, neurons, ...), so `flagName` (e.g. "METAGRAPH_HEALTH_SOURCE") is
// the tag -- the one thing that distinguishes which tier actually degraded.
//
// THE ROUTE STAYS FLAG-SCOPED AND THE PATH GOES IN THE MESSAGE (#10665).
// PostHog fingerprints on `route`, so folding the path into it would split one
// issue into one-per-endpoint and multiply a fingerprint count that the free
// tier's $exception budget actually binds. But flag-scoped alone is what made
// #10665 unanswerable: sixteen days of captures that named the tier and never
// the request, so "which route is degrading" could not be read off the events
// at all -- and the issue's own title said 502 while every recent event said
// 503, because both group under the same flag. The path in the message is
// per-event, which is exactly where that distinction is legible.
async function captureDataApiTierFallback(
  err: unknown,
  flagName: keyof Env,
  env: Env,
): Promise<void> {
  await recordExceptionEvent(env, {
    error: err,
    route: `data-api-tier:${String(flagName)}`,
    errorCode: "upstream_unavailable",
  });
}

/**
 * The masked path a failure was serving, for the message above.
 *
 * Masked with the same function the analytics labels use, so an ss58 or a
 * block height cannot turn one recurring fault into thousands of distinct
 * messages. No parse guard: the Request constructor rejects a URL it cannot
 * parse, so by the time one exists here `request.url` is absolute and valid --
 * a try/catch would be a branch no test could ever reach.
 */
function maskedPath(request: Request): string {
  return maskRouteParams(new URL(request.url).pathname);
}

/**
 * How many times a 5xx is worth asking again.
 *
 * ONE RETRY (#10665). A 5xx here is overwhelmingly the service binding failing
 * to produce a response while the DATA_API Worker is mid-deploy -- the same
 * transient #10730 fixed one layer over for the Durable Object enqueue path,
 * and the reason those captures arrive in BURSTS separated by clean days
 * rather than at a steady rate. Degrading straight to the schema-stable empty
 * response turns that blip into a confidently wrong answer served to a caller,
 * which is strictly worse than the extra round trip.
 *
 * ONLY 5xx, deliberately. A 4xx is the request being wrong and will be exactly
 * as wrong the second time; retrying it would double the load on a path that
 * cannot recover. And the retry is capped at one because a DATA_API that is
 * genuinely down should degrade quickly rather than hold every request open --
 * the empty response is still the right destination, just not the first stop.
 */
export const DATA_API_TIER_RETRY_ATTEMPTS = 2;

/** The floor for "the upstream failed", as opposed to "we asked wrongly". */
const SERVER_ERROR_FLOOR = 500;

// Flags whose "d1" value FORWARDS to DATA_API. "d1" is a legacy token here,
// not a store: DATA_API's dispatcher for these three routes sits ahead of its
// Hyperdrive gate, so the rows come from Neon. Every other flag/value
// combination keeps the strict gate.
//
// A BLANKET "FORWARD ON d1" WOULD BE WRONG. METAGRAPH_HEALTH_SOURCE and
// METAGRAPH_SUBNET_SNAPSHOTS_SOURCE also hold "d1", and DATA_API does not
// serve the routes they gate -- widening this set would make those call sites
// forward, take a non-2xx, and fire captureDataApiTierFallback on every
// request. src/health-status-live.ts works through that for the health flag in
// full, including why it calls the service binding directly instead: DATA_API
// implements exactly one of that flag's routes, and a per-flag switch cannot
// do a per-route job.
/**
 * The flags whose "d1" value forwards to DATA_API -- as a TYPE as well as a
 * set (#10190). `flagName: keyof Env` let 222 call sites name flags that can
 * never forward, invisibly: the comparison happened inside this helper, so
 * `tsc` had no opinion. Narrowing the parameter to this union is what turns
 * the dead-site sweep from a grep into a compiler-enumerated list.
 */
export const FORWARDABLE_TIER_FLAGS = [
  "METAGRAPH_NEURONS_SOURCE",
  "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
] as const;
export type ForwardableTierFlag = (typeof FORWARDABLE_TIER_FLAGS)[number];

/**
 * A bounded cache epoch for the precomputed explorer directories.
 *
 * The route responses are already bounded by a 60-second public
 * cache profile, while their source snapshot advances roughly every 15
 * minutes. A wall-clock epoch keeps the edge key fresh within that same
 * contract without adding a KV read before every cache lookup. The handler's
 * first miss can therefore spend its one storage read on the route-specific
 * materialization rather than reading a pointer first.
 */
export async function readExplorerDirectoryCacheStamp(
  env: Env,
): Promise<string | null> {
  if (env.METAGRAPH_NEURONS_SOURCE !== "data-api") return null;
  return `minute:${Math.floor(Date.now() / 60_000)}`;
}

export async function tryDataApiTier(
  env: Env,
  request: Request,
  flagName: ForwardableTierFlag,
): Promise<Record<string, unknown> | null> {
  const value = env[flagName];
  // The membership half of this predicate is the TYPE now (#10190/#10223):
  // an unforwardable flag cannot be passed, so `FORWARDABLE_TIER_FLAGS.has`
  // was constant-true here. And `"postgres"` was never set by any config --
  // the compiler proved the comparison unreachable the moment the parameter
  // narrowed (Env types these flags' value "d1"). What remains runtime-
  // decidable is the VALUE: "data-api" forwards, anything else stays -- the
  // value stopped saying "d1" about a deleted database in the same change.
  if (value !== "data-api") return null;
  if (!env.DATA_API) return markDataApiTierFallback();
  const upstreamRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  const path = maskedPath(request);
  // Safe to re-issue: DATA_API is GET-only and this request has been
  // normalized to GET above, so there is no consumed body to replay.
  let upstream: Response | undefined;
  let transportError: unknown = null;
  for (let attempt = 0; attempt < DATA_API_TIER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      upstream = await env.DATA_API.fetch(upstreamRequest);
      transportError = null;
    } catch (err) {
      upstream = undefined;
      transportError = err;
    }
    // A transport failure and a 5xx are the same fault seen from two sides --
    // the binding could not reach a Worker that could answer -- so both get
    // the second ask, and anything else (2xx, or a 4xx we will not fix by
    // asking twice) leaves the loop on the first pass.
    const retryable =
      transportError !== null ||
      (upstream !== undefined && upstream.status >= SERVER_ERROR_FLOOR);
    if (!retryable) break;
  }
  if (upstream === undefined) {
    console.error(
      `tryDataApiTier(${flagName}): DATA_API fetch failed for ${path}, degrading to the schema-stable empty response:`,
      transportError,
    );
    await captureDataApiTierFallback(transportError, flagName, env);
    return markDataApiTierFallback();
  }
  if (!upstream.ok) {
    const err = new Error(
      `tryDataApiTier(${flagName}): DATA_API returned ${upstream.status} for ${path}`,
    );
    console.error(
      `tryDataApiTier(${flagName}): DATA_API returned ${upstream.status} for ${path}, degrading to the schema-stable empty response`,
    );
    await captureDataApiTierFallback(err, flagName, env);
    return markDataApiTierFallback();
  }
  let body;
  try {
    body = await upstream.json();
  } catch (err) {
    console.error(
      `tryDataApiTier(${flagName}): DATA_API response body unparseable, degrading to the schema-stable empty response:`,
      err,
    );
    await captureDataApiTierFallback(err, flagName, env);
    return markDataApiTierFallback();
  }
  if (!body || typeof body !== "object") {
    const err = new Error(
      `tryDataApiTier(${flagName}): DATA_API response was not a JSON object`,
    );
    console.error(
      `tryDataApiTier(${flagName}): DATA_API response was not a JSON object, degrading to the schema-stable empty response`,
    );
    await captureDataApiTierFallback(err, flagName, env);
    return markDataApiTierFallback();
  }
  return body as Record<string, unknown>;
}
