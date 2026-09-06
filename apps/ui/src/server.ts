import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleOgImage } from "./lib/og-image";
import { buildOgImageUrl, routeOwnsOgImage } from "./lib/metagraphed/og-card";
import {
  apiRecordUrl,
  breadcrumbListJsonLd,
  siteGraphNodes,
  stringifyJsonLd,
} from "./lib/metagraphed/json-ld";
import { formatNumber } from "@/lib/metagraphed/format";
import { SUBNETS_ALL_LIMIT } from "./lib/metagraphed/subnet-list-limit";
import { isoTimestamp } from "./lib/metagraphed/freshness";
import { API_DATA_ORIGIN, API_ORIGIN, SITE_ORIGIN, X_HANDLE } from "./lib/metagraphed/identity";
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

// Resources the backend serves canonically. The apex proxies them with a tight
// response-header and media-type policy so API-origin cookies or active content
// are never re-scoped to metagraph.sh.
const DISCOVERY_CONTENT_TYPES = {
  "/.well-known/api-catalog": ["application/linkset+json", "application/json"],
  "/.well-known/mcp/server-card.json": ["application/json"],
  "/.well-known/agent-card.json": ["application/json"],
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
export const SEO_DEFAULT_TAGS =
  `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">` +
  `<meta property="og:locale" content="en_US">` +
  // X attributes the card to this account and shows it on the unfurl. `site`
  // and `creator` are the same handle because the site IS the author here --
  // there are no per-article bylines to differentiate.
  `<meta name="twitter:site" content="${X_HANDLE}">` +
  `<meta name="twitter:creator" content="${X_HANDLE}">`;

// Canonical human-facing pages for the sitemap (per-subnet pages are appended from the live list).
const SITEMAP_STATIC_PATHS = [
  "/",
  "/subnets",
  "/validators",
  "/accounts",
  "/apis/providers",
  "/apis",
  "/apis/endpoints",
  "/chain",
  "/chain/blocks",
  "/chain/extrinsics",
  "/chain/events",
  // #11619 dropped /chain/governance and /chain/runtime: both are sections of
  // /chain now and answer 301. A sitemap must only ask a crawler to index a URL
  // that answers 200 — listing a redirect refills the "Page with redirect"
  // bucket #11204 emptied and spends the budget getting there.
  "/health",
  // #11625 dropped /status: it is a section of /health now and answers 301.
  // A sitemap must only ask a crawler to index a URL that answers 200.
  "/apis/schemas",
  "/contribute",
  "/about",
  "/agents",
  "/graphql/explorer",
  "/settings",
  "/privacy",
  "/terms",
];

/**
 * Send an apex `/metagraph/*` request to the host that actually serves it (#11204).
 *
 * The generated artifacts live on api.metagraph.sh and have never been served
 * here — `https://metagraph.sh/metagraph/subnets.json` 404s while
 * `https://api.metagraph.sh/metagraph/subnets.json` is a 200. Search Console
 * reported 82 of the site's 83 crawl errors against exactly this prefix, so
 * every one of them is a link (ours, historically, or someone else's) pointing
 * at the wrong host rather than at a resource that stopped existing.
 *
 * A 301 is the honest answer: the artifact is not missing, it is somewhere
 * else, permanently. That resolves the whole bucket in one rule and keeps any
 * external link to the old shape working, which returning a prettier 404 would
 * not. `url.search` is carried through so a query-bearing artifact URL survives
 * the hop, and only GET/HEAD are redirected — anything else falls through to
 * the SSR app, whose non-HTML handler already answers with the canonical URL.
 */
export function handleArtifactHostRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname !== "/metagraph" && !url.pathname.startsWith("/metagraph/")) return null;
  return new Response(null, {
    status: 301,
    headers: {
      location: `${API_ORIGIN}${url.pathname}${url.search}`,
      // Safe to cache: the split between the human site and the API host is
      // structural, not a routing detail that changes per deploy.
      "cache-control": "public, max-age=3600",
    },
  });
}

