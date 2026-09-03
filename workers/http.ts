// Shared HTTP response primitives for the API Worker — header construction,
// weak ETags, and the canonical error envelope. Extracted from workers/api.ts
// (issue #510, de-monolith) as a leaf module: it imports only contract/config
// constants and nothing from api.ts, so every request-handler module can share
// these without an import cycle.
import { CACHE_SECONDS, CONTRACT_VERSION } from "../src/contract-constants.ts";
import { JSON_CONTENT_TYPE } from "./config.ts";

export type CacheProfile = "short" | "standard" | "static";

// Custom response headers a cross-origin browser script is allowed to read.
// The Fetch spec hides every non-safelisted header unless the server names it in
// Access-Control-Expose-Headers, so this canonical list is exposed on every
// CORS-open response. Keep in sync as new client-facing headers are added.
const X_METAGRAPH_STALE_CONTRACT_HEADER = "x-metagraph-stale-contract";
export const X_METAGRAPH_ARTIFACT_SOURCE_HEADER = "x-metagraph-artifact-source";
// #8287: which strategy resolved the R2 key (manifest | prefix | fallback).
// Distinct from the source header above (which tier served it) -- a read can be
// source=r2 and still be limping along on the pointer-miss fallback, and that
// difference is the whole health signal.
export const X_METAGRAPH_ARTIFACT_RESOLUTION_HEADER =
  "x-metagraph-artifact-resolution";

/**
 * Which side of an edge cache produced this response: `hit` | `miss`.
 *
 * The Worker's Cache API is INVISIBLE from outside. Cloudflare stamps
 * `cf-cache-status` on its own zone cache, but a `caches.default` hit served by
 * `withEdgeCache` / `withChainDetailEdgeCache` returns the stored response
 * verbatim, so a caller cannot tell a 120 ms cache hit from a 15 s lakehouse
 * read -- they differ only in a duration nobody records.
 *
 * That blindness is not hypothetical. `scripts/check-operation-latency.ts`
 * re-times an over-budget call to reject a one-off outlier, and its own first
 * draw fills the cache the retries then read: measured 2026-08-19,
 * `/api/v1/blocks/{ref}/extrinsics` drew [7290, 63, 43] ms and scored the
 * MEDIAN, 63 ms -- the CDN, not the read. Scored that way the gate reported
 * five exemptions as "now comfortably under budget, delete them", which would
 * have retired live 7-second reads on the evidence of its own cache.
 *
 * Named `hit`/`miss` after `x-metagraph-rpc-cache`, which answers exactly this
 * question for the RPC proxy and is the reason that one is not guessing.
 */
export const X_METAGRAPH_CACHE_HEADER = "x-metagraph-cache";

/**
 * In-memory hand-off from a chain-detail handler to its edge-cache wrapper.
 *
 * A `short` response is normally deliberately unsettled and must not be
 * stored. One exception is a settled chain record with a live market overlay:
 * the record is immutable, but the composed response may be reused only for
 * its short public freshness window. A symbol property carries that exception
 * without adding internal coordination metadata to the HTTP response.
 */
export const METAGRAPH_SETTLED_SHORT_CACHE = Symbol(
  "metagraph.settledShortCache",
);
export type SettledShortCacheResponse = Response & {
  [METAGRAPH_SETTLED_SHORT_CACHE]?: true;
};

/** Statuses the Response constructor forbids a body on (null body only). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Copy `response`, labelled with which side of the cache produced it.
 *
 * A COPY, because `Response.headers` from `cache.match()` is immutable and
 * `set` on it throws.
 *
 * Stamped on the way OUT, after the caller has stored its `response.clone()`,
 * because the label describes ONE DELIVERY and a cache entry outlives the
 * request that produced it. Every return path re-stamps today, so a label
 * baked into the stored copy would be overwritten rather than served -- this
 * is not load-bearing, it is keeping a header that means "how you got this"
 * out of a body that will be handed to someone who got it another way.
 */
export function withCacheStatus(
  response: Response,
  status: "hit" | "miss",
): Response {
  const headers = new Headers(response.headers);
  headers.set(X_METAGRAPH_CACHE_HEADER, status);
  return new Response(
    NULL_BODY_STATUSES.has(response.status) ? null : response.body,
    { status: response.status, statusText: response.statusText, headers },
  );
}

