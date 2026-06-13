import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

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

// Resources the backend serves canonically — proxied verbatim from the API origin to the apex.
const DISCOVERY_PROXY_PATHS = new Set([
  "/.well-known/api-catalog",
  "/.well-known/mcp/server-card.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/security.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/agent.md",
]);

// RFC 8288 Link header advertising the API catalog + machine-readable descriptions, added to every
// HTML response (mirrors the backend's homepage Link header, with absolute API-origin targets).
const DISCOVERY_LINK_HEADER = [
  `<${API_ORIGIN}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${API_ORIGIN}/metagraph/openapi.json>; rel="service-desc"; type="application/json"`,
  `<${API_ORIGIN}/llms.txt>; rel="service-doc"; type="text/plain"`,
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
  "/schemas",
  "/gaps",
  "/about",
];

// Proxy a backend discovery resource to the apex, or build the sitemap. Returns null for everything
// else (the request falls through to the SSR app).
async function handleDiscovery(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/sitemap.xml") return buildSitemap();
  if (!DISCOVERY_PROXY_PATHS.has(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const upstream = await fetch(`${API_ORIGIN}${url.pathname}`, {
    headers: { accept: request.headers.get("accept") ?? "*/*" },
  });
  const headers = new Headers(upstream.headers);
  headers.set("x-discovery-origin", "api.metagraph.sh");
  return new Response(upstream.body, { status: upstream.status, headers });
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

// Inject the deferred tracker + a canonical link into <head> of HTML responses
// (streaming) and advertise the agent-discovery resources via an RFC 8288 Link
// header. Canonical is set HERE (not per-route) so it is global and authoritative:
// origin + path with the query stripped, so filter/sort permutations (e.g.
// /subnets?sort=health&health=down) consolidate to the one indexable URL instead
// of reading as duplicate content.
function injectAnalytics(response: Response, request: Request): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  const canonicalHref = `${SITE_ORIGIN}${new URL(request.url).pathname}`;
  const canonicalTag = `<link rel="canonical" href="${escapeHtmlAttr(canonicalHref)}">`;
  const transformed = new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(canonicalTag, { html: true });
        element.append(UMAMI_SNIPPET, { html: true });
      },
    })
    .transform(response);
  const headers = new Headers(transformed.headers);
  headers.set("link", DISCOVERY_LINK_HEADER);
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

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const statsResponse = await handleStatsProxy(request);
    if (statsResponse) return statsResponse;
    const discoveryResponse = await handleDiscovery(request);
    if (discoveryResponse) return discoveryResponse;
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
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
