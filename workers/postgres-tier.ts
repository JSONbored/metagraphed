import { recordExceptionEvent } from "../src/usage-telemetry.ts";

// Postgres-tier serving gate, one env flag per data source (originally ADR
// 0013 Sequencing step 3's gated D1 -> Postgres cutover; D1 fully eliminated
// 2026-07-17 -- reconfirmed live 2026-07-25, zero D1 databases remain on the
// account -- every flag has been hardcoded "postgres" in every wrangler
// config since, see wrangler.jsonc's own METAGRAPH_*_SOURCE vars). Each tier
// keeps its own flag as a kill switch: a failure here degrades to a
// schema-stable EMPTY response (never a live D1 read -- there's nothing left
// to fall back to), so a maintainer can force that same degraded-but-never-
// erroring state with a single flag flip if a specific Postgres tier needs
// to be taken offline, with no code change or redeploy.
// `request` is forwarded to the DATA_API service binding after normalizing HEAD
// probes to GET: DATA_API is GET-only, while the public API computes HEAD
// metadata from the GET representation and strips the body later. The caller
// has already run its own validation (or, for an MCP tool caller, already
// validated via its own inputSchema), so this trusts well-formed params and
// treats ANY failure (binding absent, network error, non-2xx, unparseable/
// malformed body) as "degrade to the empty response," never as a
// client-facing error.
//
// Extracted from workers/request-handlers/entities.mjs (#4668/#4686) into this
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

export async function tryPostgresTier(
  env: Env,
  request: Request,
  flagName: keyof Env,
): Promise<Record<string, unknown> | null> {
  if (env[flagName] !== "postgres") return null;
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
