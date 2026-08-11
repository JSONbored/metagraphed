import { recordExceptionEvent } from "../src/usage-telemetry.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";

// DATA_API-forwarding serving gate, one env flag per data source (originally
// ADR 0013 Sequencing step 3's gated D1 -> Postgres cutover; D1 fully
// eliminated 2026-07-17 -- reconfirmed 2026-08-11, zero `d1_databases` blocks
// in any wrangler config and no D1 binding on any deployed Worker).
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

registerModuleStateReset("workers/postgres-tier.ts", () => {
  postgresTierFallbackGeneration = 0;
});

function markPostgresTierFallback(): null {
  postgresTierFallbackGeneration += 1;
  return null;
}

export function currentPostgresTierFallbackGeneration(): number {
  return postgresTierFallbackGeneration;
}

// PostHog $exception capture for a Postgres-tier degradation -- same
// no-throw, awaited-not-waitUntil'd contract as workers/data-api.ts's
// captureDataApiError (this module has no ExecutionContext threaded down
// from either of its callers, REST or MCP, to hand a background task to).
// tryPostgresTier is a shared chokepoint across every data source (blocks,
// health, neurons, ...), so `flagName` (e.g. "METAGRAPH_HEALTH_SOURCE") is
// the tag -- the one thing that distinguishes which tier actually degraded.
async function capturePostgresTierFallback(
  err: unknown,
  flagName: keyof Env,
  env: Env,
): Promise<void> {
  await recordExceptionEvent(env, {
    error: err,
    route: `postgres-tier:${String(flagName)}`,
    errorCode: "upstream_unavailable",
  });
}

// Flags whose "d1" value FORWARDS to DATA_API. "d1" is a legacy token here,
// not a store: DATA_API's dispatcher for these three routes sits ahead of its
// Hyperdrive gate, so the rows come from Neon. Every other flag/value
// combination keeps the strict gate.
//
// A BLANKET "FORWARD ON d1" WOULD BE WRONG. METAGRAPH_HEALTH_SOURCE and
// METAGRAPH_SUBNET_SNAPSHOTS_SOURCE also hold "d1", and DATA_API does not
// serve the routes they gate -- widening this set would make those call sites
// forward, take a non-2xx, and fire capturePostgresTierFallback on every
// request. src/health-status-live.ts works through that for the health flag in
// full, including why it calls the service binding directly instead: DATA_API
// implements exactly one of that flag's routes, and a per-flag switch cannot
// do a per-route job.
const DATA_API_FORWARD_FLAGS = new Set<string>([
  "METAGRAPH_NEURONS_SOURCE",
  // tests/fixtures/sqlite-schema/0009: the hyperparams + account-identity
  // dispatchers also live in DATA_API ahead of its Hyperdrive gate
  // (matchHyperparamsIdentityD1Route -- still D1-named, tracked by #10223).
  // Their cold-tier fallback depends on this forward too: DATA_API answers 503
  // while its table is still empty, which is what sends the serving handler on
  // to the lakehouse cold-tier reader.
  "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
  "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
]);

export async function tryPostgresTier(
  env: Env,
  request: Request,
  flagName: keyof Env,
): Promise<Record<string, unknown> | null> {
  const value = env[flagName];
  const forwards =
    value === "postgres" ||
    (value === "d1" && DATA_API_FORWARD_FLAGS.has(flagName as string));
  if (!forwards) return null;
  if (!env.DATA_API) return markPostgresTierFallback();
  const upstreamRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  let upstream;
  try {
    upstream = await env.DATA_API.fetch(upstreamRequest);
  } catch (err) {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API fetch failed, degrading to the schema-stable empty response:`,
      err,
    );
    await capturePostgresTierFallback(err, flagName, env);
    return markPostgresTierFallback();
  }
  if (!upstream.ok) {
    const err = new Error(
      `tryPostgresTier(${flagName}): DATA_API returned ${upstream.status}`,
    );
    console.error(
      `tryPostgresTier(${flagName}): DATA_API returned ${upstream.status}, degrading to the schema-stable empty response`,
    );
    await capturePostgresTierFallback(err, flagName, env);
    return markPostgresTierFallback();
  }
  let body;
  try {
    body = await upstream.json();
  } catch (err) {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API response body unparseable, degrading to the schema-stable empty response:`,
      err,
    );
    await capturePostgresTierFallback(err, flagName, env);
    return markPostgresTierFallback();
  }
  if (!body || typeof body !== "object") {
    const err = new Error(
      `tryPostgresTier(${flagName}): DATA_API response was not a JSON object`,
    );
    console.error(
      `tryPostgresTier(${flagName}): DATA_API response was not a JSON object, degrading to the schema-stable empty response`,
    );
    await capturePostgresTierFallback(err, flagName, env);
    return markPostgresTierFallback();
  }
  return body as Record<string, unknown>;
}
