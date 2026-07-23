import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleOgImage } from "./lib/og-image";
import { handleAnalyticsProxy, type PostHogAssetContext } from "./lib/analytics-proxy";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

// --- Privacy analytics (self-hosted Umami), first-party + performance-tuned ---
//
// All of this lives in the Worker entry (infra), never in Lovable's UI code, so
// it survives Lovable regenerations. The tracker is proxied through this origin
// so it is (a) first-party — no extra DNS/TLS handshake to a 3rd-party domain;
// the tiny script is edge-cached and HTTP/2-multiplexed with the page; and
// (b) ad-blocker resilient — most blockers drop known analytics hostnames, which
// silently loses data, whereas first-party serving captures it. The script is
// `defer`-ed and injected via HTMLRewriter (streaming, no buffering).
const UMAMI_HOST = "https://tasty.aethereal.dev";
const UMAMI_WEBSITE_ID = "aac97255-44e1-4e9a-92d0-29d5fda1af45";
// Reported-to path. MUST be the frontend Worker, not `/api/*` (that route hits
// the backend on this zone). Umami appends `/api/send` to data-host-url.
const STATS_PREFIX = "/stats";
const STATS_COLLECT_PATH = `${STATS_PREFIX}/api/send`;
const MAX_STATS_BODY_BYTES = 16 * 1024;
const UMAMI_SNIPPET =
  `<script defer src="${STATS_PREFIX}/script.js" ` +
  `data-website-id="${UMAMI_WEBSITE_ID}" ` +
  `data-host-url="${STATS_PREFIX}"></script>`;

// HTMLRewriter is a Cloudflare Workers runtime global (the build target here).
declare const HTMLRewriter: {
  new (): {
    on(
      selector: string,
      handlers: {
        element(element: { append(content: string, options?: { html?: boolean }): void }): void;
      },
    ): { transform(response: Response): Response };
  };
};

// Proxy the tracker script + the collect endpoint through this origin. Returns
// null for everything else (the request falls through to the SSR app).
async function handleStatsProxy(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const isScript = url.pathname === `${STATS_PREFIX}/script.js`;
  const isStatsApi = url.pathname.startsWith(`${STATS_PREFIX}/api/`);
  if (!isScript && !isStatsApi) return null;

  if (isScript) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const upstreamUrl = `${UMAMI_HOST}${url.pathname.slice(STATS_PREFIX.length)}${url.search}`;
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: { accept: "*/*" },
    });
    const headers = new Headers(upstream.headers);
    // Long-lived browser cache; Cloudflare edge-caches the subrequest too.
    headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
    headers.delete("set-cookie");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  if (url.pathname !== STATS_COLLECT_PATH) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().split(";", 1)[0].trim().endsWith("/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return new Response("Length Required", { status: 411 });
  }
  if (contentLength > MAX_STATS_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }

  // Collect: forward only what Umami needs to attribute a real visit (UA +
  // visitor IP + language + content-type), not the full header set.
  const forwarded = new Headers();
  forwarded.set("content-type", contentType);
  const userAgent = request.headers.get("user-agent");
  if (userAgent) forwarded.set("user-agent", userAgent);
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) forwarded.set("accept-language", acceptLanguage);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) {
    forwarded.set("x-forwarded-for", clientIp);
    forwarded.set("x-real-ip", clientIp);
  }

  const upstreamUrl = `${UMAMI_HOST}/api/send${url.search}`;
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: forwarded,
    body: request.body,
  });
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// --- AI-agent discovery (RFC 8288 Link header, RFC 9727 api-catalog, sitemap, MCP card) ---
//
// The backend (api.metagraph.sh) canonically generates every agent-discovery resource; the apex
// (metagraph.sh — this Worker) must expose them too, since agents hit the human-facing domain. We
// PROXY the backend's resources (DRY + always current) and advertise them via a Link header on every
// HTML page. Lives in the Worker entry (infra), never in Lovable's UI code, so it survives Lovable
// regenerations.
const API_ORIGIN = "https://api.metagraph.sh";
const SITE_ORIGIN = "https://metagraph.sh";

