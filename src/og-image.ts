// Open Graph card for the api.metagraph.sh landing page (GET /og.png, alias
// /og), with registry counts from the artifact publication. A shared preview
// is not evidence that those counts are current when a crawler reuses it.
//
// The render itself (satori + resvg, via workers-og's dependencies) does NOT
// happen here or in any live Worker request path — see #6502. workers-og's
// wasm (satori + resvg-wasm, ~545 KiB gzipped) was originally dynamic-imported
// inside this route's handler, but Cloudflare's bundler ships every reachable
// import (static or dynamic) in the one deployed script, so it was still
// costing this Worker's own bundle budget on every deploy, and eventually
// left no headroom for @sentry/cloudflare. Since the underlying stats only
// change once per data publish anyway (this route was re-rendering an
// unchanged image on every cache miss), the render moved to publish time:
// scripts/refresh-og-image.ts runs in plain Node, using the SAME renderMarkup
// below plus satori + satori-html + @resvg/resvg-js (Node-native bindings,
// not wasm-import — workers-og itself can't load outside workerd, see that
// script's own header), and stores the PNG in R2 like every other artifact.
//
// handleOgImage below is now just a binary R2 read + the existing edge cache;
// on any miss/error (cold R2, timeout) it falls back to the branded full-size
// static card on a short cache, so an unfurl always shows something on brand
// and a transient failure isn't pinned for the hour. readR2Object/cache/assets
// are injectable for unit tests.
import type { R2ObjectReadResult } from "../workers/storage.ts";

import {
  CARD_VERSION,
  CARD_WIDTH,
  CARD_HEIGHT,
  renderCardLayout,
} from "./og-card-style.ts";
export { CARD_VERSION } from "./og-card-style.ts";
import { OG_IMAGE_ARTIFACT_PATH } from "./og-card-version.ts";

const OG_PATHS = new Set(["/og.png", "/og"]);
// Stats refresh on the data publish; an hour of edge cache + a long
// stale-while-revalidate avoids repeated artifact reads; versioning isolates art.
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
// Render failures are transient, so the fallback gets a short cache (not the
// long success window, no stale-while-revalidate) and is never pinned for long.
const FALLBACK_CACHE_CONTROL = "public, max-age=60";
// Branded 1200x630 card under public/ (ASSETS binding), shown when a render
// fails. Regenerate with scripts/render-api-og-preview.ts --write-fallback.
const FALLBACK_ASSET_PATH = "/brand/og-fallback.png";
const MAX_FALLBACK_BYTES = 1024 * 1024;
// The R2 artifact scripts/refresh-og-image.ts publishes the rendered card to,
// read tier-aware (latest-prefix + timeout guard) via readR2Object -- same
// convention as every other /metagraph/* artifact.
const TAGLINE = "The Bittensor subnet integration registry";

export function imageHeaders(
  extra?: HeadersInit,
  cacheControl: string = CACHE_CONTROL,
): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", cacheControl);
  headers.set("content-type", "image/png");
  return headers;
}

// Serve the branded card from ASSETS (a separate subsystem, so it survives
// workers-og/font/satori failures) at 200 with a short cache; the caller never
// edge-caches it. If the asset is gone too, 503 no-store so crawlers fall back
// to the page meta tags instead of caching a blank.
/** The minimum this needs: something that can fetch a Request. Declared
 * structurally rather than as `Fetcher` because the ASSETS binding is surfaced
 * with different widths by `Env` and by `ArtifactEnv`, and demanding the wider
 * one here would force a cast at one of the two call sites. */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

