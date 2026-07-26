// Product analytics (PostHog) first-party proxy (metagraphed#7760).
//
// Same rationale and first-party-proxy shape as the Umami proxy that used to
// live in src/server.ts (removed in #7767's decommission, once this proxy had
// proven parity). This one specifically follows PostHog's own documented
// Cloudflare Workers proxy guide
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
// first-party origin) -- "ingest" was chosen for the same reason the old
// Umami prefix (removed in #7767) was the unrelated-sounding "/stats".
//
// A standalone module (like lib/og-image.ts), not inline in server.ts, so it
// can be unit-tested directly -- server.ts itself has no test harness (it
// pulls in TanStack Start's real server entry), matching this codebase's
// existing convention of extracting server.ts's proxy/render logic into
// lib/ modules.
export const ANALYTICS_PREFIX = "/ingest";
const POSTHOG_API_HOST = "us.i.posthog.com";
const POSTHOG_ASSET_HOST = "us-assets.i.posthog.com";

// Same defensive purpose the old server.ts Umami proxy's own body-size cap
// served before its #7767 removal (this route is public/unauthenticated --
// reachable by anyone, not just posthog-js -- so it must never buffer an
// unbounded body into Worker memory). Sized above that proxy's old 16 KiB,
// not equal to it: PostHog's own capture endpoint accepts BATCHED events
// (posthog-js can queue and flush several pageview/custom events in one
// POST), unlike Umami's one-event-per-request format, so a real single
// request legitimately runs larger. This is our own defensive ceiling, not a
// PostHog-documented limit -- generous enough for realistic batched
// web-analytics traffic (autocapture stays OFF per metagraphed#7760's own
// requirement, so volume per batch stays small) while still bounding
// worst-case memory per request to a small, fixed cap.
const MAX_INGEST_BODY_BYTES = 64 * 1024;

// Session-replay snapshots are a different traffic class and need their own
// ceiling. The 64 KiB cap above reasons explicitly about batched pageview/
// custom events with autocapture OFF -- correct for those, but replay landed
// later (#7761, sampleRate 0.15) and posts rrweb DOM snapshots, which are
// orders of magnitude larger than an event batch. A full-snapshot flush on a
// dense page (the subnet detail route renders thousands of nodes) blows past
// 64 KiB easily, so the gate below was returning 413 and silently dropping
// recordings -- the replay data never reaches PostHog and nothing in the UI
// surfaces the loss.
//
// 2 MiB: comfortably above a realistic full-snapshot flush while still a small,
// fixed bound on per-request Worker memory (the 128 MiB isolate limit is the
// thing being protected). Still our own defensive ceiling, not a
// PostHog-documented limit -- their capture endpoint accepts far larger.
const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;

// posthog-js posts session-recording snapshots to `/s/` and everything else
// (events, flags, decide) to its own paths. Matched on the proxied upstream
// path, i.e. AFTER ANALYTICS_PREFIX has been stripped.
function maxBodyBytesForPath(pathWithParams: string): number {
  return /^\/s\/?(?:\?|$)/.test(pathWithParams) ? MAX_REPLAY_BODY_BYTES : MAX_INGEST_BODY_BYTES;
}

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
  ctx: PostHogAssetContext | undefined,
): Promise<Response> {
  // Root cause of a real production incident, found via `wrangler tail`
  // against the live Worker: `ctx` itself arrived `undefined` for this
  // request path (`ctx.waitUntil` throwing "Cannot read properties of
  // undefined (reading 'waitUntil')"), not a Cache API rejection -- the
  // earlier .catch()/try-catch additions around match()/put() were real
  // hardening but didn't address the actual trigger. server.ts casts its
  // own `ctx: unknown` parameter straight through (`ctx as
  // PostHogAssetContext`), a compile-time-only assertion with no runtime
  // guarantee -- whatever produces an undefined ctx for some requests
  // (still unconfirmed) is upstream of this module, so the only correct fix
  // here is to never assume the type-level contract holds at runtime.
  // Edge caching is a best-effort optimization; treat a missing/unusable
  // ctx exactly like a missing `caches` global -- degrade to an uncached
  // passthrough fetch, never throw.
  const hasEdgeCache = typeof caches !== "undefined" && typeof ctx?.waitUntil === "function";
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
  // the response below was already computed correctly. The edge cache is a
  // best-effort optimization; a write failure (a malformed Vary header from
  // upstream, a transient Cache API error, anything) must never take down
  // the response that's already correct and already on its way to the
  // browser.
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

  // Same content-length-first gate the old server.ts Umami collect endpoint
  // used -- reject BEFORE buffering, never after, so an oversized/malformed
  // request never gets read into memory at all. See MAX_INGEST_BODY_BYTES
  // above for why the cap differs from Umami's own, and MAX_REPLAY_BODY_BYTES
  // for why session-replay snapshots get their own larger ceiling.
  if (hasBody) {
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return new Response("Length Required", { status: 411 });
    }
    if (contentLength > maxBodyBytesForPath(pathWithParams)) {
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
  ctx: PostHogAssetContext | undefined,
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