// Resources the backend serves canonically. The apex proxies them with a tight
// response-header and media-type policy so API-origin cookies or active content
// are never re-scoped to metagraph.sh.
const DISCOVERY_CONTENT_TYPES = {
  "/.well-known/api-catalog": ["application/linkset+json", "application/json"],
  "/.well-known/mcp/server-card.json": ["application/json"],
  "/.well-known/agent-skills/index.json": ["application/json"],
  "/.well-known/security.txt": ["text/plain"],
  "/llms.txt": ["text/plain"],
  "/llms-full.txt": ["text/plain"],
  "/agent.md": ["text/markdown", "text/plain"],
} as const satisfies Record<string, readonly string[]>;

const DISCOVERY_PROXY_PATHS = new Set(Object.keys(DISCOVERY_CONTENT_TYPES));

const DISCOVERY_SAFE_RESPONSE_HEADERS = [
  "cache-control",
  "content-language",
  "etag",
  "expires",
  "last-modified",
  "vary",
] as const;

// RFC 8288 Link header advertising the API catalog + machine-readable descriptions, added to every
// HTML response (mirrors the backend's homepage Link header, with absolute API-origin targets).
const DISCOVERY_LINK_HEADER = [
  `<${API_ORIGIN}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  `<${API_ORIGIN}/metagraph/openapi.json>; rel="service-desc"; type="application/json"`,
  `<${API_ORIGIN}/llms.txt>; rel="service-doc"; type="text/plain"`,
  `<${API_ORIGIN}/agent.md>; rel="service-doc"; type="text/markdown"`,
  `<${API_ORIGIN}/health>; rel="status"; type="application/json"`,
  `<${API_ORIGIN}/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"`,
].join(", ");

// Canonical human-facing pages for the sitemap (per-subnet pages are appended from the live list).
const SITEMAP_STATIC_PATHS = [
  "/",
  "/subnets",
  "/providers",
  "/surfaces",
  "/endpoints",
  "/health",
  "/status",
  "/schemas",
  "/gaps",
  "/about",
];