// ASSETS serves bytes by filename; even a 200 response is not a PNG guarantee.
// Like icon-proxy's bounded read, enforce the real stream limit independently
// of Content-Length. Only the small owned fallback uses this buffered path.
async function readFallbackPng(asset: Response): Promise<ArrayBuffer | null> {
  if (
    !asset.ok ||
    (asset.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== "image/png" ||
    Number(asset.headers.get("content-length")) > MAX_FALLBACK_BYTES
  ) {
    await asset.body?.cancel();
    return null;
  }
  const reader = asset.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FALLBACK_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return null;
  const view = new DataView(bytes.buffer);
  if (
    view.getUint32(8) !== 13 || // IHDR length
    view.getUint32(12) !== 0x49484452 || // IHDR type
    view.getUint32(16) !== CARD_WIDTH ||
    view.getUint32(20) !== CARD_HEIGHT
  )
    return null;
  return bytes.buffer;
}

export async function fallbackResponse(
  assets: AssetFetcher | null,
  url: URL,
): Promise<Response> {
  if (assets?.fetch) {
    try {
      const asset = await assets.fetch(
        new Request(new URL(FALLBACK_ASSET_PATH, url).toString()),
      );
      const png = await readFallbackPng(asset);
      if (png) {
        return new Response(png, {
          headers: imageHeaders(undefined, FALLBACK_CACHE_CONTROL),
        });
      }
    } catch (error) {
      console.error("og: fallback asset unavailable", error);
    }
  }
  return new Response("og image temporarily unavailable\n", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function formatCount(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-US")
    : null;
}

// Pull the live counts off registry-summary.json's data into an array of stat
// strings, or null when there are no formattable counts (the card then omits
// the facts row). Pure -- scripts/refresh-og-image.ts is the only
// caller now (it reads registry-summary.json off disk at publish time); the
// live route no longer computes stats at all, it just serves the pre-rendered
// card.
export function buildStatParts(
  data: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!data) return null;
  const parts: string[] = [];
  const subnets = formatCount(data.subnet_count);
  if (subnets) parts.push(`${subnets} subnets`);
  const counts = data.counts as Record<string, unknown> | undefined;
  const endpoints = formatCount(counts?.endpoints);
  if (endpoints) parts.push(`${endpoints} endpoints`);
  const providers = formatCount(counts?.providers);
  if (providers) parts.push(`${providers} providers`);
  const coverage = (data.coverage as Record<string, unknown> | undefined)
    ?.average_score;
  if (
    typeof coverage === "number" &&
    Number.isInteger(coverage) &&
    coverage >= 0 &&
    coverage <= 100
  ) {
    parts.push(`${coverage}% coverage`);
  }
  return parts.length ? parts : null;
}

// Counts describe the artifact publication; no health verdict is inferred.
export function renderMarkup(statParts: string[] | null | undefined): string {
  return renderCardLayout({
    title: "Metagraphed API",
    subtitle: TAGLINE,
    stats: (statParts ?? []).slice(0, 4).map((part) => {
      const separator = part.indexOf(" ");
      return separator === -1
        ? { label: "Registry", value: part }
        : { label: part.slice(separator + 1), value: part.slice(0, separator) };
    }),
  });
}

interface OgImageDeps {
  readR2Object?: (
    env: Env,
    path: string,
    tier: string,
  ) => Promise<R2ObjectReadResult>;
  cache?: Cache | null;
  assets?: Fetcher | null;
}

// Returns a Response for the OG route, or null when the path doesn't match (so
// the caller can fall through). deps: { readR2Object, cache, assets } —
// readR2Object defaults to none (a missing/non-function dep degrades to the
// fallback, same as a cold R2 read); cache to the edge cache; assets to
// env.ASSETS (the binding that serves the branded fallback card on a miss).
export async function handleOgImage(
  request: Request,
  env: Env,
  url: URL,
  deps: OgImageDeps = {},
): Promise<Response | null> {
  if (!OG_PATHS.has(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  // Cache on a canonical /og.png key so /og and /og.png share one cached render.
  const cache =
    deps.cache !== undefined
      ? deps.cache
      : ((globalThis as { caches?: CacheStorage }).caches?.default ?? null);
  const assets =
    deps.assets !== undefined ? deps.assets : (env?.ASSETS ?? null);
  const cacheKey = new Request(
    new URL(`/og.png?v=${CARD_VERSION}`, url).toString(),
    { method: "GET" },
  );
  let cached: Response | undefined;
  try {
    cached = await cache?.match(cacheKey);
  } catch (error) {
    console.error("og: cache read failed", error);
  }
  if (cached) {
    return request.method === "HEAD" ? new Response(null, cached) : cached;
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers: imageHeaders() });
  }

  const readR2Object = deps.readR2Object;
  let result: R2ObjectReadResult | { ok: false };
  try {
    result =
      typeof readR2Object === "function"
        ? await readR2Object(env, OG_IMAGE_ARTIFACT_PATH, "r2")
        : { ok: false };
  } catch (error) {
    console.error("og: r2 read failed", error);
    result = { ok: false };
  }
  if (!result?.ok) {
    return fallbackResponse(assets, url);
  }

  const response = new Response(result.object.body, {
    headers: imageHeaders(),
  });
  try {
    await cache?.put(cacheKey, response.clone());
  } catch (error) {
    console.error("og: cache write failed", error);
  }
  return response;
}
