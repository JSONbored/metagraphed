// Response envelope builders for the API Worker — the canonical success/data
// envelopes, the contract-version resolver, and the published-at lookup.
// Extracted from workers/api.mjs (issue #510, de-monolith). Depends only on the
// http + storage leaf modules and the contract version; it calls nothing back
// into api.mjs, so there is no import cycle.
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import { apiHeaders, ifNoneMatchSatisfied, weakEtag } from "./http.ts";
import type { CacheProfile } from "./http.ts";
import { latestPointer } from "./storage.mjs";

export function contractVersion(env: Env): string {
  return env.METAGRAPH_CONTRACT_VERSION || CONTRACT_VERSION;
}

// Contract versions are "YYYY-MM-DD.N": the ISO date sorts lexicographically,
// the revision N numerically. Returns <0 if a precedes b, 0 if equal, >0 after.
function compareContractVersions(a: string, b: string): number {
  const parse = (value: string): [string, number] => {
    const [date = "", rev = "0"] = String(value).split(".");
    return [date, Number.parseInt(rev, 10) || 0];
  };
  const [dateA, revA] = parse(a);
  const [dateB, revB] = parse(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return revA - revB;
}

// A served artifact built under an OLDER contract than the live one may predate
// a schema change — the silent serve-time drift #1001 makes observable. Returns
// { built_under, live } when the artifact lags the live contract, else null.
export function contractStaleness(
  env: Env,
  builtUnderVersion: string | null | undefined,
): { built_under: string; live: string } | null {
  if (!builtUnderVersion) return null;
  const live = contractVersion(env);
  return compareContractVersions(builtUnderVersion, live) < 0
    ? { built_under: String(builtUnderVersion), live }
    : null;
}

// Published-at is read from the latest-pointer KV (warmed on publish), so this
// only touches KV on origin misses. Returns null when KV is unbound or the
// pointer predates published_at support.
export async function publishedAt(env: Env): Promise<string | null> {
  const pointer = await latestPointer(env);
  return pointer?.published_at || null;
}

// Success envelope for non-cacheable (mutation / dynamic) JSON responses.
export function dataResponse(
  env: Env,
  data: unknown,
  status = 200,
  extraMeta: Record<string, unknown> = {},
): Response {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  return new Response(
    JSON.stringify({
      ok: true,
      schema_version: 1,
      data,
      // No `error` key on success: the SuccessEnvelope schema is
      // additionalProperties:false, and envelopeResponse omits it too — keep the
      // two success builders structurally identical (the error envelope is a
      // separate shape produced by errorResponse).
      meta: { contract_version: contractVersion(env), ...extraMeta },
    }),
    { status, headers },
  );
}

interface EnvelopePayload {
  data: unknown;
  meta: Record<string, unknown> & {
    contract_version?: string;
    stale_contract?: { built_under: string };
  };
}

// Cacheable success envelope with a weak ETag + 304 short-circuit; HEAD returns
// headers only. cacheProfile selects the cache-control max-age via apiHeaders.
export async function envelopeResponse(
  request: Request,
  payload: EnvelopePayload,
  cacheProfile: CacheProfile,
  extraHeaders: Record<string, string | null | undefined> = {},
): Promise<Response> {
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
  // Serve-time drift signal (#1001): mirror meta.stale_contract on a header so
  // monitoring/CDN can alarm on a served artifact that lags the live contract.
  if (payload.meta.stale_contract?.built_under) {
    headers.set(
      "x-metagraph-stale-contract",
      payload.meta.stale_contract.built_under,
    );
  }
  // Caller-supplied headers (e.g. the pagination Link header), set before the
  // 304/HEAD short-circuit so every response carries them; null values skip.
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value != null) {
      headers.set(key, value);
    }
  }
  if (ifNoneMatchSatisfied(request, etag)) {
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
