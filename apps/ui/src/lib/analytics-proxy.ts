// Product analytics (PostHog) first-party proxy (metagraphed#7760).
//
// Same rationale and first-party-proxy shape as the existing Umami proxy in
// src/server.ts -- see its own header comment. This one specifically follows
// PostHog's own documented Cloudflare Workers proxy guide
// (posthog.com/docs/advanced/proxy/cloudflare) rather than being invented
// from scratch: /static/* and /array/* route to PostHog's asset host (the JS
// SDK bundle + per-project remote config, both edge-cacheable and never
// per-visitor), everything else under the prefix routes to the main
// capture/decide/flags/replay host. `PostHogAssetContext`'s `waitUntil`
// mirrors that guide's own `ctx.waitUntil(caches.default.put(...))`
// asset-caching call exactly.
//
// The path prefix deliberately avoids "analytics"/"tracking"/"posthog"/"ph"
// (PostHog's own guide: ad blockers pattern-match those in URLs even on a
// first-party origin) -- "ingest" was chosen for the same reason the
// existing Umami prefix is the unrelated-sounding "/stats".
//
// A standalone module (like lib/og-image.ts), not inline in server.ts, so it
// can be unit-tested directly -- server.ts itself has no test harness (it
// pulls in TanStack Start's real server entry), matching this codebase's
// existing convention of extracting server.ts's proxy/render logic into
// lib/ modules.
export const ANALYTICS_PREFIX = "/ingest";
const POSTHOG_API_HOST = "us.i.posthog.com";
const POSTHOG_ASSET_HOST = "us-assets.i.posthog.com";

export type PostHogAssetContext = { waitUntil(promise: Promise<unknown>): void };

// Cloudflare Workers runtime global (the Cache API) -- same class of ambient
// declaration as server.ts's own HTMLRewriter one; absent under local
// `vite dev` (Node) and in this module's own unit tests, which is why
// retrieveAnalyticsAsset below falls back to a plain uncached fetch when it's
// undefined.
declare const caches:
  | {
      default: {
        match(request: Request): Promise<Response | undefined>;
        put(request: Request, response: Response): Promise<void>;
      };
    }
  | undefined;

export async function retrieveAnalyticsAsset(
  request: Request,
  pathWithParams: string,
  ctx: PostHogAssetContext,
): Promise<Response> {
  const hasEdgeCache = typeof caches !== "undefined";
  const cached = hasEdgeCache ? await caches.default.match(request) : undefined;
  if (cached) return cached;
  const upstream = await fetch(`https://${POSTHOG_ASSET_HOST}${pathWithParams}`);
  if (hasEdgeCache) ctx.waitUntil(caches.default.put(request, upstream.clone()));
  return upstream;
}

export async function forwardToAnalyticsHost(
  request: Request,
  pathWithParams: string,
): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const originHeaders = new Headers(request.headers);
  originHeaders.delete("cookie");
  originHeaders.set("x-forwarded-for", ip);

  const originRequest = new Request(`https://${POSTHOG_API_HOST}${pathWithParams}`, {
    method: request.method,
    headers: originHeaders,
    // Buffered, not streamed straight through: PostHog's own proxy guide
    // flags streaming request.body directly as a real, observed cause of
    // corrupted event payloads on POST.
    body:
      request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : null,
    redirect: request.redirect,
  });
  const upstream = await fetch(originRequest);
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Proxy every PostHog request through this origin. Returns null for
// everything else (the caller falls through to the SSR app).
export async function handleAnalyticsProxy(
  request: Request,
  ctx: PostHogAssetContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${ANALYTICS_PREFIX}/`)) return null;
  const pathWithParams = url.pathname.slice(ANALYTICS_PREFIX.length) + url.search;
  const isAsset =
    url.pathname.startsWith(`${ANALYTICS_PREFIX}/static/`) ||
    url.pathname.startsWith(`${ANALYTICS_PREFIX}/array/`);
  return isAsset
    ? retrieveAnalyticsAsset(request, pathWithParams, ctx)
    : forwardToAnalyticsHost(request, pathWithParams);
}
