// Metagraphed PWA service worker (#8384). Hand-rolled, no Workbox — this is a
// small, fully-auditable set of three strategies, each scoped to exactly the
// requests it should touch. Nothing outside those three buckets is cached: an
// on-chain explorer must never silently serve stale chain data.
//
// Registered from apps/ui/src/hooks/use-service-worker.ts, scope "/" (served
// from the app's root via the Cloudflare Assets binding — see that file's own
// header comment for why no Worker route handler is needed for this file).
"use strict";

const SW_VERSION = "v1";
const SHELL_CACHE = `metagraphed-shell-${SW_VERSION}`;
const API_CACHE = `metagraphed-api-${SW_VERSION}`;
const KNOWN_CACHES = new Set([SHELL_CACHE, API_CACHE]);

// (c) The ONLY /api/v1/* requests this worker ever caches — exactly the
// queries apps/ui/src/components/metagraphed/home-watched-module.tsx fires to
// render the watchlist (subnetsQuery/economicsQuery/subnetHealthMapQuery/
// validatorsQuery, see queries.ts). Everything else under /api/v1/ stays
// strictly network-only: this is a live chain explorer, and silently serving
// cached data anywhere the visitor didn't ask to see "possibly old" would be
// a correctness bug, not a convenience. The regex tolerates the app's
// optional /{network}/ path prefix (applyNetworkPrefix in client.ts) between
// /api/v1/ and the resource name.
const SWR_API_PATTERN =
  /^\/api\/v1\/(?:[a-z]+\/)?(?:subnets|economics|health|validators)(?:[/?]|$)/;

// Requests this worker treats as hashed build output: cache-first is safe
// because a content hash in the filename makes "stale" impossible by
// construction (a changed file is a different URL). Matches Vite's default
// `/assets/*` output directory plus the handful of top-level hashed/
// versioned files this app also serves from public/ (icons etc. are NOT
// hashed, so they're deliberately excluded — see isAppShellAsset below).
function isAppShellAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/assets/");
}

function isNavigationRequest(request) {
  return request.mode === "navigate";
}

function isSwrApiRequest(url) {
  return url.hostname === "api.metagraph.sh" && SWR_API_PATTERN.test(url.pathname);
}

// #8384 requirement (c): entries older than this still get served (better a
// stale watchlist than a blank one while offline), but the client-side
// x-sw-cached-at header lets the UI decide whether to show the
// "cached · Xm old" affordance.
const SWR_STALE_AFTER_MS = 15 * 60 * 1000;

function withCachedAtHeader(response) {
  const headers = new Headers(response.headers);
  headers.set("x-sw-cached-at", String(Date.now()));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// The ONE thing this worker precaches: found by testing the offline path
// end-to-end -- handleNavigation's own fallback fetch for /offline.html is
// itself just as offline as the request that triggered it, so without a
// precached copy here, the "show offline.html instead of a browser error"
// path would only ever have worked while online (defeating its entire
// purpose). Everything else stays lazily/opportunistically cached, per the
// header comments on isAppShellAsset/handleNavigation/handleSwrApi -- this
// one file is the sole, deliberate exception.
self.addEventListener("install", (event) => {
  // Deliberately no skipWaiting() -- see the "update" section of
  // use-service-worker.ts for why activation waits on explicit user
  // consent (#8384 requirement 6).
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.add("/offline.html")));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !KNOWN_CACHES.has(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// (a) App-shell assets: cache-first.
async function handleAppShellAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// (b) Navigation requests: network-first with a 3s timeout, falling back to
// whichever cached shell is available. A successful online navigation is
// cached under its own URL so that SAME route can be reopened offline later
// (this is how "offline opens the home watchlist" actually works -- there is
// no synthetic single-page shell to precache in an SSR app like this one,
// only real rendered responses captured as visitors browse online). A
// navigation to a URL that was never cached falls back to the static
// public/offline.html page instead of the browser's own network-error
// interstitial (#8384 requirement 3).
async function handleNavigation(request, event) {
  try {
    const response = await fetchWithTimeout(request, 3000);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match(request)) || (await cache.match("/"));
    if (cached) return cached;
    return (await cache.match("/offline.html")) || fetch("/offline.html");
  }
}

// (c) The watchlist home module's own API queries: stale-while-revalidate.
// Cache hit -> respond immediately (any age -- offline is better served by
// old data than no data), and refresh the cache in the background via
// event.waitUntil so the SW stays alive long enough for that fetch to land.
// Cache miss -> fall through to the network so the very first, online visit
// still works normally.
async function handleSwrApi(request, event) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  const revalidate = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, withCachedAtHeader(response.clone()));
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }
  const fresh = await revalidate;
  if (fresh) return fresh;
  // Neither a cache entry nor a live network response -- propagate a real
  // failure (apiFetch's own catch turns this into an ApiError with
  // status: 0, the existing "offline/network error" signal states.tsx and
  // router.tsx's retry policy both key off).
  throw new TypeError("Failed to fetch (offline, no cached copy)");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes

  const url = new URL(request.url);

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigation(request, event));
    return;
  }
  if (isAppShellAsset(url)) {
    event.respondWith(handleAppShellAsset(request));
    return;
  }
  if (isSwrApiRequest(url)) {
    event.respondWith(handleSwrApi(request, event));
    return;
  }
  // Everything else (every other /api/v1/* call, third-party requests, RPC
  // proxy calls, etc.) is intentionally left alone -- no respondWith() means
  // the browser's normal network fetch happens, uncached.
});

// (6) Update flow: the page posts this once the visitor accepts the
// "Update available" toast (use-service-worker.ts) -- never automatically.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// (7) Web-push alerts (#8385). The payload arrives already decrypted by the
// browser (RFC 8291 aes128gcm; sender side is src/web-push.ts) and is the
// PushNotificationPayload shape from src/web-push-payload.ts:
// { title, body, url, tag }.
//
// SILENT PUSH IS PROHIBITED. Every push MUST show a notification: browsers
// permit a handler that shows nothing only briefly, then either revoke the
// permission or post a generic "site updated in the background" notification
// on our behalf. So this handler shows a notification on EVERY path,
// including when the payload is missing or unparseable -- there is
// deliberately no early return that would leave a push silent.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Malformed/non-JSON payload: fall through to the generic notification
    // below rather than throwing, which would count as a silent push.
  }
  const title = payload.title || "Chain alert";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "A chain alert you subscribed to matched.",
      // Same-origin path only -- never navigate somewhere a payload names
      // off-origin, even though the payload is authenticated by VAPID.
      data: { url: typeof payload.url === "string" ? payload.url : "/" },
      tag: payload.tag || "mg-alert",
      icon: "/android-chrome-192x192.png",
      badge: "/android-chrome-192x192.png",
    }),
  );
});

// Tap-through: focus an already-open tab and route it, otherwise open one.
// Reusing a tab avoids stacking duplicates every time an alert is tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  // Resolve against our own origin and keep only the path: a payload can
  // never send a tap to another site.
  let path = "/";
  try {
    const resolved = new URL(raw, self.location.origin);
    if (resolved.origin === self.location.origin) {
      path = resolved.pathname + resolved.search;
    }
  } catch {
    /* keep "/" */
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(path).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});
