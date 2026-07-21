import { CACHE_SECONDS, PRIMARY_DOMAIN } from "../../src/contracts.mjs";
import { errorResponse, ifNoneMatchSatisfied, weakEtag } from "../http.ts";
import { readArtifact, readHealthKv } from "../storage.ts";
import { contractVersion, publishedAt } from "../responses.ts";
import { KV_HEALTH_CURRENT } from "../../src/health-prober.mjs";
import { subnetBadgeStatus } from "../../src/health-serving.mjs";
import {
  listToolDefinitions,
  listPromptDefinitions,
  MCP_SERVER_INFO,
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSIONS,
  MCP_CAPABILITIES,
  MCP_REGISTRY_META,
  MCP_RESOURCE_TEMPLATES,
} from "../../src/mcp-server.mjs";
import { feedLinkHeader } from "../../src/feeds.mjs";
import {
  buildAgentToolsIndex,
  buildAnthropicToolSpecs,
  buildOpenAIToolSpecs,
} from "../../src/agent-tool-specs.mjs";

// Self-hosted SVG health badges for subnet READMEs, e.g.
// ![](https://api.metagraph.sh/metagraph/health/badges/7.svg) — no shields.io
// dependency, which drives backlinks/adoption. Rendered from the badge JSON
// artifact (label/message/color), degrading to a neutral "unavailable" badge.
export const BADGE_SVG_PATTERN = /^\/metagraph\/health\/badges\/(\d+)\.svg$/;
const BADGE_COLOR_HEX = {
  brightgreen: "#4c1",
  green: "#97ca00",
  yellowgreen: "#a4a61d",
  yellow: "#dfb317",
  orange: "#fe7d37",
  red: "#e05d44",
  blue: "#007ec6",
  lightgrey: "#9f9f9f",
  grey: "#555",
};
// Shields-style color for a health status (matches the build's badgeColor).
const BADGE_STATUS_COLOR = {
  ok: "brightgreen",
  degraded: "yellow",
  failed: "red",
  unknown: "lightgrey",
};

