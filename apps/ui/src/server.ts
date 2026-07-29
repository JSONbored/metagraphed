import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleOgImage } from "./lib/og-image";
import { routeOwnsOgImage } from "./lib/metagraphed/og-card";
import { handleAnalyticsProxy, type PostHogAssetContext } from "./lib/analytics-proxy";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

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

/**
 * Site-wide crawler defaults (#8624).
 *
 * `max-image-preview:large` is the one that matters: WITHOUT it Google caps the
 * preview to a thumbnail, which quietly wastes the whole per-page OG card
 * programme (#8489/#8622) in Search and Discover. `index,follow` is the default
 * anyway and is stated only so the directive list is readable.
 *
 * Appending this unconditionally is safe next to a route that emits its own
 * `noindex` (every detail route does, for a missing entity — see
 * entityNotFoundMeta). When a page carries conflicting robots tags, crawlers
 * take the MOST RESTRICTIVE directive, so `noindex` still wins; the failure
 * mode is biased towards not indexing, never towards indexing something we
 * marked. `og:locale` is here for the same reason it is anywhere: the site is
 * single-locale, and stating it stops platforms guessing.
 */
const SEO_DEFAULT_TAGS =
  `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">` +
  `<meta property="og:locale" content="en_US">`;

// Canonical human-facing pages for the sitemap (per-subnet pages are appended from the live list).
const SITEMAP_STATIC_PATHS = [
  "/",
  "/subnets",
  "/apis/providers",
  "/apis",
  "/apis/endpoints",
  "/chain",
  "/chain/blocks",
  "/chain/extrinsics",
  "/chain/events",
  "/chain/governance",
  "/chain/runtime",
  "/health",
  "/status",
  "/apis/schemas",
  "/contribute",
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

// Build the apex sitemap: canonical static pages, every docs page, and one entry per live subnet
// (by netuid) and per provider (by slug) — the dynamic detail routes (/subnets/$netuid,
// /providers/$slug). Each dynamic source is fetched independently and tolerant of failure, so a
// network hiccup just omits that source and the sitemap is always valid XML (never 500s).
//
// #8624 added two things. Docs were absent entirely — 20 pages of the most keyword-rich,
// most link-worthy content on the site, in a sitemap that listed 266 subnet and provider URLs.
// And no entry carried a <lastmod>, which for a product whose whole pitch is freshness left
// crawlers with nothing to schedule a recrawl against.
//
// <lastmod> is emitted ONLY where a real timestamp exists (a subnet's `updated_at`). It is
// deliberately NOT synthesised for static or docs pages: Google discounts lastmod wholesale
// once it catches a site stamping "now" on URLs that didn't change, so a fabricated value
// would cost us the real ones too. No value is better than a dishonest one.
interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

/** ISO-8601 date (W3C Datetime) if the value is a usable timestamp, else undefined. */
export function sitemapLastmod(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

async function buildSitemap(): Promise<Response> {
  const entries: SitemapEntry[] = SITEMAP_STATIC_PATHS.map((path) => ({
    loc: `${SITE_ORIGIN}${path}`,
  }));
  // Docs come from the same source that renders them, so a page added to content/docs/ is in
  // the sitemap the moment it ships — no second list to forget to update.
  //
  // Imported LAZILY, and that is not incidental: docs-source.ts pulls `collections/server`, a
  // fumadocs-mdx build-time virtual module that does not exist under vitest. A static import
  // here made every test that touches server.ts fail to collect. The dynamic import keeps the
  // module graph clean for tests and resolves only on a real /sitemap.xml request.
  try {
    const { docsSource } = await import("./lib/docs-source");
    for (const page of docsSource.getPages()) {
      entries.push({ loc: `${SITE_ORIGIN}${page.url}` });
    }
  } catch {
    // Docs source unavailable — omit rather than fail the whole sitemap.
  }
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/subnets?limit=500`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const payload = (await res.json()) as {
        data?: { subnets?: Array<{ netuid?: unknown; updated_at?: unknown }> };
      };
      for (const subnet of payload.data?.subnets ?? []) {
        if (Number.isInteger(subnet?.netuid)) {
          entries.push({
            loc: `${SITE_ORIGIN}/subnets/${String(subnet.netuid)}`,
            lastmod: sitemapLastmod(subnet?.updated_at),
          });
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
        data?: { providers?: Array<{ slug?: unknown; id?: unknown; updated_at?: unknown }> };
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
          entries.push({
            loc: `${SITE_ORIGIN}/providers/${encodeURIComponent(slug)}`,
            lastmod: sitemapLastmod(provider?.updated_at),
          });
        }
      }
    }
  } catch {
    // Network hiccup — providers are omitted; the sitemap stays valid XML.
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries
      .map(
        (entry) =>
          `  <url><loc>${entry.loc}</loc>${
            entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ""
          }</url>`,
      )
      .join("\n") +
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
      { name: "Providers", path: "/apis/providers" },
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

/**
 * Per-section OG card copy, keyed by exact pathname (#8489).
 *
 * Previously nine entries against ~49 routes, with everything else falling
 * through to a bare "Metagraphed" — so /agents, /leaderboards, /explorer,
 * /chain/*, /events, /blocks, /docs and most of the app unfurled IDENTICALLY
 * to the home page. This covers every real section so a shared link says what
 * it is.
 *
 * `eyebrow` renders as the pill beside the wordmark, matching the entity
 * cards' treatment. Home is deliberately absent: its card is the brand
 * statement, and an "eyebrow" on it would be noise.
 */
interface OgCopy {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}

export const OG_SECTIONS: Record<string, OgCopy> = {
  // Registry
  "/subnets": {
    title: "Subnets",
    subtitle: "Every Bittensor subnet, its surfaces, health and economics",
    eyebrow: "Registry",
  },
  "/validators": {
    title: "Validators",
    subtitle: "Stake, take and cross-subnet performance for every validator",
    eyebrow: "Registry",
  },
  "/accounts": {
    title: "Accounts",
    subtitle: "Balances, positions and on-chain activity by address",
    eyebrow: "Registry",
  },
  "/leaderboards": {
    title: "Leaderboards",
    subtitle: "Ranked subnets, validators and endpoints across the network",
    eyebrow: "Registry",
  },
  "/domains": {
    title: "Domains",
    subtitle: "Subnets grouped by what they actually do",
    eyebrow: "Registry",
  },

  // Interfaces
  "/apis": {
    title: "Interfaces",
    subtitle: "What every subnet exposes — APIs, docs and schemas",
    eyebrow: "Interfaces",
  },
  "/apis/providers": {
    title: "Providers",
    subtitle: "Infrastructure providers and the endpoints they operate",
    eyebrow: "Interfaces",
  },
  "/apis/endpoints": {
    title: "Endpoints",
    subtitle: "Every registered endpoint, with live operational health",
    eyebrow: "Interfaces",
  },
  "/apis/schemas": {
    title: "Schemas",
    subtitle: "Machine-readable schemas for every catalogued interface",
    eyebrow: "Interfaces",
  },
  "/providers": {
    title: "Providers",
    subtitle: "Infrastructure providers and the endpoints they operate",
    eyebrow: "Interfaces",
  },
  "/endpoints": {
    title: "Endpoints",
    subtitle: "Every registered endpoint, with live operational health",
    eyebrow: "Interfaces",
  },
  "/schemas": {
    title: "Schemas",
    subtitle: "Machine-readable schemas for every catalogued interface",
    eyebrow: "Interfaces",
  },
  "/surfaces": {
    title: "Surfaces",
    subtitle: "The full catalogue of subnet-published surfaces",
    eyebrow: "Interfaces",
  },
  "/gaps": {
    title: "Coverage gaps",
    subtitle: "Where the registry is still missing interface coverage",
    eyebrow: "Interfaces",
  },

  // Chain explorer
  "/chain": {
    title: "Chain",
    subtitle: "Live Bittensor base-layer activity, blocks and economics",
    eyebrow: "Explorer",
  },
  "/chain/analytics": {
    title: "Chain analytics",
    subtitle: "Stake flow, concentration and emission trends across the network",
    eyebrow: "Explorer",
  },
  "/chain/blocks": {
    title: "Blocks",
    subtitle: "Recent Bittensor blocks, extrinsics and events",
    eyebrow: "Explorer",
  },
  "/chain/events": {
    title: "Chain events",
    subtitle: "First-party decoded events from the Bittensor chain",
    eyebrow: "Explorer",
  },
  "/chain/extrinsics": {
    title: "Extrinsics",
    subtitle: "Signed extrinsics, fees and call data",
    eyebrow: "Explorer",
  },
  "/chain/governance": {
    title: "Governance",
    subtitle: "Runtime parameters, sudo activity and config changes",
    eyebrow: "Explorer",
  },
  "/chain/runtime": {
    title: "Runtime",
    subtitle: "Spec versions and runtime upgrade history",
    eyebrow: "Explorer",
  },
  "/blocks": {
    title: "Blocks",
    subtitle: "Recent Bittensor blocks, extrinsics and events",
    eyebrow: "Explorer",
  },
  "/extrinsics": {
    title: "Extrinsics",
    subtitle: "Signed extrinsics, fees and call data",
    eyebrow: "Explorer",
  },
  "/events": {
    title: "Events",
    subtitle: "First-party decoded events from the Bittensor chain",
    eyebrow: "Explorer",
  },
  "/runtime": {
    title: "Runtime",
    subtitle: "Spec versions and runtime upgrade history",
    eyebrow: "Explorer",
  },
  "/explorer": {
    title: "Explorer",
    subtitle: "Search blocks, extrinsics, accounts and events",
    eyebrow: "Explorer",
  },
  "/sudo": {
    title: "Sudo",
    subtitle: "Privileged runtime calls and config changes",
    eyebrow: "Explorer",
  },
  "/admin-changes": {
    title: "Admin changes",
    subtitle: "The public AdminUtils config-change feed",
    eyebrow: "Explorer",
  },

  // Health
  "/health": {
    title: "Health",
    subtitle: "Live operational health across every registered endpoint",
    eyebrow: "Health",
  },
  "/status": {
    title: "Status",
    subtitle: "Metagraphed's own uptime and publish health",
    eyebrow: "Health",
  },

  // Agents & developers
  "/agents": {
    title: "Agents",
    subtitle: "Connect an AI agent to Bittensor — MCP tools, playbooks and live data",
    eyebrow: "Agents",
  },
  "/docs": {
    title: "Docs",
    subtitle: "API reference, guides and machine-readable contracts",
    eyebrow: "Developers",
  },
  "/graphql/explorer": {
    title: "GraphQL explorer",
    subtitle: "Query the registry interactively over GraphQL",
    eyebrow: "Developers",
  },
  "/tools/ss58": {
    title: "SS58 tools",
    subtitle: "Encode, decode and inspect Bittensor addresses",
    eyebrow: "Developers",
  },
  "/settings": {
    title: "Developer settings",
    subtitle: "API keys, alert triggers and webhook subscriptions",
    eyebrow: "Developers",
  },

  // Product
  "/delegate": {
    title: "Delegate",
    subtitle: "Stake to a validator, non-custodially, from your own wallet",
    eyebrow: "Staking",
  },
  "/contribute": {
    title: "Contribute",
    subtitle: "Add a subnet's surfaces to the registry",
    eyebrow: "Open source",
  },
  "/about": {
    title: "About",
    subtitle: "What Metagraphed is, and how the data is produced",
    eyebrow: "About",
  },
};

/** Shortens an ss58/hotkey for a card, which has no room for 48 characters. */
function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 6)}…${key.slice(-6)}` : key;
}

/**
 * Title + subtitle for the rendered OG card, derived from the path (#8257).
 *
 * Entity pages get a card that names the entity instead of the same generic
 * tagline every page shared. Derived from the URL only -- deliberately no API
 * fetch here: this runs on every SSR of the page, and a link unfurl isn't
 * worth adding a blocking request to the critical path. The card is
 * identifying, not a live dashboard.
 */
/** Exported for tests: the section-coverage map is hand-maintained, and the
 * whole point of #8489's follow-up is that it must not silently go stale. */
export function ogCardCopy(pathname: string): OgCopy {
  const subnet = pathname.match(/^\/subnets\/([^/]+)\/?$/);
  if (subnet) {
    const id = safeDecodePathSegment(subnet[1]);
    return {
      title: `Subnet ${id}`,
      subtitle: "Surfaces, health and economics on Bittensor",
      eyebrow: "Subnet",
    };
  }
  const validator = pathname.match(/^\/validators\/([^/]+)\/?$/);
  if (validator) {
    return {
      title: shortKey(safeDecodePathSegment(validator[1])),
      subtitle: "Validator — stake, take and subnet memberships",
      eyebrow: "Validator",
    };
  }
  const account = pathname.match(/^\/accounts\/([^/]+)\/?$/);
  if (account) {
    return {
      title: shortKey(safeDecodePathSegment(account[1])),
      subtitle: "Account — balance, positions and on-chain activity",
      eyebrow: "Account",
    };
  }
  const provider = pathname.match(/^\/providers\/([^/]+)\/?$/);
  if (provider) {
    return {
      title: safeDecodePathSegment(provider[1]),
      subtitle: "Provider — endpoints and operational health",
      eyebrow: "Provider",
    };
  }
  // #8489: block/extrinsic detail pages name the thing being shared rather
  // than falling through to the generic card. Cheap -- the id is in the URL,
  // so this still needs no data fetch.
  const block = pathname.match(/^\/blocks\/([^/]+)\/?$/);
  if (block) {
    const ref = safeDecodePathSegment(block[1]);
    return {
      title: /^\d+$/.test(ref) ? `Block ${Number(ref).toLocaleString("en-US")}` : shortKey(ref),
      subtitle: "Extrinsics, events and timing for one Bittensor block",
      eyebrow: "Block",
    };
  }
  const extrinsic = pathname.match(/^\/extrinsics\/([^/]+)\/?$/);
  if (extrinsic) {
    return {
      title: shortKey(safeDecodePathSegment(extrinsic[1])),
      subtitle: "Call data, signer, fee and emitted events",
      eyebrow: "Extrinsic",
    };
  }
  // Exact-path section copy, then the brand card for anything genuinely
  // contentless (home, and any route not yet given its own copy).
  return OG_SECTIONS[pathname.replace(/\/+$/, "") || "/"] ?? { title: "Metagraphed" };
}

// Warm the TCP+TLS connection to the API origin before the first data fetch
// (preconnect), with a dns-prefetch fallback for agents that ignore preconnect.
const RESOURCE_HINTS =
  `<link rel="preconnect" href="${API_ORIGIN}" crossorigin>` +
  `<link rel="dns-prefetch" href="${API_ORIGIN}">`;

// Dependency-free Web Vitals beacon → first-party PostHog (metagraphed#7760
// ported this to PostHog alongside Umami's own sink; #7767's decommission
// removed the Umami sink below now that parity is proven and Umami itself is
// being retired). LCP (last entry), CLS (recent-input-excluded sum), and an
// INP proxy (worst slow-event duration) are flushed once on page hide.
// Wrapped in try/catch so a missing/broken `window.posthog` can never break
// the page. Consistent with the first-party analytics ethos (no third-party
// web-vitals CDN).
const WEB_VITALS_SNIPPET =
  `<script>(function(){` +
  `function send(n,v){var d={metric:n,value:Math.round(v)};` +
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

// Inject resource hints, a canonical link, schema.org JSON-LD, the
// og:image/twitter:image (edge-rendered /og card), and a Web Vitals beacon
// into <head> of HTML responses (streaming) and advertise the agent-
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
  // #8489: the three entity detail routes emit their own og:image in head(),
  // where loaderData is available and the card can carry real per-entity data.
  // Skipping them here is what keeps exactly ONE og:image tag on the page --
  // see routeOwnsOgImage's own comment for why ownership moved.
  const routeOwnsCard = routeOwnsOgImage(pathname);
  const ogCopy = ogCardCopy(pathname);
  const ogImage =
    `${SITE_ORIGIN}/og?title=${encodeURIComponent(ogCopy.title)}` +
    (ogCopy.subtitle ? `&subtitle=${encodeURIComponent(ogCopy.subtitle)}` : "") +
    (ogCopy.eyebrow ? `&eyebrow=${encodeURIComponent(ogCopy.eyebrow)}` : "");
  // #8624: og:image:alt is what a screen reader announces for an unfurl, and
  // several platforms surface it as the image caption. The card's own copy is
  // exactly the right text -- it IS what the image says.
  const ogImageAlt = ogCopy.subtitle ? `${ogCopy.title} — ${ogCopy.subtitle}` : ogCopy.title;
  const ogImageTags =
    `<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">` +
    `<meta property="og:image:width" content="1200">` +
    `<meta property="og:image:height" content="630">` +
    `<meta property="og:image:alt" content="${escapeHtmlAttr(ogImageAlt)}">` +
    `<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">` +
    `<meta name="twitter:image:alt" content="${escapeHtmlAttr(ogImageAlt)}">`;
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
              element.append(SEO_DEFAULT_TAGS, { html: true });
              if (!routeOwnsCard) element.append(ogImageTags, { html: true });
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
