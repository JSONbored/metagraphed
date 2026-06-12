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
