// Shared HTTP response primitives for the API Worker — header construction,
// weak ETags, and the canonical error envelope. Extracted from workers/api.mjs
// (issue #510, de-monolith) as a leaf module: it imports only contract/config
// constants and nothing from api.mjs, so every request-handler module can share
// these without an import cycle.
import { CACHE_SECONDS, CONTRACT_VERSION } from "../src/contracts.mjs";
import { JSON_CONTENT_TYPE } from "./config.mjs";

export function apiHeaders(cacheProfile) {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "cache-control",
    `public, max-age=${CACHE_SECONDS[cacheProfile] || CACHE_SECONDS.standard}, stale-while-revalidate=300`,
  );
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-cache-profile", cacheProfile);
  headers.set("vary", "Accept-Encoding");
  return headers;
}

export function errorResponse(
  code,
  message,
  status = 500,
  meta = {},
  extraHeaders = {},
) {
  const headers = apiHeaders("short");
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

export async function weakEtag(body) {
  const encoded = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${hash.slice(0, 32)}"`;
}