// Proxy a backend discovery resource to the apex, or build the sitemap. Returns null for everything
// else (the request falls through to the SSR app).
async function handleDiscovery(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") return buildRobots();
  if (url.pathname === "/sitemap.xml") return buildSitemap();
  if (!DISCOVERY_PROXY_PATHS.has(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const upstream = await fetch(`${API_ORIGIN}${url.pathname}`, {
    headers: { accept: request.headers.get("accept") ?? "*/*" },
  });
  const headers = buildDiscoveryResponseHeaders(url.pathname, upstream.headers);
  if (!headers) {
    return new Response("Bad Gateway", {
      status: 502,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-discovery-origin": "api.metagraph.sh",
      },
    });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function buildDiscoveryResponseHeaders(pathname: string, upstreamHeaders: Headers): Headers | null {
  const allowedTypes: readonly string[] | undefined =
    DISCOVERY_CONTENT_TYPES[pathname as keyof typeof DISCOVERY_CONTENT_TYPES];
  if (!allowedTypes) return null;

  const upstreamContentType = upstreamHeaders.get("content-type") ?? "";
  const normalizedContentType = upstreamContentType.toLowerCase().split(";", 1)[0].trim();
  if (!allowedTypes.includes(normalizedContentType)) return null;

  const headers = new Headers();
  headers.set("content-type", upstreamContentType);
  for (const name of DISCOVERY_SAFE_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-discovery-origin", "api.metagraph.sh");
  return headers;
}

// robots.txt for the apex. metagraphed is a public, agent-ready registry, so all
// crawlers (including AI agents) are welcome — the machine API + discovery
// surfaces live on api.metagraph.sh (which serves its own robots.txt). Served
// here by the Worker because Cloudflare Managed robots.txt is disabled for the
// zone; advertises the human-page sitemap so crawlers can find it.
function buildRobots(): Response {
  const body =
    `# metagraph.sh — public Bittensor subnet integration registry.\n` +
    `# AI agents welcome; the machine API + discovery live on api.metagraph.sh.\n` +
    `User-agent: *\n` +
    `Allow: /\n` +
    `\n` +
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

// Build the apex sitemap: canonical static pages + one entry per live subnet (by netuid) and per
// provider (by slug) — the two dynamic detail routes (/subnets/$netuid, /providers/$slug). Each
// dynamic source is fetched independently and tolerant of failure, so a network hiccup just omits
// that source and the sitemap is always valid XML (never 500s).
async function buildSitemap(): Promise<Response> {
  const locs = SITEMAP_STATIC_PATHS.map((path) => `${SITE_ORIGIN}${path}`);
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/subnets?limit=500`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const payload = (await res.json()) as {
        data?: { subnets?: Array<{ netuid?: unknown }> };
      };
      for (const subnet of payload.data?.subnets ?? []) {
        if (Number.isInteger(subnet?.netuid)) {
          locs.push(`${SITE_ORIGIN}/subnets/${String(subnet.netuid)}`);
        }
      }
    }
  } catch {
    // Network hiccup — subnets are omitted; the sitemap stays valid XML.
  }
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/providers?limit=500`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const payload = (await res.json()) as {
        data?: { providers?: Array<{ slug?: unknown; id?: unknown }> };
      };
      for (const provider of payload.data?.providers ?? []) {
        // The list endpoint keys providers by `id`; the UI derives the route slug as
        // `slug ?? id` (see normalizeProviderListItem in lib/metagraphed/queries.ts).
        const slug =
          typeof provider?.slug === "string" && provider.slug
            ? provider.slug
            : typeof provider?.id === "string" && provider.id
              ? provider.id
              : null;
        if (slug) {
          locs.push(`${SITE_ORIGIN}/providers/${encodeURIComponent(slug)}`);
        }
      }
    }
  } catch {
    // Network hiccup — providers are omitted; the sitemap stays valid XML.
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

// Minimal HTML-attribute escaper for injected URLs. `url.pathname` is already
// percent-encoded by URL parsing, so this only guards stray &/quotes/brackets.
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A schema.org BreadcrumbList for the two detail routes, derived purely from the
// path (no data fetch). Returns null for every other route.
function safeDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function buildBreadcrumb(pathname: string): unknown | null {
  const subnet = pathname.match(/^\/subnets\/([^/]+)\/?$/);
  const provider = pathname.match(/^\/providers\/([^/]+)\/?$/);
  let trail: Array<{ name: string; path: string }> | null = null;
  if (subnet) {
    const name = safeDecodePathSegment(subnet[1]);
    trail = [
      { name: "Home", path: "/" },
      { name: "Subnets", path: "/subnets" },
      { name: `Subnet ${name}`, path: `/subnets/${subnet[1]}` },
    ];
  } else if (provider) {
    const name = safeDecodePathSegment(provider[1]);
    trail = [
      { name: "Home", path: "/" },
      { name: "Providers", path: "/providers" },
      { name, path: `/providers/${provider[1]}` },
    ];
  }
  if (!trail) return null;
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_ORIGIN}${item.path}`,
    })),
  };
}

// schema.org JSON-LD: Organization + WebSite (with a sitelinks SearchAction over
// /subnets?q=) on every page, plus a BreadcrumbList on the detail routes. The
// serialized JSON escapes every "<" character so a crafted path segment can
// never break out of the <script> element. ItemList on listings is intentionally
// omitted (needs per-request data, rarely yields rich results).
function buildJsonLd(pathname: string): string {
  const graph: unknown[] = [
    {
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#org`,
      name: "Metagraphed",
      url: SITE_ORIGIN,
      description:
        "The Bittensor subnet integration registry — what each subnet exposes (APIs, docs, schemas), whether it is healthy, and how to call it.",
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      url: SITE_ORIGIN,
      name: "Metagraphed",
      publisher: { "@id": `${SITE_ORIGIN}/#org` },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE_ORIGIN}/subnets?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
  ];
  const breadcrumb = buildBreadcrumb(pathname);
  if (breadcrumb) graph.push(breadcrumb);
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": graph,
  }).replace(/</g, "\\u003c");
}

