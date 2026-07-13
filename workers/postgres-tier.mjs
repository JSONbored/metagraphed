// Gated D1 -> Postgres serving cutover (ADR 0013 Sequencing step 3, the
// deploy/README.md "Serving cutover" runbook: "if FLAG[tier] == postgres: try
// Postgres; on error -> D1"). Each tier has its own env flag so a rollback is a
// single-flag flip, never a code change or redeploy of the fallback path.
// `request` is forwarded to the DATA_API service binding after normalizing HEAD
// probes to GET: DATA_API is GET-only, while the public API computes HEAD
// metadata from the GET representation and strips the body later. The caller has
// already run the SAME validation the D1 path runs (or, for an MCP tool caller,
// has already validated via its own inputSchema), so this trusts well-formed
// params and treats ANY failure (binding absent, network error, non-2xx,
// unparseable/malformed body) as "fall back to D1", never as a client-facing
// error. Postgres never gets to independently fail a request the D1 path would
// have served.
//
// Extracted from workers/request-handlers/entities.mjs (#4668/#4686) into this
// neutral module so src/mcp-server.mjs (#4694) can share the identical
// contract without importing a route-handler file or duplicating the fallback
// logic -- REST's handleBlocks/handleExtrinsics and MCP's list_extrinsics/
// get_extrinsic all call this same function.
//
// Every branch below logs before falling back (#4686) -- prior to this, a
// canceled/failed DATA_API subrequest was indistinguishable from "the flag
// isn't on," which let a silently-unreliable Postgres tier look shipped
// while actually falling back to D1 on most requests (see the blocks-tier
// incident this was added for: METAGRAPH_BLOCKS_SOURCE was flipped, live
// re-testing found DATA_API subrequests reporting outcome "canceled" on a
// real fraction of requests, and there was no signal anywhere to catch it
// before a wider live-testing pass happened to notice).
export async function tryPostgresTier(env, request, flagName) {
  if (env[flagName] !== "postgres" || !env.DATA_API) return null;
  const upstreamRequest =
    request.method === "HEAD"
      ? new Request(request, { method: "GET" })
      : request;
  let upstream;
  try {
    upstream = await env.DATA_API.fetch(upstreamRequest);
  } catch (err) {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API fetch failed, falling back to D1:`,
      err,
    );
    return null;
  }
  if (!upstream.ok) {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API returned ${upstream.status}, falling back to D1`,
    );
    return null;
  }
  let body;
  try {
    body = await upstream.json();
  } catch (err) {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API response body unparseable, falling back to D1:`,
      err,
    );
    return null;
  }
  if (!body || typeof body !== "object") {
    console.error(
      `tryPostgresTier(${flagName}): DATA_API response was not a JSON object, falling back to D1`,
    );
    return null;
  }
  return body;
}
