// Response envelope builders for the API Worker — the canonical success/data
// envelopes, the contract-version resolver, and the published-at lookup.
// Extracted from workers/api.mjs (issue #510, de-monolith). Depends only on the
// http + storage leaf modules and the contract version; it calls nothing back
// into api.mjs, so there is no import cycle.
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import { apiHeaders, weakEtag } from "./http.mjs";
import { latestPointer } from "./storage.mjs";

export function contractVersion(env) {
  return env.METAGRAPH_CONTRACT_VERSION || CONTRACT_VERSION;
}

// Published-at is read from the latest-pointer KV (warmed on publish), so this
// only touches KV on origin misses. Returns null when KV is unbound or the
// pointer predates published_at support.
export async function publishedAt(env) {
  const pointer = await latestPointer(env);
  return pointer?.published_at || null;
}

// Success envelope for non-cacheable (mutation / dynamic) JSON responses.
export function dataResponse(env, data, status = 200, extraMeta = {}) {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  return new Response(
    JSON.stringify({
      ok: true,
      schema_version: 1,
      data,
      error: null,
      meta: { contract_version: contractVersion(env), ...extraMeta },
    }),
    { status, headers },
  );
}

// Cacheable success envelope with a weak ETag + 304 short-circuit; HEAD returns
// headers only. cacheProfile selects the cache-control max-age via apiHeaders.
export async function envelopeResponse(request, payload, cacheProfile) {
  const body = JSON.stringify({
    ok: true,
    schema_version: 1,
    data: payload.data,
    meta: payload.meta,
  });
  const headers = apiHeaders(cacheProfile);
  const etag = await weakEtag(body);
  headers.set("etag", etag);
  headers.set(
    "x-metagraph-contract-version",
    payload.meta.contract_version || CONTRACT_VERSION,
  );
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
