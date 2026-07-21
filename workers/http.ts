// Shared HTTP response primitives for the API Worker — header construction,
// weak ETags, and the canonical error envelope. Extracted from workers/api.mjs
// (issue #510, de-monolith) as a leaf module: it imports only contract/config
// constants and nothing from api.mjs, so every request-handler module can share
// these without an import cycle.
import { CACHE_SECONDS, CONTRACT_VERSION } from "../src/contracts.mjs";
import { JSON_CONTENT_TYPE } from "./config.ts";

export type CacheProfile = "short" | "standard" | "static";

// Custom response headers a cross-origin browser script is allowed to read.
// The Fetch spec hides every non-safelisted header unless the server names it in
// Access-Control-Expose-Headers, so this canonical list is exposed on every
// CORS-open response. Keep in sync as new client-facing headers are added.
const X_METAGRAPH_STALE_CONTRACT_HEADER = "x-metagraph-stale-contract";
export const X_METAGRAPH_ARTIFACT_SOURCE_HEADER = "x-metagraph-artifact-source";

const EXPOSED_RESPONSE_HEADERS = [
  "etag", // conditional-request validator (If-None-Match → 304)
  "link", // RFC 8288 pagination links (next/prev/first/last) on list routes
  // rate-limit family: detect throttling, honour the back-off
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-policy",
  // x-metagraph-* diagnostics
  "x-metagraph-contract-version",
  X_METAGRAPH_STALE_CONTRACT_HEADER,
  "x-metagraph-published-at",
  "x-metagraph-events",
  "x-metagraph-health",
  "x-metagraph-cache-profile",
  X_METAGRAPH_ARTIFACT_SOURCE_HEADER,
  "x-metagraph-storage-tier",
  "x-metagraph-error-code",
  "x-metagraph-rpc-cache",
  "x-metagraph-rpc-endpoint-id",
  "x-metagraph-rpc-provider",
  "x-metagraph-rpc-attempts",
  // MCP resource-subscription session id (#4983 MCP half) -- minted on
  // initialize, must be readable by a browser-based MCP client to send back
  // on subsequent requests.
  "mcp-session-id",
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
export function ifNoneMatchSatisfied(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header || !etag) return false;
  const current = opaqueTag(etag);
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || opaqueTag(candidate) === current);
}