const EXPOSED_RESPONSE_HEADERS = [
  "etag", // conditional-request validator (If-None-Match → 304)
  "link", // RFC 8288 pagination links (next/prev/first/last) on list routes
  // rate-limit family: detect throttling, honour the back-off
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-policy",
  "x-ratelimit-reset", // when to retry (exact UTC midnight on daily; upper-bound on per-minute)
  "x-ratelimit-scope", // which ceiling rejected the caller: per-minute | daily-quota | blocked
  "x-ratelimit-tier", // which tier the caller was measured against
  "x-api-key-block-reason", // closed-set reason code on a 403 api_key_blocked
  // x-metagraph-* diagnostics
  "x-metagraph-contract-version",
  X_METAGRAPH_STALE_CONTRACT_HEADER,
  "x-metagraph-published-at",
  "x-metagraph-events",
  "x-metagraph-health",
  "x-metagraph-artifact-resolution",
  "x-metagraph-cache-profile",
  X_METAGRAPH_ARTIFACT_SOURCE_HEADER,
  "x-metagraph-storage-tier",
  "x-metagraph-error-code",
  // #9110: set when a response used the empty-fallback path after a data-tier
  // miss. Exposed so a browser client can tell a degraded zero from a
  // measured one -- the whole point of the header is that it reaches the
  // consumer, and an unexposed header does not.
  "x-metagraph-degraded",
  X_METAGRAPH_CACHE_HEADER,
  "x-metagraph-rpc-cache",
  "x-metagraph-rpc-endpoint-id",
  "x-metagraph-rpc-provider",
  "x-metagraph-rpc-attempts",
  // MCP resource-subscription session id (#4983 MCP half) -- minted on
  // initialize, must be readable by a browser-based MCP client to send back
  // on subsequent requests.
  "mcp-session-id",
  // Where the request's milliseconds went, per storage boundary. EXPOSED for
  // the same reason `x-metagraph-degraded` is: the UI is served from
  // metagraph.sh and calls api.metagraph.sh, so without this a browser cannot
  // read it at all -- and a timing header the page cannot see is a timing
  // header nobody uses. `Timing-Allow-Origin` governs the Performance API's
  // own view; this governs `fetch`'s.
  "server-timing",
];

// Pre-joined value, for builders that emit plain header objects (the MCP server).
export const EXPOSED_RESPONSE_HEADERS_VALUE =
  EXPOSED_RESPONSE_HEADERS.join(", ");

// Expose the canonical custom headers on a CORS-open response's Headers.
export function exposeCustomResponseHeaders(headers: Headers): void {
  headers.set("access-control-expose-headers", EXPOSED_RESPONSE_HEADERS_VALUE);
}

export function apiHeaders(cacheProfile: CacheProfile): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  exposeCustomResponseHeaders(headers);
  headers.set(
    "cache-control",
    `public, max-age=${CACHE_SECONDS[cacheProfile] || CACHE_SECONDS.standard}, stale-while-revalidate=300`,
  );
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-cache-profile", cacheProfile);
  headers.set("vary", "Accept, Accept-Encoding");
  return headers;
}

// Join link entries into an RFC 8288 header value: `<uri>; rel="…", …`.
export function linkHeader(links: Array<{ uri: string; rel: string }>): string {
  return links.map(({ uri, rel }) => `<${uri}>; rel="${rel}"`).join(", ");
}

/**
 * Does `pathname` name `base` itself, or something nested under it?
 *
 * A bare `pathname.startsWith(base)` has no path-segment boundary, so
 * `/api/v1/alerts/triggers` also matched `/api/v1/alerts/triggersanything` --
 * which reached the alert-trigger CRUD proxy and let a POST to a path that is
 * not a route create a real trigger row. It also makes any future sibling route
 * sharing the prefix unreachable by construction, since this test swallows it
 * first.
 *
 * `base` is given WITHOUT a trailing slash; both `/base` and `/base/...` match,
 * and `/basex` does not.
 */
export function isPathUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function errorResponse(
  code: string,
  message: string,
  status = 500,
  meta: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = apiHeaders("short");
  // Errors must never be cached by shared/edge caches: a transient 5xx (e.g. an
  // R2 timeout) or a not-yet-published 404 would otherwise be served stale for
  // up to max-age + stale-while-revalidate, turning a blip into a multi-minute
  // edge outage. Mirror dataResponse / og-image error / webhook responses.
  headers.set("cache-control", "no-store");
  headers.set("x-metagraph-cache-profile", "no-store");
  headers.set("x-metagraph-error-code", code);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(
    JSON.stringify({
      ok: false,
      schema_version: 1,
      data: null,
      error: { code, message },
      meta: {
        contract_version: CONTRACT_VERSION,
        ...meta,
      },
    }),
    {
      status,
      headers,
    },
  );
}

export async function weakEtag(body: string): Promise<string> {
  const encoded = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${hash.slice(0, 32)}"`;
}

// Strip the optional weak prefix so tags compare by opaque value alone:
// If-None-Match uses weak comparison, so W/"x" and "x" are equivalent.
function opaqueTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

// True when an If-None-Match precondition matches the current `etag` (caller
// answers 304). Handles `*`, a comma-separated tag list, and weak validators.
//
// `etag` is nullable because `Headers.get()` is: a cached response without an
// ETag has nothing to match, which the body below already answered correctly
// (`!etag` -> false). Only the signature disagreed, and it type-checked at the
// call sites solely because they reached the response through a cast.
export function ifNoneMatchSatisfied(
  request: Request,
  etag: string | null,
): boolean {
  const header = request.headers.get("if-none-match");
  if (!header || !etag) return false;
  const current = opaqueTag(etag);
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || opaqueTag(candidate) === current);
}

/**
 * Read a request body up to `maxBytes`, refusing larger ones.
 *
 * Moved here from workers/api.ts when the A2A endpoint needed the same
 * bounded read (#11175): the alternative was a copy, and a body bound that
 * exists twice is a body bound that disagrees with itself eventually.
 */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    return { ok: false, text: "" };
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, text: "" };
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text };
}
