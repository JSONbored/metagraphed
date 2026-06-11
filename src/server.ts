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
  const isCollect = url.pathname.startsWith(`${STATS_PREFIX}/api/`);
  if (!isScript && !isCollect) return null;

  const upstreamUrl = `${UMAMI_HOST}${url.pathname.slice(STATS_PREFIX.length)}${url.search}`;

  if (isScript) {
    const upstream = await fetch(upstreamUrl, { headers: { accept: "*/*" } });
    const headers = new Headers(upstream.headers);
    // Long-lived browser cache; Cloudflare edge-caches the subrequest too.
    headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
    headers.delete("set-cookie");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Collect: forward only what Umami needs to attribute a real visit (UA +
  // visitor IP + language + content-type), not the full header set.
  const forwarded = new Headers();
  forwarded.set("content-type", request.headers.get("content-type") ?? "application/json");
  const userAgent = request.headers.get("user-agent");
  if (userAgent) forwarded.set("user-agent", userAgent);
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) forwarded.set("accept-language", acceptLanguage);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) {
    forwarded.set("x-forwarded-for", clientIp);
    forwarded.set("x-real-ip", clientIp);
  }

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: forwarded,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
  });
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Inject the deferred tracker into <head> of HTML responses (streaming).
function injectAnalytics(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(UMAMI_SNIPPET, { html: true });
      },
    })
    .transform(response);
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
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return injectAnalytics(normalized);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
