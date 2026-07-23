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

// Same defensive purpose as server.ts's own MAX_STATS_BODY_BYTES for the
// sibling Umami proxy (this route is public/unauthenticated -- reachable by
// anyone, not just posthog-js -- so it must never buffer an unbounded body
// into Worker memory). Sized above that 16 KiB, not equal to it: PostHog's
// own capture endpoint accepts BATCHED events (posthog-js can queue and flush
// several pageview/custom events in one POST), unlike Umami's one-event-per-
// request format, so a real single request legitimately runs larger. This is
// our own defensive ceiling, not a PostHog-documented limit -- generous
// enough for realistic batched web-analytics traffic (autocapture stays OFF
// per metagraphed#7760's own requirement, so volume per batch stays small)
// while still bounding worst-case memory per request to a small, fixed cap.
const MAX_INGEST_BODY_BYTES = 64 * 1024;

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
  // Same best-effort posture as the put() below -- a read failure must fall
  // through to a normal upstream fetch, never take the whole request down.
  let cached: Response | undefined;
  if (hasEdgeCache) {
    try {
      cached = await caches.default.match(request);
    } catch (err) {
      console.error("[analytics-proxy] edge-cache match failed:", err);
    }
  }
  if (cached) return cached;
  const upstream = await fetch(`https://${POSTHOG_ASSET_HOST}${pathWithParams}`);
  // A rejected promise passed to ctx.waitUntil() becomes an unhandled
  // rejection at the Worker's global scope -- Nitro/h3's own safety net
  // (src/lib/error-capture.ts's "error"/"unhandledrejection" listeners)
  // then turns that into a generic 500 for the CURRENT request, even though
  // the response below was already computed correctly (confirmed live:
  // every /ingest/static/* and /ingest/array/* request 500'd this way in
  // production, while /ingest/e/ -- forwardToAnalyticsHost, which never
  // touches ctx.waitUntil -- kept working). The edge cache is a best-effort
  // optimization; a write failure (a malformed Vary header from upstream, a
  // transient Cache API error, anything) must never take down the response
  // that's already correct and already on its way to the browser.
  if (hasEdgeCache) {
    ctx.waitUntil(
      caches.default.put(request, upstream.clone()).catch((err) => {
        console.error("[analytics-proxy] edge-cache put failed:", err);
      }),
    );
  }
  return upstream;
}

export async function forwardToAnalyticsHost(
  request: Request,
  pathWithParams: string,
): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // Same content-length-first gate as server.ts's Umami collect endpoint --
  // reject BEFORE buffering, never after, so an oversized/malformed request
  // never gets read into memory at all. See MAX_INGEST_BODY_BYTES above for
  // why the cap differs from Umami's own.
  if (hasBody) {
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return new Response("Length Required", { status: 411 });
    }
    if (contentLength > MAX_INGEST_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
  }

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
    body: hasBody ? await request.arrayBuffer() : null,
    redirect: request.redirect,
  });
  const upstream = await fetch(originRequest);
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Proxy every PostHog request through this origin. Returns null for
// everything else (the caller falls through to the SSR app).
//
// No allow-list on the forwarded path/method beyond the ANALYTICS_PREFIX
// match below -- anything not `/static/*` or `/array/*` forwards verbatim to
// POSTHOG_API_HOST. Deliberate, not an oversight: PostHog's own Cloudflare
// proxy guide proxies its ENTIRE capture/decide/flags surface this way (it
// doesn't publish a fixed path list, and posthog-js itself decides which
// sub-paths it calls per SDK version/feature), so a narrower allow-list here
// would silently break future posthog-js features without any code change on
// our side to explain why. forwardToAnalyticsHost's own content-length gate
// above is the actual abuse control (bounded body size), not path filtering.
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