// A short, human-readable title for the rendered OG card, derived from the path.
const OG_SECTION_TITLES: Record<string, string> = {
  "/subnets": "Subnets",
  "/providers": "Providers",
  "/surfaces": "Interfaces",
  "/endpoints": "Endpoints",
  "/health": "Health",
  "/status": "Status",
  "/schemas": "Schemas",
  "/gaps": "Registry gaps",
  "/about": "About",
};
function ogCardTitle(pathname: string): string {
  const subnet = pathname.match(/^\/subnets\/([^/]+)\/?$/);
  if (subnet) return `Subnet ${safeDecodePathSegment(subnet[1])}`;
  const provider = pathname.match(/^\/providers\/([^/]+)\/?$/);
  if (provider) return safeDecodePathSegment(provider[1]);
  return OG_SECTION_TITLES[pathname] ?? "Metagraphed";
}

// Warm the TCP+TLS connection to the API origin before the first data fetch
// (preconnect), with a dns-prefetch fallback for agents that ignore preconnect.
const RESOURCE_HINTS =
  `<link rel="preconnect" href="${API_ORIGIN}" crossorigin>` +
  `<link rel="dns-prefetch" href="${API_ORIGIN}">`;

// Dependency-free Web Vitals beacon → first-party Umami + PostHog
// (metagraphed#7760: ported to PostHog alongside, not instead of, Umami --
// both sinks stay live until the Umami decommission issue). LCP (last
// entry), CLS (recent-input-excluded sum), and an INP proxy (worst
// slow-event duration) are flushed once on page hide. Wrapped in try/catch
// per sink so one missing/broken global can never break the page or block
// the other sink, and no-ops if neither has loaded. Consistent with the
// first-party analytics ethos (no third-party web-vitals CDN).
const WEB_VITALS_SNIPPET =
  `<script>(function(){` +
  `function send(n,v){var d={metric:n,value:Math.round(v)};` +
  `try{if(window.umami&&typeof window.umami.track==='function'){window.umami.track('web-vitals',d);}}catch(e){}` +
  `try{if(window.posthog&&typeof window.posthog.capture==='function'){window.posthog.capture('web_vitals',d);}}catch(e){}}` +
  `function obs(t,cb){try{new PerformanceObserver(cb).observe({type:t,buffered:true});}catch(e){}}` +
  `var lcp=0,cls=0,inp=0;` +
  `obs('largest-contentful-paint',function(l){var e=l.getEntries();var x=e[e.length-1];if(x)lcp=x.startTime;});` +
  `obs('layout-shift',function(l){l.getEntries().forEach(function(e){if(!e.hadRecentInput)cls+=e.value;});});` +
  `obs('event',function(l){l.getEntries().forEach(function(e){if(e.duration>inp)inp=e.duration;});});` +
  `var done=false;function flush(){if(done)return;done=true;if(lcp)send('LCP',lcp);send('CLS',cls*1000);if(inp)send('INP',inp);}` +
  `addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush();});` +
  `addEventListener('pagehide',flush);` +
  `})();</script>`;