export async function handleBadgeSvgRequest(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      "method_not_allowed",
      "Badges only accept GET and HEAD.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }
  const netuid = BADGE_SVG_PATTERN.exec(url.pathname)[1];
  const artifact = await readArtifact(
    env,
    `/metagraph/health/badges/${netuid}.json`,
  );
  // Live overlay: prefer the fresh operational status from the 2-min cron
  // snapshot; fall back to the static badge artifact, then to "unavailable".
  const liveCurrent = await readHealthKv(env, KV_HEALTH_CURRENT);
  const liveStatus = subnetBadgeStatus(liveCurrent, Number(netuid));
  const available = Boolean(liveStatus || (artifact.ok && artifact.data));
  let badge;
  if (liveStatus) {
    badge = {
      label: `SN${netuid}`,
      message: liveStatus.status,
      color: BADGE_STATUS_COLOR[liveStatus.status] || "lightgrey",
    };
  } else if (artifact.ok && artifact.data) {
    badge = artifact.data;
  } else {
    badge = {
      label: `SN${netuid}`,
      message: "unavailable",
      color: "lightgrey",
    };
  }
  const svg = renderBadgeSvg(
    badge.label || `SN${netuid}`,
    badge.message || "unknown",
    badge.color || "lightgrey",
  );

  const headers = new Headers();
  headers.set("content-type", "image/svg+xml; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  // Real badges cache normally; the graceful fallback caches briefly so a
  // not-yet-published subnet badge recovers quickly.
  const maxAge = available ? CACHE_SECONDS.standard : CACHE_SECONDS.short;
  headers.set(
    "cache-control",
    `public, max-age=${maxAge}, stale-while-revalidate=300`,
  );
  headers.set("etag", await weakEtag(svg));
  if (ifNoneMatchSatisfied(request, headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : svg, {
    status: 200,
    headers,
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Approximate text width for the 11px Verdana shields font. textLength scales
// the glyphs to fit exactly, so the estimate only needs to look balanced.
function badgeTextWidth(text) {
  return Math.ceil(text.length * 6.5);
}

function renderBadgeSvg(rawLabel, rawMessage, color) {
  const label = escapeXml(rawLabel);
  const message = escapeXml(rawMessage);
  const hex = BADGE_COLOR_HEX[color] || BADGE_COLOR_HEX.lightgrey;
  const labelWidth = badgeTextWidth(rawLabel) + 10;
  const messageWidth = badgeTextWidth(rawMessage) + 10;
  const totalWidth = labelWidth + messageWidth;
  const labelMid = (labelWidth / 2) * 10;
  const messageMid = (labelWidth + messageWidth / 2) * 10;
  const labelLen = badgeTextWidth(rawLabel) * 10;
  const messageLen = badgeTextWidth(rawMessage) * 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${message}"><title>${label}: ${message}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="#555"/><rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${hex}"/><rect width="${totalWidth}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><text aria-hidden="true" x="${labelMid}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelLen}">${label}</text><text x="${labelMid}" y="140" transform="scale(.1)" textLength="${labelLen}">${label}</text><text aria-hidden="true" x="${messageMid}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${messageLen}">${message}</text><text x="${messageMid}" y="140" transform="scale(.1)" textLength="${messageLen}">${message}</text></g></svg>`;
}

// RFC 8288 Link header advertising the machine entrypoints, mirrored as
// `<link>` elements in the homepage HTML below. These discovery paths are also
// served on the apex (metagraph.sh) via zone routes, where origin-relative refs
// would resolve against metagraph.sh — the wrong host (the canonical API is
// api.metagraph.sh). So the Link header uses ABSOLUTE canonical refs, matching
// the authoritative RFC 9264 linkset body (which is already absolute). The
// relation set mirrors that body (service-desc, both service-doc targets,
// status, describedby) so an agent bootstrapping from the header alone sees the
// same entrypoints as the catalog.
const DISCOVERY_LINK_BASE = `https://${PRIMARY_DOMAIN}`;
const DISCOVERY_LINK_HEADER = [
  `<${DISCOVERY_LINK_BASE}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  `<${DISCOVERY_LINK_BASE}/metagraph/openapi.json>; rel="service-desc"; type="application/json"`,
  `<${DISCOVERY_LINK_BASE}/llms.txt>; rel="service-doc"; type="text/plain"`,
  `<${DISCOVERY_LINK_BASE}/agent.md>; rel="service-doc"; type="text/markdown"`,
  `<${DISCOVERY_LINK_BASE}/agent-workflows.md>; rel="service-doc"; type="text/markdown"`,
  `<${DISCOVERY_LINK_BASE}/health>; rel="status"; type="application/json"`,
  `<${DISCOVERY_LINK_BASE}/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"`,
  // Content feeds (#741) — registry changes, content-negotiated (json/rss/atom).
  feedLinkHeader(DISCOVERY_LINK_BASE),
].join(", ");

const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>metagraphed API — Bittensor subnet operational registry</title>
<meta name="description" content="Machine-readable operational + integration registry for Bittensor subnets: what each subnet exposes, whether it's healthy, and how to call it.">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0B1F1A">
<meta property="og:type" content="website">
<meta property="og:site_name" content="metagraphed">
<meta property="og:title" content="metagraphed API — Bittensor subnet operational registry">
<meta property="og:description" content="Machine-readable operational + integration registry for Bittensor subnets: what each subnet exposes, whether it's healthy, and how to call it.">
<meta property="og:url" content="https://${PRIMARY_DOMAIN}/">
<meta property="og:image" content="https://${PRIMARY_DOMAIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Metagraphed — Bittensor subnet operational layer · data hub · API">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://${PRIMARY_DOMAIN}/og.png">
<link rel="api-catalog" href="/.well-known/api-catalog" type="application/linkset+json">
<link rel="service-desc" href="/metagraph/openapi.json" type="application/json">
<link rel="service-doc" href="/llms.txt" type="text/plain">
<link rel="service-doc" href="/agent.md" type="text/markdown">
<link rel="service-doc" href="/agent-workflows.md" type="text/markdown">
<link rel="status" href="/health" type="application/json">
<link rel="describedby" href="/.well-known/mcp/server-card.json" type="application/json">
<link rel="alternate" href="/api/v1/feeds/registry.rss" type="application/rss+xml" title="metagraphed registry changes">
<link rel="alternate" href="/api/v1/feeds/registry.json" type="application/feed+json" title="metagraphed registry changes">
</head>
<body>
<main>
<h1>metagraphed API</h1>
<p>The operational + integration registry for Bittensor subnets — what each subnet exposes (APIs, docs, schemas), whether it's healthy, and how to call it. All endpoints are public, read-only JSON. No authentication.</p>
<ul>
<li><a href="/llms.txt">llms.txt</a> — LLM/agent discovery index</li>
<li><a href="/agent.md">agent.md</a> — copyable agent system prompt</li>
<li><a href="/agent-workflows.md">agent-workflows.md</a> — REST, MCP, npm, and Python workflows</li>
<li><a href="/metagraph/openapi.json">OpenAPI 3.1 contract</a></li>
<li><a href="/.well-known/api-catalog">API catalog</a> (RFC 9727 linkset)</li>
<li><a href="/.well-known/mcp/server-card.json">MCP server card</a> — <code>POST /mcp</code></li>
<li><a href="/.well-known/agent-skills/index.json">Agent Skills index</a></li>
<li><a href="/.well-known/agent-tools/index.json">Agent tool specs</a> — paste-ready OpenAI + Anthropic tools</li>
<li><a href="/api/v1/feeds/registry">Content feeds</a> — registry changes + incidents (RSS / Atom / JSON Feed)</li>
<li>Public RPC — load-balanced Bittensor RPC (read-only, health-checked, automatic failover): <code>wss://wss.metagraph.sh/finney</code> (mainnet) · <code>wss://wss.metagraph.sh/test</code> (testnet). Live pool: <a href="/api/v1/rpc/pools">/api/v1/rpc/pools</a></li>
<li><a href="/api/v1">REST API index</a> · <a href="/sitemap.xml">sitemap.xml</a> · <a href="/auth.md">auth.md</a></li>
<li><a href="https://metagraph.sh">metagraph.sh</a> — human web app</li>
</ul>
</main>
</body>
</html>
`;

// Shared headers for the worker-owned discovery surfaces: open CORS so agents
// can fetch cross-origin, the discovery Link header, and a public cache.
function discoveryHeaders(contentType) {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "cache-control",
    `public, max-age=${CACHE_SECONDS.static || 600}, stale-while-revalidate=300`,
  );
  headers.set("vary", "Accept-Encoding");
  headers.set("link", DISCOVERY_LINK_HEADER);
  return headers;
}

// Pre-serialized once per isolate — the catalog content depends only on the
// module-level PRIMARY_DOMAIN constant, so allocating + stringifying per
// request is redundant. ETag is lazy-memoized (weakEtag is async).
const CATALOG_BODY = (() => {
  const base = `https://${PRIMARY_DOMAIN}`;
  return `${JSON.stringify(
    {
      linkset: [
        {
          anchor: `${base}/api/v1`,
          "service-desc": [
            {
              href: `${base}/metagraph/openapi.json`,
              type: "application/json",
            },
          ],
          "service-doc": [
            { href: `${base}/llms.txt`, type: "text/plain" },
            { href: `${base}/agent.md`, type: "text/markdown" },
            { href: `${base}/agent-workflows.md`, type: "text/markdown" },
          ],
          status: [{ href: `${base}/health`, type: "application/json" }],
          describedby: [
            {
              href: `${base}/.well-known/mcp/server-card.json`,
              type: "application/json",
            },
            {
              href: `${base}/.well-known/agent-tools/index.json`,
              type: "application/json",
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
})();

let _homepageEtagPromise = null;
function getHomepageEtag() {
  if (!_homepageEtagPromise) _homepageEtagPromise = weakEtag(HOMEPAGE_HTML);
  return _homepageEtagPromise;
}

let _catalogEtagPromise = null;
function getCatalogEtag() {
  if (!_catalogEtagPromise) _catalogEtagPromise = weakEtag(CATALOG_BODY);
  return _catalogEtagPromise;
}

// api.metagraph.sh homepage: a small human/agent landing whose response carries
// the RFC 8288 Link headers (an agent can bootstrap from a single HEAD of `/`).
export async function homepageResponse(request) {
  const etag = await getHomepageEtag();
  const headers = discoveryHeaders("text/html; charset=utf-8");
  headers.set("etag", etag);
  if (ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(HOMEPAGE_HTML, { headers });
}

// RFC 9727 API catalog as an RFC 9264 linkset+json document. Hrefs point at the
// canonical API host (api.metagraph.sh) regardless of which host served this —
// the apex (metagraph.sh) routes /.well-known/* here too, and its catalog must
// reference the real API, not the apex.
export async function apiCatalogResponse(request) {
  const etag = await getCatalogEtag();
  const headers = discoveryHeaders("application/linkset+json");
  headers.set("etag", etag);
  if (ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(CATALOG_BODY, { headers });
}

// Stable deterministic JSON serializer (recursive key sort) — matches
// lib.mjs stableStringify so content_hash is identical to what the build
// script would produce for the same tool set.
function stableStringifyCard(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableStringifyCard).join(",")}]`;
  return (
    `{` +
    Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringifyCard(value[k])}`)
      .join(",") +
    `}`
  );
}
async function hashJsonCard(obj) {
  const bytes = new TextEncoder().encode(stableStringifyCard(obj));
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The MCP server card (SEP-1649) is now worker-computed from the live tool
// registry instead of being shipped as a committed static asset. This eliminates
// the committed content_hash churn that caused merge conflicts on every
// MCP-tool PR — two concurrent tool PRs both touched the file and the second
// always needed a rebase. `generated_at` is epoch-0 (the deterministic content
// marker per issue #349); `published_at` is overlaid from KV at serve time.
export async function mcpServerCardResponse(request, env) {
  const base = `https://${PRIMARY_DOMAIN}`;
  const serverCardContent = {
    schema_version: 1,
    serverInfo: {
      name: MCP_SERVER_INFO.name,
      version: MCP_SERVER_INFO.version,
    },
    name: MCP_SERVER_INFO.name,
    title: MCP_SERVER_INFO.title,
    description: MCP_INSTRUCTIONS,
    version: MCP_SERVER_INFO.version,
    repository: "https://github.com/JSONbored/metagraphed",
    documentation: `${base}/llms.txt`,
    endpoint: `${base}/mcp`,
    transport: "streamable-http",
    protocol_versions: MCP_PROTOCOL_VERSIONS,
    authentication: "none",
    capabilities: MCP_CAPABILITIES,
    _meta: MCP_REGISTRY_META,
    tools: listToolDefinitions(),
    resource_templates: MCP_RESOURCE_TEMPLATES,
    prompts: listPromptDefinitions(),
  };
  const pub = await publishedAt(env);
  const card = {
    ...serverCardContent,
    generated_at: new Date(0).toISOString(),
    published_at: pub || null,
    content_hash: await hashJsonCard(serverCardContent),
  };
  const body = `${JSON.stringify(card, null, 2)}\n`;
  const headers = discoveryHeaders("application/json");
  headers.set("etag", await weakEtag(body));
  if (ifNoneMatchSatisfied(request, headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

// Serve the OpenAI/Anthropic tool specs (and their index) computed live from
// listToolDefinitions(). No static asset + no API_ROUTES entry: like the
// api-catalog, these are worker-generated discovery documents whose body is
// derived from the canonical MCP tool list, so there is nothing to bake or keep
// in sync.
export async function agentToolsResponse(request, env, kind) {
  const tools = listToolDefinitions();
  const data =
    kind === "openai"
      ? buildOpenAIToolSpecs(tools)
      : kind === "anthropic"
        ? buildAnthropicToolSpecs(tools)
        : buildAgentToolsIndex(tools, {
            contractVersion: contractVersion(env),
          });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const headers = discoveryHeaders("application/json");
  headers.set("etag", await weakEtag(body));
  if (ifNoneMatchSatisfied(request, headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