// Proxy a backend discovery resource to the apex, or build the sitemap. Returns null for everything
// else (the request falls through to the SSR app).
async function handleDiscovery(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") return buildRobots(url.host);
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

/**
 * The one host whose pages are canonical.
 *
 * This Worker answers on more than one hostname — `testnet.metagraph.sh` today,
 * and historically the account's leftover `*.workers.dev` subdomain, which #9004
 * found serving the entire site in parallel. Every non-canonical hostname is
 * duplicate content of the apex by construction: same routes, same Worker, and
 * (for testnet) data nobody searches for.
 *
 * Derived from SITE_ORIGIN rather than written out again so the two can never
 * drift, and matched as an exact host so a NEW hostname is non-canonical by
 * default. That default is the point: #9004's duplicate host was live and
 * indexable for as long as it took someone to notice, and an allowlist-of-one
 * is what makes the next one fail closed instead.
 */
const CANONICAL_HOST = new URL(SITE_ORIGIN).host;

/**
 * robots.txt. Served here by the Worker because Cloudflare Managed robots.txt is
 * disabled for the zone.
 *
 * metagraphed is a public, agent-ready registry, so on the canonical host all
 * crawlers (including AI agents) stay welcome — `Allow: /` is the posture and
 * #11002 does not retreat from it. What it withholds is the three UNBOUNDED
 * per-entity spaces: ~8.8M blocks at the head growing ~7,200/day, every
 * extrinsic inside each of them, and every ss58 that has ever touched the chain.
 * None of the three is in the sitemap, each render fans out to the most
 * expensive query in the project (#11001), and the crawl was measured driving
 * the SSR rate-limit rejections in #11000. Crawling all of it is a crawl-budget
 * sink that competes with the registry pages that ARE worth ranking.
 *
 * The prefixes are exact, and the three do not behave identically:
 *   - `/blocks/` and `/extrinsics/` are safe to withhold whole. Their index
 *     routes are `/chain/blocks` and `/chain/extrinsics` (both in
 *     SITEMAP_STATIC_PATHS); the bare `/blocks/` and `/extrinsics/` paths are
 *     permanent redirect stubs into that hub (routes/blocks.index.tsx et al), so
 *     no live page is lost.
 *   - `/accounts/` is NOT a stub — it is a real index page, and the one a pasted
 *     EVM address lands on (`/accounts?h160=…`, metagraphed-infra#373). So the
 *     index is re-permitted by an end-anchored `Allow`, which beats the broader
 *     `Disallow` under RFC 9309's longest-match precedence, while every
 *     `/accounts/<ss58>` below it stays withheld.
 */
export function robotsBody(host: string): string {
  if (host !== CANONICAL_HOST) {
    // No Sitemap line: a robots.txt may only advertise sitemaps for its OWN
    // host, so the apex's sitemap URL was never valid here in the first place.
    return (
      `# Non-canonical host — this is a duplicate of ${SITE_ORIGIN}, which is\n` +
      `# the only hostname whose pages should be crawled or indexed.\n` +
      `User-agent: *\n` +
      `Disallow: /\n`
    );
  }
  return (
    `# metagraph.sh — public Bittensor subnet integration registry.\n` +
    `# AI agents welcome; the machine API + discovery live on api.metagraph.sh.\n` +
    // Content Signals (contentsignals.org): all three yes, deliberately —
    // public data that exists to be read and reasoned over by machines. The
    // API host carries the same declaration (scripts/build-artifacts.ts).
    //
    // INSIDE the group, not above it. robots.txt is defined (RFC 9309) as
    // groups introduced by a `User-agent` line, and Content Signals is a
    // directive of the group it sits in — the spec's own example is
    // `User-Agent: *` / `Content-Signal: ...` / `Allow: /`, in that order.
    // Emitted above the first `User-agent` line it belongs to no group at all,
    // which is how it shipped in #11174: present in the file, read by nothing.
    `User-agent: *\n` +
    `Content-Signal: search=yes, ai-input=yes, ai-train=yes\n` +
    `Allow: /\n` +
    `# Unbounded per-entity detail: not in the sitemap, one uncached scan per URL.\n` +
    `# The hub indexes (/chain/blocks, /chain/extrinsics) stay crawlable, as does\n` +
    `# the /accounts index itself — only the per-account pages below it do not.\n` +
    `Disallow: /blocks/\n` +
    `Disallow: /extrinsics/\n` +
    `Disallow: /accounts/\n` +
    `Allow: /accounts/$\n` +
    `\n` +
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml\n`
  );
}

function buildRobots(host: string): Response {
  return new Response(robotsBody(host), {
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

/**
 * ISO-8601 date (W3C Datetime) if the value is a usable timestamp, else undefined.
 *
 * #11314: the rule itself moved to lib/metagraphed/freshness.ts so the JSON-LD
 * builders can apply the identical one -- a page whose `dateModified` and whose
 * sitemap `lastmod` disagree is a page making two different claims about the
 * same fact. Re-exported under the original name because this is the export the
 * sitemap tests and every existing call site already use.
 */
export const sitemapLastmod = isoTimestamp;

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
  // #11266: the weekly digests, absent since they shipped (#8705). 161 pages of
  // per-subnet prose that nothing linked and the sitemap never listed, so a
  // crawler had no way to reach them at all -- their own route comment calls
  // them "the pages the issue expects search and social to land on".
  //
  // Same lazy import and same tolerance as docs above; a separate collection
  // (source.config.ts keeps them apart so "Subnet 104 — 2026-W29" never lands
  // in the API-reference nav), so it needs its own loop.
  //
  // No <lastmod>: the digest store is append-only and a published week is never
  // rewritten, so there is no honest "changed at" to emit -- and a synthesised
  // one costs the real timestamps elsewhere in this file their credibility.
  try {
    const { newsSource } = await import("./lib/news-source");
    for (const page of newsSource.getPages()) {
      entries.push({ loc: `${SITE_ORIGIN}${page.url}` });
    }
  } catch {
    // News source unavailable — omit rather than fail the whole sitemap.
  }
  try {
    // The SAME limit the subnet surfaces use, so the sitemap and the page
    // derive their set from one request. A hard-coded 500 here made the two
    // different requests, which the e2e stub answers with two different
    // recordings.
    //
    // #11613 removed the `/subnets/category/{slug}` entries this loop also
    // emitted: the taxonomy is a filter on /subnets now, so those URLs are
    // permanent redirects and a sitemap must only ask a crawler to index a URL
    // that answers 200.
    const res = await fetch(`${API_DATA_ORIGIN}/api/v1/subnets?limit=${SUBNETS_ALL_LIMIT}`, {
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
  // Validators. All 1029 are active on at least one subnet and 999 hold over 1000 TAO, so these
  // are substantive pages rather than the thin ones a large auto-generated set usually implies —
  // they were simply never listed. No <lastmod>: the only timestamp the list carries is
  // `latest_captured_at`, which is when we last PROBED, not when the page's content changed.
  // Stamping that would be the "lastmod is really just now" antipattern the helper above exists
  // to avoid, on 1029 URLs at once.
  try {
    const res = await fetch(`${API_DATA_ORIGIN}/api/v1/validators?limit=2000`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const payload = (await res.json()) as {
        data?: { validators?: Array<{ hotkey?: unknown }> };
      };
      for (const validator of payload.data?.validators ?? []) {
        if (typeof validator?.hotkey === "string" && validator.hotkey) {
          entries.push({
            loc: `${SITE_ORIGIN}/validators/${encodeURIComponent(validator.hotkey)}`,
          });
        }
      }
    }
  } catch {
    // Network hiccup — validators are omitted; the sitemap stays valid XML.
  }
  try {
    const res = await fetch(`${API_DATA_ORIGIN}/api/v1/providers?limit=500`, {
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
  const validator = pathname.match(/^\/validators\/([^/]+)\/?$/);
  const docs = pathname.match(/^\/docs\/(.+?)\/?$/);
  const news = pathname.match(/^\/news\/(.+?)\/?$/);
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
  } else if (validator) {
    // #11204: 1,023 validator pages are in the sitemap and every one of them
    // was emitting no breadcrumb at all, which is most of why Search Console
    // reported ONE valid breadcrumb item site-wide. The hotkey is truncated the
    // way the page itself titles it -- a 48-character ss58 is not a crumb.
    const hotkey = safeDecodePathSegment(validator[1]);
    trail = [
      { name: "Home", path: "/" },
      { name: "Validators", path: "/validators" },
      { name: shortKey(hotkey), path: `/validators/${validator[1]}` },
    ];
  } else if (docs) {
    // 322 docs pages, likewise bare. The trail is derived from the path
    // segments themselves, so a page added to content/docs/ is covered the
    // moment it ships -- the same property that keeps it out of the sitemap's
    // second list to forget.
    const segments = docs[1].split("/").filter(Boolean);
    trail = [
      { name: "Home", path: "/" },
      { name: "Docs", path: "/docs" },
      ...segments.map((segment, index) => ({
        name: titleCaseSlug(safeDecodePathSegment(segment)),
        path: `/docs/${segments.slice(0, index + 1).join("/")}`,
      })),
    ];
  } else if (news) {
    // #11303: the 285 weekly digests -- 15% of the sitemap -- rendered a
    // breadcrumb the reader can see and emitted no BreadcrumbList for it. They
    // shipped in #8705, after this function was written, and adding a route
    // family here is a step nothing forced. Derived from the path segments for
    // the same reason the docs trail is: a new subject folder is covered the
    // moment it ships.
    const segments = news[1].split("/").filter(Boolean);
    trail = [
      { name: "Home", path: "/" },
      { name: "News", path: "/news" },
      ...segments.map((segment, index) => ({
        name: titleCaseSlug(safeDecodePathSegment(segment)),
        path: `/news/${segments.slice(0, index + 1).join("/")}`,
      })),
    ];
  }
  if (!trail) return null;
  return breadcrumbListJsonLd(
    trail.map((item) => ({ name: item.name, item: `${SITE_ORIGIN}${item.path}` })),
  );
}

/** `api-reference` -> `API reference`; a URL slug is not a breadcrumb label. */
function titleCaseSlug(slug: string): string {
  // An ISO week slug is checked FIRST, because its hyphen is meaningful and the
  // general rule below would turn `2026-w25` into `2026 w25`. The digest pages
  // print it as `2026-W25` and so does the crumb.
  const week = /^(\d{4})-w(\d{1,2})$/i.exec(slug);
  if (week) return `${week[1]}-W${week[2]}`;
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (!words) return slug;
  const cased = words.charAt(0).toUpperCase() + words.slice(1);
  return (
    cased
      .replace(/\bapi\b/gi, "API")
      .replace(/\bmcp\b/gi, "MCP")
      // `sn38` is the subject folder of a digest, and the site never writes it
      // `Sn38` -- every page, title and card says SN38.
      .replace(/\bsn(\d+)\b/gi, "SN$1")
  );
}

// schema.org JSON-LD: Organization + WebSite (with a sitelinks SearchAction over
// /subnets?q=) on every page, plus a BreadcrumbList on the detail routes. The
// serialized JSON is escaped by stringifyJsonLd (see json-ld.ts) so a crafted
// path segment can never break out of the <script> element. ItemList on
// listings is intentionally omitted (needs per-request data, rarely yields rich
// results); the per-subnet Dataset lives in the route's own head(), where the
// loader data it describes is available.
export function buildJsonLd(pathname: string): string {
  // The site nodes are defined in json-ld.ts, not here: an entity route's own
  // markup has to reference them by @id, and two hand-written copies of the
  // same Organization is how a page ends up describing two publishers.
  const graph: unknown[] = [...siteGraphNodes()];
  const breadcrumb = buildBreadcrumb(pathname);
  if (breadcrumb) graph.push(breadcrumb);
  return stringifyJsonLd({
    "@context": "https://schema.org",
    "@graph": graph,
  });
}

/**
 * Per-section OG card copy, keyed by exact pathname (#8489).
 *
 * Previously nine entries against ~49 routes, with everything else falling
 * through to a bare "Metagraphed" — so /agents, /explorer, /chain/*, /events,
 * /blocks, /docs and most of the app unfurled IDENTICALLY to the home page.
 * This covers every real section so a shared link says what it is.
 *
 * A retired route gets no entry: #11613 folded /leaderboards, /revenue,
 * /domains and the two subnet facets into /subnets, and #11619 folded the four
 * /chain tabs into /chain. A 301 has nothing to unfurl.
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
  "/compare": {
    title: "Compare",
    subtitle: "Two or three subnets or validators, side by side",
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
  // #11625 removed /status's OG entry with the route: a retired URL gets no
  // social card, the same rule the four chain tabs followed in #11619.

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
  "/privacy": {
    title: "Privacy policy",
    subtitle: "What we collect, how long it is kept, and who else processes it",
    eyebrow: "Legal",
  },
  "/terms": {
    title: "Terms of use",
    subtitle: "What you can rely on, what you cannot, and fair use",
    eyebrow: "Legal",
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
      title: /^\d+$/.test(ref) ? `Block ${formatNumber(Number(ref))}` : shortKey(ref),
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
  // #11204: the machine-readable copy of THIS page. The site advertised its RSS
  // and Atom feeds this way and never advertised its own data, so a crawler
  // that had just read a subnet page had no typed pointer to the JSON record
  // behind it. One injection point covers every entity family and hub, rather
  // than six route files each having to remember.
  const apiRecord = apiRecordUrl(pathname);
  const apiAlternateTag = apiRecord
    ? `<link rel="alternate" type="application/json" href="${escapeHtmlAttr(apiRecord)}" title="Metagraphed API record for this page">`
    : "";
  // #8489: the three entity detail routes emit their own og:image in head(),
  // where loaderData is available and the card can carry real per-entity data.
  // Skipping them here is what keeps exactly ONE og:image tag on the page --
  // see routeOwnsOgImage's own comment for why ownership moved.
  const routeOwnsCard = routeOwnsOgImage(pathname);
  const ogCopy = ogCardCopy(pathname);
  const ogImage = buildOgImageUrl({ ...ogCopy, entity: false });
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
              if (apiAlternateTag) element.append(apiAlternateTag, { html: true });
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
    // env carries the ASSETS binding, which is how a card inlines the
    // registry's own cached logo for an entity -- see resolveLocalLogo.
    const ogResponse = await handleOgImage(request, env);
    if (ogResponse) return ogResponse;
    const artifactRedirect = handleArtifactHostRedirect(request);
    if (artifactRedirect) return artifactRedirect;
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