// Inject resource hints, the deferred tracker, a canonical link, schema.org
// JSON-LD, the og:image/twitter:image (edge-rendered /og card), and a Web Vitals
// beacon into <head> of HTML responses (streaming) and advertise the agent-
// discovery resources via an RFC 8288 Link header. Canonical + JSON-LD + og:image
// are set HERE (not per-route) so they are global, consistent, and regen-proof.
// Canonical is origin + path with the query stripped, so filter/sort permutations
// (e.g. /subnets?sort=health&health=down) consolidate to the one indexable URL
// instead of reading as duplicate content.
function injectAnalytics(response: Response, request: Request): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  const pathname = new URL(request.url).pathname;
  const canonicalUrl = `${SITE_ORIGIN}${pathname}`;
  const canonicalTag = `<link rel="canonical" href="${escapeHtmlAttr(canonicalUrl)}">`;
  // og:url must be the per-page canonical URL (not a hardcoded homepage), so deep
  // shares unfurl to the entity page. Set here (regen-proof) since __root only had
  // a static homepage value.
  const ogUrlTag = `<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}">`;
  const jsonLdTag = `<script type="application/ld+json">${buildJsonLd(pathname)}</script>`;
  const ogImage = `${SITE_ORIGIN}/og?title=${encodeURIComponent(ogCardTitle(pathname))}`;
  const ogImageTags =
    `<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">` +
    `<meta property="og:image:width" content="1200">` +
    `<meta property="og:image:height" content="630">` +
    `<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">`;
  // HTMLRewriter is a Cloudflare Workers runtime global; under local `vite dev`
  // (Node) it's absent. Skip the streaming <head> injection there — these meta
  // tags are a production SEO/unfurl concern — and pass the rendered HTML through
  // unchanged. Production (workerd) keeps the full injection path.
  const transformed =
    typeof HTMLRewriter === "undefined"
      ? response
      : new HTMLRewriter()
          .on("head", {
            element(element) {
              element.append(RESOURCE_HINTS, { html: true });
              element.append(canonicalTag, { html: true });
              element.append(ogUrlTag, { html: true });
              element.append(jsonLdTag, { html: true });
              element.append(ogImageTags, { html: true });
              element.append(UMAMI_SNIPPET, { html: true });
              element.append(WEB_VITALS_SNIPPET, { html: true });
            },
          })
          .transform(response);
  const headers = new Headers(transformed.headers);
  headers.set("link", DISCOVERY_LINK_HEADER);
  // Conservative security headers for the HTML site (no CSP — an SPA CSP is
  // breakage-prone and the JSON API is the real attack surface). These guard
  // clickjacking + referrer leakage + opt out of unused powerful features.
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// TanStack's server entry answers any non-HTML request (e.g. an MCP JSON-RPC
// POST, or any Accept: application/json request, that hit the apex by mistake)
// with a 500 {"error":"Only HTML requests are supported here"}. A 5xx wrongly
// signals that the server failed and can trigger agent retries/backoff against a
// "failing" host. The API and MCP server live on the canonical host
// (api.metagraph.sh) and discovery already points agents there, so re-map this
// misdirected-request case to a 404 that points at the canonical URL.
async function normalizeNonHtmlSsrResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;
  const body = await response.clone().text();
  if (!body.includes("Only HTML requests are supported here")) return response;
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      error: "not_found",
      message: `${url.pathname} is not served on the human site (${SITE_ORIGIN}); the API and MCP server are on the canonical host.`,
      canonical: `${API_ORIGIN}${url.pathname}${url.search}`,
    }),
    {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const statsResponse = await handleStatsProxy(request);
    if (statsResponse) return statsResponse;
    // A top-level safety net, not just belt-and-suspenders: this proxy's own
    // internal error handling (analytics-proxy.ts) has already had one real
    // production incident where an unguarded background failure escaped as
    // an unhandled rejection and corrupted the response for every
    // /ingest/static/* and /ingest/array/* request. A public analytics
    // proxy must never be able to take down request handling -- catch
    // ANYTHING it throws and treat it as "not handled" so the request falls
    // through to the real SSR app below, rather than surfacing a broken
    // response for a concern this unrelated to the page being requested.
    let analyticsResponse: Response | null = null;
    try {
      analyticsResponse = await handleAnalyticsProxy(request, ctx as PostHogAssetContext);
    } catch (error) {
      console.error("[analytics-proxy] request handling failed:", error);
    }
    if (analyticsResponse) return analyticsResponse;
    const ogResponse = await handleOgImage(request);
    if (ogResponse) return ogResponse;
    const discoveryResponse = await handleDiscovery(request);
    if (discoveryResponse) return discoveryResponse;
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeNonHtmlSsrResponse(
        request,
        await normalizeCatastrophicSsrResponse(response),
      );
      return injectAnalytics(normalized, request);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
