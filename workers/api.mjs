import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  CACHE_SECONDS,
  CONTRACT_VERSION,
  PRIMARY_DOMAIN,
  artifactPathFromTemplate,
  compileRoutePattern,
} from "../src/contracts.mjs";
import {
  artifactStorageTierForPath,
  ARTIFACT_STORAGE_TIERS,
} from "../src/artifact-storage.mjs";
import {
  buildChangeEvent,
  generateSecret,
  generateSubscriptionId,
  isValidSubscriptionId,
  publicSubscriptionView,
  subscriptionStorageKey,
  timingSafeEqual,
  validateSubscriptionInput,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/webhooks.mjs";
import {
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  pruneHealthHistory,
  rollupDailyUptime,
  runHealthProber,
  writeSubnetSnapshot,
} from "../src/health-prober.mjs";
import {
  buildGlobalHealth,
  formatIncidents,
  formatLeaderboards,
  formatPercentiles,
  formatTrajectory,
  formatTrends,
  formatUptime,
  INCIDENT_GAP_MS,
  LEADERBOARD_BOARDS,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayArtifactEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlayRpcPoolEligibility,
  overlaySubnetHealth,
  resolveLiveHealth,
  subnetBadgeStatus,
} from "../src/health-serving.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import {
  aiEnabled,
  askQuestion,
  runEmbeddingSync,
  semanticSearch,
  withinRateLimit,
} from "../src/ai-search.mjs";

// Cron schedule strings (must match wrangler.jsonc `triggers.crons`). The hourly
// trigger prunes the D1 time-series; every other trigger runs the 2-minute probe.
const HEALTH_PRUNE_CRON = "0 * * * *";
// Daily embedding-sync trigger (Worker-runtime, since CI has no AI bindings).
// Distinct minute (odd) so it never collides with the 2-minute probe or the
// top-of-hour prune. Must match a wrangler.jsonc `triggers.crons` entry.
const EMBEDDING_SYNC_CRON = "37 3 * * *";
// Trend windows for /api/v1/subnets/{netuid}/health/trends.
const RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN =
  /^\/metagraph\/health\/(?:latest\.json|summary\.json|subnets\/\d+\.json)$/;
const HEALTH_TREND_WINDOWS = { "7d": 7, "30d": 30 };
const TRENDS_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/health\/trends$/;
const PERCENTILES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/percentiles$/;
const INCIDENTS_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/health\/incidents$/;
const TRAJECTORY_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/trajectory$/;
const UPTIME_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/uptime$/;
const UPTIME_WINDOWS = { "90d": 90, "1y": 365 };
const MAX_UPTIME_ROWS = 10000;
const ANALYTICS_WINDOWS = { "7d": 7, "30d": 30 };
const ANALYTICS_WINDOW_PARAM = "window";
const MAX_INCIDENT_ROWS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const RAW_ARTIFACT_ROUTES = PUBLIC_ARTIFACTS.filter((entry) =>
  entry.path.endsWith(".json"),
).map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
}));

const ROUTES = API_ROUTES.map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
  artifactPath(params) {
    return artifactPathFromTemplate(entry.artifact_path, params);
  },
}));

// Read-only, bounded Substrate/Subtensor methods safe to expose through the
// public proxy. Deliberately excludes heavy/abusable reads (state_getMetadata,
// state_getStorage) and anything mutating — those stay blocked by the allowlist
// plus DENIED_RPC_PREFIXES.
const SAFE_RPC_METHODS = new Set([
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
]);
const DENIED_RPC_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
];
const MAX_RPC_BODY_BYTES = 65536;
const METAGRAPH_LATEST_KEY = "metagraph:latest";
const MAX_WEBHOOK_BODY_BYTES = 8192;
const MAX_ASK_BODY_BYTES = 4096;
const WEBHOOK_SUBSCRIPTION_TOKEN_HEADER =
  "x-metagraph-webhook-subscription-token";
// Dormant subscriptions self-clean after 180 days; the publish-time dispatcher
// refreshes the TTL on each successful delivery.
const WEBHOOK_TTL_SECONDS = 180 * 24 * 60 * 60;
const TRUSTED_RPC_UPSTREAM_ORIGINS = new Set([
  "https://archive.chain.opentensor.ai",
  "https://bittensor-finney.api.onfinality.io",
  "https://bittensor-public.nodies.app",
  "https://entrypoint-finney.opentensor.ai",
  "https://lite.chain.opentensor.ai",
  "wss://archive.chain.opentensor.ai",
  "wss://bittensor-finney.api.onfinality.io",
  "wss://entrypoint-finney.opentensor.ai",
  "wss://lite.chain.opentensor.ai",
]);

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return handleScheduled(controller, env, ctx);
  },
};

// Cron entrypoint. Cloudflare passes the exact cron string that fired in
// `controller.cron`; the hourly trigger prunes the time-series, every other
// trigger (the 2-minute one) runs a full operational-health probe sweep.
export async function handleScheduled(controller, env = {}, ctx = {}) {
  const cron = controller?.cron || "";
  if (cron === HEALTH_PRUNE_CRON) {
    // Roll the day's raw checks into the durable daily uptime table BEFORE
    // pruning, so long-term history is never lost when 30-day raw rows are
    // deleted (PR3). Then prune + snapshot.
    await rollupDailyUptime(env);
    const [pruned] = await Promise.all([
      pruneHealthHistory(env),
      writeSubnetSnapshot(env, { readArtifact }),
    ]);
    return pruned;
  }
  if (cron === EMBEDDING_SYNC_CRON) {
    return runEmbeddingSync(env, { readArtifact });
  }
  return runHealthProber(env, ctx);
}

export async function handleRequest(request, env = {}, ctx = {}) {
  let url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request);
  }

  // Multi-network addressing: an explicit /{network}/ prefix (mainnet/testnet/
  // local + finney/test aliases) routes through the network-aware artifact
  // handler. Bare paths fall through to the full dispatch below unchanged, so
  // mainnet behaviour is byte-identical to before networks existed.
  const networkRoute = resolveNetworkPrefix(url);
  if (networkRoute.explicit) {
    if (networkRoute.network.isDefault) {
      url = networkRoute.url;
      request = new Request(url.toString(), request);
    } else {
      return handleNetworkScopedRequest(
        request,
        env,
        networkRoute.url,
        networkRoute.network,
      );
    }
  }

  if (url.pathname.startsWith("/rpc/v1/")) {
    return handleRpcProxyRequest(request, env, url, ctx);
  }

  // Change-feed webhooks: subscription management accepts POST/DELETE/GET, so it
  // must run before the read-only method gate below (like the RPC proxy).
  if (url.pathname.startsWith("/api/v1/webhooks/")) {
    return handleWebhookRequest(request, env, url);
  }

  // Remote MCP server (stateless JSON-RPC over POST), for AI agents. Runs before
  // the read-only method gate (it is POST-only) like the RPC proxy. Artifact/KV
  // readers are injected so the MCP tools reuse the exact R2/ASSETS resolution.
  if (url.pathname === "/mcp") {
    return handleMcpRequest(request, env, { readArtifact, readHealthKv });
  }

  // Grounded RAG answer endpoint (POST). Runs before the read-only method gate
  // and degrades to 503 when the AI bindings/kill-switch are absent.
  if (url.pathname === "/api/v1/ask") {
    return handleAskRequest(request, env);
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      {
        allow: "GET, HEAD, OPTIONS",
      },
    );
  }

  // Agent/AI discovery surfaces. The homepage advertises the machine resources
  // via RFC 8288 Link headers; /.well-known/api-catalog is the RFC 9727 linkset.
  // Both are worker-owned (see wrangler `run_worker_first`) so they carry the
  // right headers/content-type instead of 404-ing through to the static assets.
  if (url.pathname === "/" || url.pathname === "") {
    return homepageResponse(request);
  }

  if (url.pathname === "/.well-known/api-catalog") {
    return apiCatalogResponse(request);
  }

  if (url.pathname === "/health") {
    return handleHealthRequest(request, env);
  }

  if (url.pathname === "/api/v1/events") {
    return handleEventsRequest(request, env);
  }

  // Semantic (vector) search over the registry. Special-handled (dynamic, not
  // artifact-backed) like /api/v1/events; degrades to 503 when AI is off.
  if (url.pathname === "/api/v1/search/semantic") {
    return handleSemanticSearchRequest(request, env, url);
  }

  // Registry leaderboards (D1 + registry projections; fileless-D1 pattern).
  if (url.pathname === "/api/v1/registry/leaderboards") {
    return handleLeaderboards(request, env, url);
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    const resolved = await resolveSubnetSlugRoute(env, url);
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}".`,
        404,
        { slug: resolved.slug },
      );
    }
    // D1-backed health trends (slug-aware after resolution). Special-handled
    // rather than artifact-backed, like /api/v1/events.
    const trendsMatch = TRENDS_PATH_PATTERN.exec(resolved.url.pathname);
    if (trendsMatch) {
      return handleHealthTrends(request, env, Number(trendsMatch[1]));
    }
    const percentilesMatch = PERCENTILES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (percentilesMatch) {
      return handleHealthPercentiles(
        request,
        env,
        Number(percentilesMatch[1]),
        resolved.url,
      );
    }
    const incidentsMatch = INCIDENTS_PATH_PATTERN.exec(resolved.url.pathname);
    if (incidentsMatch) {
      return handleHealthIncidents(
        request,
        env,
        Number(incidentsMatch[1]),
        resolved.url,
      );
    }
    const trajectoryMatch = TRAJECTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (trajectoryMatch) {
      return handleTrajectory(request, env, Number(trajectoryMatch[1]));
    }
    const uptimeMatch = UPTIME_PATH_PATTERN.exec(resolved.url.pathname);
    if (uptimeMatch) {
      return handleUptime(request, env, Number(uptimeMatch[1]), resolved.url);
    }
    return handleApiRequest(request, env, resolved.url);
  }

  if (BADGE_SVG_PATTERN.test(url.pathname)) {
    return handleBadgeSvgRequest(request, env, url);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url);
  }

  if (env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  return errorResponse(
    "not_found",
    "No static asset binding is configured for this route.",
    404,
  );
}

// Dynamic routes backed by mainnet-only D1/AI/curated data — not partitioned per
// network, so they 404 under a /{network}/ prefix rather than silently serving
// mainnet data. Mirrors the special-cased branches in handleRequest.
function isMainnetOnlyApiPath(pathname) {
  return (
    pathname === "/api/v1/events" ||
    pathname === "/api/v1/ask" ||
    pathname === "/api/v1/search/semantic" ||
    pathname === "/api/v1/registry/leaderboards" ||
    pathname.startsWith("/api/v1/webhooks/") ||
    TRENDS_PATH_PATTERN.test(pathname) ||
    PERCENTILES_PATH_PATTERN.test(pathname) ||
    INCIDENTS_PATH_PATTERN.test(pathname) ||
    TRAJECTORY_PATH_PATTERN.test(pathname) ||
    UPTIME_PATH_PATTERN.test(pathname)
  );
}

// Handles an explicit /{network}/-prefixed request (URL already prefix-stripped).
// Only the registry artifact surfaces are network-partitioned; dynamic/AI/live
// features stay mainnet-only. testnet/local data is R2-only and may not exist yet
// — readArtifact then returns a clean 404 carrying the requested network.
async function handleNetworkScopedRequest(request, env, url, network) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  // Local dev-mode: /api/v1/local returns the setup pointer (url is stripped, so
  // the network root is "/api/v1"); any data route under local is a clear no-data
  // 404 since metagraphed hosts nothing for a developer's local chain.
  if (network.id === "local") {
    if (url.pathname === "/api/v1") {
      return envelopeResponse(
        request,
        {
          data: LOCAL_NETWORK_INFO,
          meta: {
            network: "local",
            contract_version: contractVersion(env),
            source: "static",
          },
        },
        "short",
      );
    }
    return errorResponse(
      "not_found",
      "The local network is a client-side developer chain — metagraphed hosts no data for it. GET /api/v1/local for setup (point your SDK/RPC at ws://127.0.0.1:9944).",
      404,
      { network: "local" },
    );
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    if (isMainnetOnlyApiPath(url.pathname)) {
      return errorResponse(
        "not_found",
        `${url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    const resolved = await resolveSubnetSlugRoute(
      env,
      url,
      Date.now(),
      network,
    );
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}" on the ${network.id} network.`,
        404,
        { slug: resolved.slug, network: network.id },
      );
    }
    // Re-check after slug→netuid resolution: a slug-form per-subnet route (e.g.
    // /subnets/<slug>/health/trends) only reveals itself as a mainnet-only
    // dynamic route once the numeric netuid is filled in. Gate it explicitly
    // rather than relying on a downstream R2 miss.
    if (isMainnetOnlyApiPath(resolved.url.pathname)) {
      return errorResponse(
        "not_found",
        `${resolved.url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    return handleApiRequest(request, env, resolved.url, network);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url, network);
  }

  return errorResponse(
    "not_found",
    `No network-scoped route matched this path on the ${network.id} network.`,
    404,
    { network: network.id },
  );
}

async function handleRawArtifactRequest(
  request,
  env,
  url,
  network = DEFAULT_NETWORK,
) {
  if (!matchRawArtifact(url.pathname)) {
    return errorResponse(
      "not_found",
      "No public artifact contract matched this path.",
      404,
      {
        artifact_path: url.pathname,
      },
    );
  }

  const networkPath = artifactPathForNetwork(url.pathname, network);
  if (
    network.isDefault &&
    RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN.test(networkPath)
  ) {
    return errorResponse(
      "retired_artifact",
      "Current-state health artifacts are retired; use the live API health endpoints instead.",
      410,
      { artifact_path: networkPath },
    );
  }
  const artifact = await readArtifact(env, networkPath);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: networkPath,
    });
  }
  // Live per-endpoint health overlay: raw artifacts that embed the shared
  // EndpointResource list (endpoints.json, subnets/{n}.json, profiles/{n}.json,
  // provider endpoints) must not serve build-time operational health as fresh.
  // Overlay the 2-minute cron snapshot so direct /metagraph/*.json fetchers see
  // the same live status the /api/v1 routes do; surfaces with no live reading
  // read `unknown`. Mainnet-only (live store is mainnet) and gated to artifacts
  // that actually carry probed endpoints.
  let data = artifact.data;
  if (
    network.isDefault &&
    Array.isArray(data?.endpoints) &&
    data.endpoints.some((endpoint) => endpoint?.surface_id)
  ) {
    const liveSnapshot = await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    });
    data = overlayArtifactEndpoints(data, liveSnapshot) ?? data;
  }
  // The raw artifact path has no envelope, so direct fetchers of
  // /metagraph/*.json have no freshness signal — the body's generated_at is the
  // deterministic epoch content marker by design. Expose the real publish time
  // as a header; the operational-health fields are overlaid live (above).
  const pub = await publishedAt(env);
  const body = JSON.stringify(data);
  const headers = apiHeaders("standard");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-artifact-source", artifact.source);
  headers.set("x-metagraph-storage-tier", artifact.storage_tier);
  if (pub) {
    headers.set("x-metagraph-published-at", pub);
  }
  headers.set("etag", await weakEtag(body));
  if (request.headers.get("if-none-match") === headers.get("etag")) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

// Self-hosted SVG health badges for subnet READMEs, e.g.
// ![](https://api.metagraph.sh/metagraph/health/badges/7.svg) — no shields.io
// dependency, which drives backlinks/adoption. Rendered from the badge JSON
// artifact (label/message/color), degrading to a neutral "unavailable" badge.
const BADGE_SVG_PATTERN = /^\/metagraph\/health\/badges\/(\d+)\.svg$/;
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

async function handleBadgeSvgRequest(request, env, url) {
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
  if (request.headers.get("if-none-match") === headers.get("etag")) {
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

// Multi-network addressing (cosmos.directory-style). The friendly URL/UI segment
// (mainnet/testnet/local) maps to the chain-accurate value the data carries
// (finney/test/local) and to the R2 key prefix for non-default networks. Mainnet
// is the default: bare /api/v1/... and /metagraph/... resolve to it unprefixed,
// so every pre-network URL keeps working byte-for-byte. The chain names finney/
// test are accepted as aliases.
const NETWORKS = {
  mainnet: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  finney: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  testnet: {
    id: "testnet",
    chain: "test",
    prefix: "testnet",
    isDefault: false,
  },
  test: { id: "testnet", chain: "test", prefix: "testnet", isDefault: false },
  local: { id: "local", chain: "local", prefix: "local", isDefault: false },
};
const DEFAULT_NETWORK = NETWORKS.mainnet;

// `local` is a per-developer subtensor metagraphed cannot enumerate or host, so
// instead of registry data /api/v1/local returns the setup pointer: point your
// SDK/RPC at the local node and use mainnet/testnet here as the reference
// registry. (cosmos.directory similarly can't host a developer's local chain.)
const LOCAL_NETWORK_INFO = {
  network: "local",
  mode: "client-side",
  note: "Local is a per-developer subtensor you run yourself — metagraphed hosts no subnet data for it. Point your Bittensor SDK / RPC at your local node; use the mainnet and testnet registries here as the reference.",
  rpc: { ws: "ws://127.0.0.1:9944", network_arg: "local" },
  // The full develop-before-mainnet path (issue #354): stand up a local chain,
  // create a subnet on it, point your code at it, then graduate to testnet and
  // mainnet. Uses the official opentensor/subtensor localnet (it generates the
  // chain-spec + funded keys correctly) rather than a bespoke spec.
  quickstart: {
    summary:
      "Stand up a local Bittensor chain, create a subnet on it, and point your SDK at it — develop and test everything before you touch testnet or mainnet.",
    steps: [
      {
        step: 1,
        title: "Run a local chain",
        run: "git clone https://github.com/opentensor/subtensor && cd subtensor && ./scripts/localnet.sh --no-purge",
        detail:
          "Starts a local subtensor at ws://127.0.0.1:9944 with sudo, fast blocks, and pre-funded Alice/Bob keys (free TAO). First run compiles the node (needs the Rust toolchain + build deps).",
      },
      {
        step: 2,
        title: "Install the CLI + SDK",
        run: "pip install bittensor bittensor-cli",
        detail:
          "btcli drives chain operations; the bittensor SDK is what your miner/validator/app imports.",
      },
      {
        step: 3,
        title: "Fund a wallet + create a subnet on the local chain",
        run: "btcli wallet faucet --network local && btcli subnet create --network local",
        detail:
          "The faucet tops up free local TAO; subnet create registers a new netuid on your local chain (instant, free to iterate on).",
      },
      {
        step: 4,
        title: "Register + point your code at it",
        run: "btcli subnet register --netuid <N> --network local",
        detail:
          "Then in code: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')). Everything you'd do on mainnet works here first.",
      },
      {
        step: 5,
        title: "Graduate to testnet, then mainnet",
        run: "Re-run with --network test, then --network finney.",
        detail:
          "Use /api/v1/testnet/subnets as the testnet reference and the mainnet registry here as production; /api/v1/lineage tracks which testnet subnets have graduated to mainnet.",
      },
    ],
  },
  reference: {
    testnet_subnets: "/api/v1/testnet/subnets",
    mainnet_subnets: "/api/v1/subnets",
    lineage: "/api/v1/lineage",
  },
  setup: {
    sdk: "Python bittensor SDK: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')).",
    run_local_chain:
      "Run a local subtensor node (the Subtensor repo's localnet script) to expose ws://127.0.0.1:9944 with sudo + fast blocks and free TAO.",
  },
  guide: "/skills/bittensor/SKILL.md",
};
// Only an /api/v1/ or /metagraph/ path whose first segment is a known network
// alias is treated as network-scoped; real routes (subnets, providers, …) never
// collide with the alias set, so this never shadows an existing path.
const NETWORK_PREFIX_PATTERN =
  /^\/(api\/v1|metagraph)\/(mainnet|finney|testnet|test|local)(\/.*|$)/;

// Splits explicit /{network}/ prefixes off the path. Default-network aliases
// (mainnet/finney) are canonicalized iteratively so repeated aliases preserve
// the old bare-route dispatch without recursively re-entering handleRequest. If
// a non-default prefix remains after default alias normalization, it is returned
// for the network-scoped artifact handler. Bare paths resolve to mainnet with
// the URL unchanged (explicit:false) — the zero-regression default.
function resolveNetworkPrefix(url) {
  let rewritten = url;
  let explicit = false;

  while (true) {
    const match = NETWORK_PREFIX_PATTERN.exec(rewritten.pathname);
    if (!match) {
      return { network: DEFAULT_NETWORK, url: rewritten, explicit };
    }

    const network = NETWORKS[match[2]];
    const nextUrl = new URL(rewritten);
    nextUrl.pathname = `/${match[1]}${match[3] && match[3] !== "/" ? match[3] : ""}`;
    explicit = true;

    if (!network.isDefault) {
      return { network, url: nextUrl, explicit };
    }

    rewritten = nextUrl;
  }
}

// Inserts the network key segment for non-default networks, so the artifact read
// targets metagraph/{prefix}/...  (/metagraph/subnets.json + testnet ->
// /metagraph/testnet/subnets.json). Mainnet (prefix "") is a no-op.
function artifactPathForNetwork(artifactPath, network = DEFAULT_NETWORK) {
  if (!network || !network.prefix) {
    return artifactPath;
  }
  return artifactPath.replace(
    /^\/metagraph\//,
    `/metagraph/${network.prefix}/`,
  );
}

// Friendly per-subnet routes: /api/v1/subnets/<slug>/... resolves to the netuid
// (e.g. /api/v1/subnets/allways → /api/v1/subnets/7). Worker-only — the slug→
// netuid map is read from the served subnets.json and cached per isolate; no new
// committed artifact or route contract.
const SUBNET_SLUG_ROUTE_PATTERN = /^\/api\/v1\/subnets\/([^/]+)(\/.*)?$/;
const SUBNET_SLUG_INDEX_TTL_MS = 300_000;
// Per-network slug→netuid index, keyed by network.id (slugs/netuids differ across
// chains — testnet SN-N is unrelated to mainnet SN-N).
const subnetSlugIndexByNetwork = new Map(); // network.id -> { map, builtAt }

// Leaderboards re-derives a {meta, completeness} projection from the ~600 KB
// R2 profiles.json; cache the small projection in-isolate (5 min TTL, same as
// the slug index) so junk-query-param cache-busting can't force a full R2 read
// + parse per request.
const LEADERBOARD_PROFILES_TTL_MS = 300_000;
let leaderboardProfilesCache = null; // { subnetMeta, mostComplete, builtAt }

async function resolveSubnetSlugRoute(
  env,
  url,
  now = Date.now(),
  network = DEFAULT_NETWORK,
) {
  const match = SUBNET_SLUG_ROUTE_PATTERN.exec(url.pathname);
  // Not a per-subnet route, or already a numeric netuid → pass through.
  if (!match || /^\d+$/.test(match[1])) {
    return { url };
  }
  const slug = decodeSlugPathSegment(match[1]);
  if (slug === null) {
    return { notFound: true, slug: match[1] };
  }
  const netuid = await lookupSubnetNetuid(env, slug, now, network);
  if (netuid === null) {
    return { notFound: true, slug };
  }
  const rewritten = new URL(url);
  rewritten.pathname = `/api/v1/subnets/${netuid}${match[2] || ""}`;
  return { url: rewritten };
}

function decodeSlugPathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

async function lookupSubnetNetuid(
  env,
  slug,
  now = Date.now(),
  network = DEFAULT_NETWORK,
) {
  const cached = subnetSlugIndexByNetwork.get(network.id);
  if (!cached || now - cached.builtAt > SUBNET_SLUG_INDEX_TTL_MS) {
    const artifact = await readArtifact(
      env,
      artifactPathForNetwork("/metagraph/subnets.json", network),
    );
    if (artifact.ok && Array.isArray(artifact.data?.subnets)) {
      const map = new Map();
      // Curated slug is canonical — map it first for every subnet.
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          map.set(subnet.slug.toLowerCase(), subnet.netuid);
        }
      }
      // Then the chain-name native_slug (e.g. "apex") fills any key it doesn't
      // already own, so subnets resolve by the name agents discover them by —
      // essential on testnet, where there are no curated overlay slugs. A
      // curated slug always wins a collision, and duplicate native slugs are
      // suppressed so ambiguous aliases cannot resolve by artifact order.
      const nativeSlugCounts = new Map();
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          nativeSlugCounts.set(key, (nativeSlugCounts.get(key) || 0) + 1);
        }
      }
      for (const subnet of artifact.data.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          if (!map.has(key) && nativeSlugCounts.get(key) === 1) {
            map.set(key, subnet.netuid);
          }
        }
      }
      subnetSlugIndexByNetwork.set(network.id, { map, builtAt: now });
    } else if (!cached) {
      // Could not load the index and have no prior copy — leave unresolved.
      return null;
    }
  }
  const netuid = subnetSlugIndexByNetwork
    .get(network.id)
    ?.map.get(slug.toLowerCase());
  return Number.isInteger(netuid) ? netuid : null;
}

async function handleApiRequest(request, env, url, network = DEFAULT_NETWORK) {
  const matched = matchRoute(url.pathname);
  if (!matched) {
    return errorResponse("not_found", "No API route matched this path.", 404);
  }
  // Mainnet (default) reads the unprefixed artifact (no-op); non-default networks
  // read metagraph/{prefix}/… — see artifactPathForNetwork.
  const artifactPath = artifactPathForNetwork(matched.artifactPath, network);

  // Live operational-health overlay (Phase 3): current health is live-only.
  // Static current-health artifacts are not read for mainnet health routes, so
  // stale R2 objects left behind by earlier publishes cannot affect responses.
  let artifact;
  let live = null;
  if (!network.isDefault) {
    // Non-default networks serve only the static partitioned artifact; the live
    // KV/D1 health overlay is mainnet-only.
    artifact = await readArtifact(env, artifactPath);
  } else if (matched.id === "health") {
    // Live-only global operational health: KV health:current → D1
    // surface_status, and an explicit `unknown` global when the live store is
    // cold. There is no stored health summary to fall back to (live-only).
    const liveSnapshot = await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    });
    const liveData = liveSnapshot
      ? buildGlobalHealth(liveSnapshot, {
          contract_version: contractVersion(env),
        })
      : null;
    live = { data: liveData || unknownGlobalHealth(contractVersion(env)) };
    artifact = { ok: false };
  } else if (matched.id === "subnet-health") {
    artifact = { ok: false };
    live = await liveHealthOverlay(env, matched, null);
    // Per-subnet health is live-only too: never 404 on a cold store — serve an
    // explicit `unknown` payload instead of the (now absent) static artifact.
    if (!live) {
      live = { data: unknownSubnetHealth(Number(matched.params.netuid)) };
    }
  } else {
    artifact = await readArtifact(env, artifactPath);
    live = await liveHealthOverlay(
      env,
      matched,
      artifact.ok ? artifact.data : null,
    );
  }

  if (!artifact.ok && !live) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: artifactPath,
    });
  }

  const baseData = live ? live.data : artifact.data;
  const baseSource = live
    ? baseData?.health_source || "live-cron-prober"
    : artifact.source;

  const transformed = applyQueryFilters(
    baseData,
    url,
    matched.queryCollection,
    matched.queryFilterNames,
  );
  if (transformed.error) {
    return errorResponse("invalid_query", transformed.error.message, 400, {
      artifact_path: artifactPath,
      parameter: transformed.error.parameter,
    });
  }
  return envelopeResponse(
    request,
    {
      data: transformed.data,
      meta: {
        artifact_path: artifactPath,
        cache: matched.cache,
        contract_version: contractVersion(env),
        generated_at: baseData?.generated_at || null,
        // Real publish time from the KV latest pointer; null until a publish has
        // populated it. Unlike generated_at (a deterministic content marker),
        // this is safe to render as a human "last updated" timestamp.
        published_at: await publishedAt(env),
        source: baseSource,
        ...(baseData?.operational_observed_at
          ? { operational_observed_at: baseData.operational_observed_at }
          : {}),
        ...transformed.meta,
      },
    },
    matched.cache,
  );
}

// D1-backed 7d/30d uptime + latency trends for one subnet's operational
// surfaces. Returns a schema-stable empty payload when D1 is unbound/cold so it
// never errors (mirrors the live-overlay fall-back philosophy).
async function handleHealthTrends(request, env, netuid) {
  const db = env.METAGRAPH_HEALTH_DB;
  const nowMs = Date.now();
  const windows = {};
  for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
    let rows = [];
    if (db?.prepare) {
      try {
        const result = await db
          .prepare(
            `SELECT surface_id,
                    COUNT(*) AS total,
                    SUM(ok) AS ok_count,
                    AVG(latency_ms) AS avg_latency_ms
             FROM surface_checks
             WHERE netuid = ? AND checked_at >= ?
             GROUP BY surface_id`,
          )
          .bind(netuid, nowMs - days * DAY_MS)
          .all();
        rows = result?.results || [];
      } catch {
        rows = [];
      }
    }
    windows[label] = rows;
  }
  const meta = await readHealthKv(env, KV_HEALTH_META);
  const data = formatTrends({
    netuid,
    observedAt: meta?.last_run_at || null,
    windows,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: `/metagraph/health/trends/${netuid}.json`,
        cache: "short",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        published_at: await publishedAt(env),
        source: "live-cron-prober",
      },
    },
    "short",
  );
}

function analyticsWindow(url) {
  for (const key of url.searchParams.keys()) {
    if (key !== ANALYTICS_WINDOW_PARAM) {
      return {
        error: {
          parameter: key,
          message: `${key} is not supported for this route.`,
        },
      };
    }
  }

  const requested = url.searchParams.get(ANALYTICS_WINDOW_PARAM);
  if (requested !== null && !ANALYTICS_WINDOWS[requested]) {
    return {
      error: {
        parameter: ANALYTICS_WINDOW_PARAM,
        message: `${ANALYTICS_WINDOW_PARAM} is not supported for this route.`,
      },
    };
  }

  const label = requested || "7d";
  return { label, days: ANALYTICS_WINDOWS[label] };
}

function analyticsQueryError(error) {
  return errorResponse("invalid_query", error.message, 400, {
    parameter: error.parameter,
  });
}

async function d1All(env, sql, params) {
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return [];
  try {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all();
    return result?.results || [];
  } catch {
    return [];
  }
}

function analyticsMeta(env, artifactPath, observedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: observedAt,
    source: "live-cron-prober",
  };
}

// p50/p95/p99 latency percentiles per surface, computed in D1.
async function handleHealthPercentiles(request, env, netuid, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  const rows = await d1All(
    env,
    `WITH ranked AS (
       SELECT surface_id, latency_ms,
              ROW_NUMBER() OVER (PARTITION BY surface_id ORDER BY latency_ms) AS rn,
              COUNT(*) OVER (PARTITION BY surface_id) AS cnt
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ? AND latency_ms IS NOT NULL
     )
     SELECT surface_id,
            cnt AS samples,
            MAX(CASE WHEN rn = CAST(0.50 * cnt AS INTEGER) + 1 THEN latency_ms END) AS p50,
            MAX(CASE WHEN rn = CAST(0.95 * cnt AS INTEGER) + 1 THEN latency_ms END) AS p95,
            MAX(CASE WHEN rn = CAST(0.99 * cnt AS INTEGER) + 1 THEN latency_ms END) AS p99,
            AVG(latency_ms) AS avg_latency_ms,
            MIN(latency_ms) AS min_latency_ms,
            MAX(latency_ms) AS max_latency_ms
     FROM ranked
     GROUP BY surface_id`,
    [netuid, Date.now() - days * DAY_MS],
  );
  const meta = await readHealthKv(env, KV_HEALTH_META);
  const data = formatPercentiles({
    netuid,
    window: label,
    observedAt: meta?.last_run_at || null,
    rows,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: analyticsMeta(
        env,
        `/metagraph/health/percentiles/${netuid}.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// SLA + reconstructed downtime incidents per surface.
async function handleHealthIncidents(request, env, netuid, url) {
  const { label, days, error } = analyticsWindow(url);
  if (error) return analyticsQueryError(error);
  const since = Date.now() - days * DAY_MS;
  const [slaRows, incidentRows] = await Promise.all([
    d1All(
      env,
      `SELECT surface_id, COUNT(*) AS total, SUM(ok) AS ok_count
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ?
       GROUP BY surface_id`,
      [netuid, since],
    ),
    // Gap-island grouping in SQL: collapse consecutive failures (gap <= the
    // incident threshold) into one incident row, then cap the public payload so
    // flapping endpoints cannot force unbounded result sets/responses.
    d1All(
      env,
      `WITH failures AS (
         SELECT surface_id, checked_at,
                checked_at - LAG(checked_at)
                  OVER (PARTITION BY surface_id ORDER BY checked_at) AS gap
         FROM surface_checks
         WHERE netuid = ? AND checked_at >= ? AND ok = 0
       ),
       grouped AS (
         SELECT surface_id, checked_at,
                SUM(CASE WHEN gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                  OVER (PARTITION BY surface_id ORDER BY checked_at) AS grp
         FROM failures
       )
       SELECT surface_id,
              MIN(checked_at) AS started_at,
              MAX(checked_at) AS ended_at,
              COUNT(*) AS failed_samples
       FROM grouped
       GROUP BY surface_id, grp
       ORDER BY surface_id, started_at
       LIMIT ?`,
      [netuid, since, INCIDENT_GAP_MS, MAX_INCIDENT_ROWS],
    ),
  ]);
  const meta = await readHealthKv(env, KV_HEALTH_META);
  const data = formatIncidents({
    netuid,
    window: label,
    observedAt: meta?.last_run_at || null,
    slaRows,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: analyticsMeta(
        env,
        `/metagraph/health/incidents/${netuid}.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Week-over-week structural trajectory from daily snapshots.
async function handleTrajectory(request, env, netuid) {
  // Keep the most-recent window (DESC) — formatTrajectory re-sorts ascending.
  // ASC + LIMIT would freeze on the oldest 400 days once history exceeds the cap.
  const rows = await d1All(
    env,
    `SELECT snapshot_date, completeness_score, surface_count, endpoint_count
     FROM subnet_snapshots
     WHERE netuid = ?
     ORDER BY snapshot_date DESC
     LIMIT 400`,
    [netuid],
  );
  const data = formatTrajectory({ netuid, rows });
  return envelopeResponse(
    request,
    {
      data,
      meta: analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/trajectory.json`,
        null,
      ),
    },
    "short",
  );
}

// Long-term daily uptime history for one subnet's operational surfaces, served
// live from the surface_uptime_daily rollup (PR3). 90d/1y window. Returns a
// schema-stable empty payload when D1 is unbound/cold or no history has accrued
// yet (mirrors the other D1-backed analytics routes).
async function handleUptime(request, env, netuid, url) {
  const windowParam = url.searchParams.get("window") || "90d";
  const days = UPTIME_WINDOWS[windowParam];
  if (!days) {
    return errorResponse(
      "invalid_query",
      "Query parameter `window` must be one of: 90d, 1y.",
      400,
      { parameter: "window" },
    );
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await d1All(
    env,
    `SELECT surface_id, day, samples, ok_count, uptime_ratio, avg_latency_ms, status
     FROM surface_uptime_daily
     WHERE netuid = ? AND day >= ?
     ORDER BY day DESC
     LIMIT ?`,
    [netuid, cutoff, MAX_UPTIME_ROWS],
  );
  const data = formatUptime({ netuid, window: windowParam, rows });
  return envelopeResponse(
    request,
    {
      data,
      meta: analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/uptime.json`,
        null,
      ),
    },
    "short",
  );
}

// Small {meta, completeness} projection over profiles.json, cached in-isolate.
async function leaderboardProfilesProjection(env, now = Date.now()) {
  if (
    leaderboardProfilesCache &&
    now - leaderboardProfilesCache.builtAt <= LEADERBOARD_PROFILES_TTL_MS
  ) {
    return leaderboardProfilesCache;
  }
  const artifact = await readArtifact(env, "/metagraph/profiles.json");
  const profiles = artifact.ok ? artifact.data?.profiles || [] : [];
  const subnetMeta = new Map();
  const mostComplete = [];
  for (const profile of profiles) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid, {
      slug: profile.slug ?? null,
      name: profile.name ?? null,
    });
    mostComplete.push({
      netuid: profile.netuid,
      slug: profile.slug ?? null,
      name: profile.name ?? null,
      completeness_score: profile.completeness_score ?? null,
    });
  }
  const projection = { subnetMeta, mostComplete, builtAt: now };
  // Don't cache an empty projection (failed/cold read) — retry next request.
  if (mostComplete.length > 0) {
    leaderboardProfilesCache = projection;
  }
  return projection;
}

// Registry leaderboards: healthiest / fastest-rpc / most-complete /
// fastest-growing. Combines live D1 status with registry projections.
async function handleLeaderboards(request, env, url) {
  const requestedBoard = url.searchParams.get("board");
  if (requestedBoard && !LEADERBOARD_BOARDS.includes(requestedBoard)) {
    return errorResponse(
      "invalid_query",
      `Unknown board "${requestedBoard}". Valid boards: ${LEADERBOARD_BOARDS.join(", ")}.`,
      400,
    );
  }
  const limit = url.searchParams.get("limit");

  const { subnetMeta, mostComplete } = await leaderboardProfilesProjection(env);

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples] = await Promise.all([
    d1All(
      env,
      `SELECT netuid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              AVG(latency_ms) AS avg_latency_ms
       FROM surface_status
       GROUP BY netuid`,
      [],
    ),
    d1All(
      env,
      `SELECT netuid, MIN(latency_ms) AS min_latency_ms
       FROM surface_status
       WHERE kind IN ('subtensor-rpc', 'subtensor-wss')
         AND status = 'ok' AND latency_ms IS NOT NULL
       GROUP BY netuid`,
      [],
    ),
    d1All(
      env,
      `SELECT netuid, snapshot_date, completeness_score
       FROM subnet_snapshots
       WHERE snapshot_date >= ?
       ORDER BY netuid, snapshot_date`,
      [sevenDaysAgo],
    ),
  ]);

  // Per-subnet completeness delta over the window (latest - earliest sample).
  const growthByNetuid = new Map();
  for (const row of growthSamples) {
    const entry = growthByNetuid.get(row.netuid) || {
      first: undefined,
      last: undefined,
    };
    // `undefined` = no row yet; a real null completeness_score must latch as the
    // baseline so the delta guard below can drop unscored window endpoints.
    if (entry.first === undefined) entry.first = row.completeness_score ?? null;
    entry.last = row.completeness_score ?? null;
    growthByNetuid.set(row.netuid, entry);
  }
  const growthRows = [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));

  const meta = await readHealthKv(env, KV_HEALTH_META);
  const data = formatLeaderboards({
    board: requestedBoard || null,
    limit,
    observedAt: meta?.last_run_at || null,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows,
    subnetMeta,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: {
        artifact_path: "/metagraph/registry/leaderboards.json",
        cache: "standard",
        contract_version: contractVersion(env),
        generated_at: data.observed_at,
        source: "registry+live-cron-prober",
      },
    },
    "standard",
  );
}

async function handleRpcProxyRequest(request, env, url, ctx = {}) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "The RPC proxy only accepts POST requests.",
      405,
      {},
      {
        allow: "POST, OPTIONS",
      },
    );
  }

  if (env.METAGRAPH_ENABLE_RPC_PROXY !== "true") {
    return errorResponse(
      "rpc_proxy_disabled",
      "Read-only RPC proxying is intentionally disabled until endpoint scoring, abuse controls, and method filtering are enabled.",
      501,
    );
  }

  // Per-client abuse control. Skipped when the ratelimit binding is absent
  // (local dev / not yet provisioned) so tests and local runs are unaffected;
  // enforced on Cloudflare where the binding is bound.
  if (env.RPC_RATE_LIMITER?.limit) {
    const clientKey =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      "anonymous";
    const { success } = await env.RPC_RATE_LIMITER.limit({ key: clientKey });
    if (!success) {
      return errorResponse(
        "rpc_rate_limited",
        "Too many RPC proxy requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(RPC_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(RPC_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_RPC_BODY_BYTES) {
    return errorResponse(
      "rpc_body_too_large",
      "RPC request body is too large for the read-only proxy.",
      413,
    );
  }

  let bodyText;
  let rpcBody;
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "rpc_body_too_large",
        "RPC request body is too large for the read-only proxy.",
        413,
      );
    }
    rpcBody = JSON.parse(bodyText);
  } catch {
    return errorResponse(
      "rpc_invalid_json",
      "RPC request body must be a JSON object.",
      400,
    );
  }

  if (
    !rpcBody ||
    Array.isArray(rpcBody) ||
    typeof rpcBody !== "object" ||
    typeof rpcBody.method !== "string"
  ) {
    return errorResponse(
      "rpc_invalid_request",
      "Only single JSON-RPC request objects are supported.",
      400,
    );
  }

  if (!isSafeRpcMethod(rpcBody.method)) {
    return errorResponse(
      "rpc_method_blocked",
      `RPC method is not allowed through this proxy: ${rpcBody.method}`,
      403,
      {
        allowed_methods: [...SAFE_RPC_METHODS].sort(),
      },
    );
  }

  const poolArtifact = await readArtifact(env, "/metagraph/rpc/pools.json");
  if (!poolArtifact.ok) {
    return errorResponse(
      poolArtifact.code,
      poolArtifact.message,
      poolArtifact.status,
      {
        artifact_path: "/metagraph/rpc/pools.json",
      },
    );
  }

  // The proxy forwards an HTTP JSON-RPC POST, so it can only reach HTTP(S)
  // upstreams. The /wss route points at WebSocket-only endpoints that cannot be
  // HTTP-POSTed, so reject it with a clear error instead of failing the upstream
  // fetch (which would surface as a 500).
  if (url.pathname.endsWith("/wss")) {
    return errorResponse(
      "rpc_websocket_unsupported",
      "WebSocket JSON-RPC is not available through this HTTP proxy. POST to /rpc/v1/finney for HTTP JSON-RPC, or connect to a public WSS endpoint directly.",
      400,
    );
  }
  const poolId = "finney-rpc";
  const staticPool = (poolArtifact.data.pools || []).find(
    (candidate) => candidate.id === poolId,
  );
  // Overlay the 2-minute cron health so the proxy avoids sustained-down endpoints
  // (the in-isolate breaker still handles instantaneous failures). Falls back to
  // the static pool when the live snapshot is cold.
  const liveRpcPool = await readHealthKv(env, KV_HEALTH_RPC_POOL);
  const pool = overlayRpcPoolEligibility(staticPool, liveRpcPool);
  const { endpoints: candidates, unsafeEndpoint } = orderSafeRpcEndpoints(pool);
  if (!candidates.length) {
    if (unsafeEndpoint) {
      return errorResponse(
        "rpc_endpoint_unsafe",
        "Eligible RPC endpoint URL is not allowed by the Worker upstream safety policy.",
        502,
        { endpoint_id: unsafeEndpoint.id || null, pool_id: poolId },
      );
    }
    return errorResponse(
      "rpc_endpoint_unavailable",
      "No eligible public RPC endpoint is available for proxy routing.",
      503,
      { pool_id: poolId },
    );
  }

  // Response cache for idempotent reads (Cache API). Cache hit short-circuits
  // the upstream call; a successful, cacheable response is stored async.
  const cachePolicy = rpcCachePolicy(rpcBody.method, rpcBody.params);
  const cache = cachePolicy.cacheable ? globalThis.caches?.default : null;
  let cacheKey = null;
  if (cache) {
    cacheKey = await rpcCacheKey(rpcBody.method, rpcBody.params);
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Only the JSON-RPC `result` is cached (never caller-controlled envelope
      // fields like `id`), so rebuild the envelope with THIS request's id. This
      // stops a cache entry primed by one caller from replaying that caller's id
      // back to a later requester.
      let cachedPayload = null;
      try {
        cachedPayload = JSON.parse(await hit.text());
      } catch {
        // Malformed cache entry; treat as a miss and re-fetch below.
      }
      if (cachedPayload && cachedPayload.result !== undefined) {
        const headers = new Headers(hit.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-metagraph-rpc-cache", "hit");
        setRpcRateLimitHeaders(headers);
        return new Response(
          JSON.stringify(rpcResultEnvelope(rpcBody, cachedPayload.result)),
          { status: 200, headers },
        );
      }
    }
  }

  const response = await proxyWithFailover(candidates, { bodyText, poolId });
  if (!cacheKey) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("x-metagraph-rpc-cache", "miss");
  if (response.status !== 200) {
    return new Response(response.body, { status: response.status, headers });
  }

  // Cacheable method, cache miss: inspect a bounded clone so oversized upstream
  // results are streamed back to the client instead of buffered in the Worker.
  let inspect;
  try {
    inspect = await readResponseTextWithLimit(
      response.clone(),
      RPC_CLASSIFY_BODY_LIMIT_BYTES,
    );
  } catch {
    // Classification is best-effort: a flaky upstream body should not turn a
    // proxied response into a Worker exception while cache inspection is active.
    return new Response(response.body, { status: response.status, headers });
  }
  if (!inspect.truncated) {
    let parsed = null;
    try {
      parsed = JSON.parse(inspect.text);
    } catch {
      // body is not JSON; leave parsed null so it is not cached.
    }
    if (parsed && parsed.result !== undefined && parsed.error === undefined) {
      // Persist ONLY the cacheable `result` — not the upstream envelope, which
      // carries the priming caller's `id`. The envelope is rebuilt per request
      // on a cache hit above.
      const cached = new Response(JSON.stringify({ result: parsed.result }), {
        status: 200,
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          "cache-control": `public, s-maxage=${cachePolicy.ttl}`,
        },
      });
      ctx?.waitUntil?.(cache.put(cacheKey, cached));
    }
  }
  return new Response(response.body, { status: response.status, headers });
}

const RPC_MAX_ATTEMPTS = 3;
const RPC_ATTEMPT_TIMEOUT_MS = 6000;
const RPC_CLASSIFY_BODY_LIMIT_BYTES = 64 * 1024;

// JSON-RPC error codes that signal node trouble (retry another upstream) rather
// than a client/application error (return immediately so we don't mask a real
// error by trying every node).
const TRANSIENT_RPC_ERROR_CODES = new Set([-32603]); // internal error

// In-isolate circuit breaker: count consecutive transient failures per endpoint
// and temporarily eject (deprioritise) repeat offenders. Per-isolate only (no
// global view, resets on cold start) — cheap and enough to ride out the burst
// that matters. RPC_HEALTH is the module-default map; injectable for tests.
const RPC_HEALTH = new Map(); // endpointId -> { fails, ejectedUntil }
const RPC_EJECT_THRESHOLD = 3;
const RPC_EJECT_COOLDOWN_MS = 30_000;

export function recordRpcFailure(map, id, now) {
  const entry = map.get(id) || { fails: 0, ejectedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= RPC_EJECT_THRESHOLD) {
    entry.ejectedUntil = now + RPC_EJECT_COOLDOWN_MS;
  }
  map.set(id, entry);
}

export function recordRpcSuccess(map, id) {
  map.delete(id);
}

export function isRpcEndpointEjected(map, id, now) {
  const entry = map.get(id);
  return Boolean(entry && entry.ejectedUntil > now);
}

// Per-method response-cache policy for idempotent reads. Default-deny: only
// block-pinned (by an explicit block number/hash param) or quasi-static reads
// are cacheable; head-moving forms (param-less block reads, finalized head,
// system_health) are never cached.
export function rpcCachePolicy(method, params) {
  const args = Array.isArray(params) ? params : [];
  switch (method) {
    case "chain_getBlockHash":
      return args.length &&
        (typeof args[0] === "number" || /^\d+$/.test(String(args[0])))
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "chain_getBlock":
    case "chain_getHeader":
      return args.length &&
        typeof args[0] === "string" &&
        args[0].startsWith("0x")
        ? { cacheable: true, ttl: 3600 }
        : { cacheable: false, ttl: 0 };
    case "state_getRuntimeVersion":
    case "system_chain":
    case "system_name":
    case "system_version":
    case "system_properties":
    case "rpc_methods":
      return { cacheable: true, ttl: 300 };
    default:
      return { cacheable: false, ttl: 0 };
  }
}

// Build a minimal JSON-RPC success envelope around a cached `result`, echoing
// the current request's `id` (when present) so cache hits never replay another
// caller's id.
function rpcResultEnvelope(requestBody, result) {
  const envelope = { jsonrpc: "2.0" };
  if (Object.prototype.hasOwnProperty.call(requestBody, "id")) {
    envelope.id = requestBody.id;
  }
  envelope.result = result;
  return envelope;
}

async function rpcCacheKey(method, params) {
  const normalized = JSON.stringify([
    method,
    Array.isArray(params) ? params : [],
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(
    `https://rpc-cache.metagraph.internal/finney/${method}/${hash}`,
  );
}

// Decide how to treat one upstream attempt: "transient" (fail over to the next
// endpoint), "success"/"fatal" (return this upstream's response to the client).
export function classifyUpstreamAttempt({ thrown, status, parsedBody }) {
  if (thrown) return "transient"; // network error or AbortSignal timeout
  if (status >= 500 || status === 429) return "transient";
  if (status >= 400) return "fatal"; // upstream rejected the request itself
  if (parsedBody && typeof parsedBody === "object" && parsedBody.error) {
    if (TRANSIENT_RPC_ERROR_CODES.has(Number(parsedBody.error.code))) {
      return "transient";
    }
  }
  return "success";
}

async function readResponseTextWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: new TextEncoder().encode(text).byteLength > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {});
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

function streamRpcResponse(upstream, endpoint, attempts, status) {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-rpc-endpoint-id", endpoint.id);
  headers.set("x-metagraph-rpc-provider", endpoint.provider);
  headers.set("x-metagraph-rpc-attempts", String(attempts.length + 1));
  setRpcRateLimitHeaders(headers);
  return new Response(upstream.body, { status: status || 502, headers });
}

// Advisory rate-limit headers on RPC proxy responses. The Cloudflare rate-limit
// binding (RPC_RATE_LIMITER) only returns {success}, so an exact remaining/reset
// is unavailable — we surface the static policy (mirrors wrangler.jsonc:
// 100 requests / 60s) plus Retry-After on a 429.
const RPC_RATE_LIMIT = { limit: 100, windowSeconds: 60 };
function setRpcRateLimitHeaders(headers) {
  headers.set("x-ratelimit-limit", String(RPC_RATE_LIMIT.limit));
  headers.set(
    "x-ratelimit-policy",
    `${RPC_RATE_LIMIT.limit};w=${RPC_RATE_LIMIT.windowSeconds}`,
  );
}

// Try each ordered endpoint in turn; return the first success / non-transient
// response, and a clean 502 only when every attempt is a transient failure.
// Transient HTTP statuses are classified before reading bodies, and JSON-RPC
// error-envelope inspection is bounded so large upstream responses can stream.
export async function proxyWithFailover(
  orderedEndpoints,
  {
    bodyText,
    poolId,
    fetchFn = fetch,
    maxAttempts = RPC_MAX_ATTEMPTS,
    timeoutMs = RPC_ATTEMPT_TIMEOUT_MS,
    healthMap = RPC_HEALTH,
  },
) {
  const attempts = [];
  const limit = Math.min(orderedEndpoints.length, maxAttempts);
  for (let index = 0; index < limit; index += 1) {
    const endpoint = orderedEndpoints[index];
    let status = 0;
    let upstream = null;
    let parsedBody = null;
    let thrown = false;
    try {
      upstream = await fetchFn(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = upstream.status;
    } catch {
      thrown = true;
    }

    if (
      classifyUpstreamAttempt({ thrown, status, parsedBody }) === "transient"
    ) {
      await upstream?.body?.cancel?.();
      recordRpcFailure(healthMap, endpoint.id, Date.now());
      attempts.push({
        endpoint_id: endpoint.id,
        reason: thrown ? "unreachable" : `status-${status}`,
      });
      continue;
    }

    if (upstream && status < 400) {
      let clientBodyToCancel = null;
      try {
        if (upstream.body?.tee) {
          const [inspectBody, clientBody] = upstream.body.tee();
          clientBodyToCancel = clientBody;
          const inspect = await readResponseTextWithLimit(
            new Response(inspectBody),
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              await clientBody.cancel();
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(clientBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        } else {
          const inspect = await readResponseTextWithLimit(
            upstream,
            RPC_CLASSIFY_BODY_LIMIT_BYTES,
          );
          if (!inspect.truncated) {
            try {
              parsedBody = JSON.parse(inspect.text);
            } catch {
              parsedBody = null;
            }
            if (
              classifyUpstreamAttempt({ thrown, status, parsedBody }) ===
              "transient"
            ) {
              recordRpcFailure(healthMap, endpoint.id, Date.now());
              attempts.push({
                endpoint_id: endpoint.id,
                reason: `status-${status}`,
              });
              continue;
            }
          }
          upstream = new Response(inspect.text, {
            status,
            headers: upstream.headers,
          });
        }
      } catch {
        await clientBodyToCancel?.cancel?.().catch(() => {});
        await upstream?.body?.cancel?.().catch(() => {});
        recordRpcFailure(healthMap, endpoint.id, Date.now());
        attempts.push({
          endpoint_id: endpoint.id,
          reason: "body-read-error",
        });
        continue;
      }
    }

    // The endpoint responded (success, or an application-level error) — it is
    // reachable, so clear any breaker state for it.
    recordRpcSuccess(healthMap, endpoint.id);
    return streamRpcResponse(upstream, endpoint, attempts, status);
  }

  // Every attempt failed transiently. Return a fixed message — never echo an
  // upstream error body (leak hygiene).
  return errorResponse(
    "rpc_upstream_unavailable",
    "All eligible RPC upstreams failed; try again shortly.",
    502,
    {
      pool_id: poolId,
      attempts: attempts.map((a) => a.endpoint_id),
      last_reason: attempts.at(-1)?.reason || null,
    },
  );
}

function matchRawArtifact(pathname) {
  return RAW_ARTIFACT_ROUTES.some((candidate) =>
    candidate.pattern.test(pathname),
  );
}

function matchRoute(pathname) {
  for (const candidate of ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params = match.groups || {};
    return {
      id: candidate.id,
      artifactPath: candidate.artifactPath(params),
      cache: candidate.cache,
      params,
      queryCollection: candidate.query_collection,
      queryFilterNames: candidate.query_filter_names,
    };
  }
  return null;
}

const DEFAULT_R2_TIMEOUT_MS = 5000;

// Structured log captured by Workers observability. Only called on notable
// non-happy paths (R2 timeout, static fallback) so it does not spam logs.
// Disabled with METAGRAPH_DISABLE_REQUEST_LOGS=true.
function logEvent(env, level, event, fields = {}) {
  if (env.METAGRAPH_DISABLE_REQUEST_LOGS === "true") {
    return;
  }
  try {
    console.log(JSON.stringify({ level, event, ...fields }));
  } catch {
    // Never let logging break a request.
  }
}

function r2TimeoutMs(env) {
  const raw = Number(env.METAGRAPH_R2_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_R2_TIMEOUT_MS;
}

// R2's get() takes no AbortSignal, so bound it with a race: a slow/degraded
// bucket yields a controlled 504 (and static fallback where allowed) instead of
// hanging the request until the platform wall-clock limit.
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Lightweight readiness probe for uptime checks and load balancers. Reports
// which bindings are wired without touching R2/KV (no I/O, no cold-start cost).
async function handleHealthRequest(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      "method_not_allowed",
      "The health route only accepts GET and HEAD.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  const bindings = {
    assets: Boolean(env.ASSETS?.fetch),
    r2: Boolean(env.METAGRAPH_ARCHIVE?.get),
    kv: Boolean(env.METAGRAPH_CONTROL?.get),
    health_db: Boolean(env.METAGRAPH_HEALTH_DB?.prepare),
  };

  // Data freshness — the scheduled refresh (ADR 0001) advances the KV `latest`
  // pointer's published_at every ~6h. If that pipeline silently stops, the
  // pointer goes stale; report `degraded` + HTTP 503 so an uptime monitor
  // pointed at /health catches a broken data-refresh. Only a *present* stale
  // pointer trips it, so local/dev and the worker-test harness (no published
  // pointer) stay healthy.
  const maxAgeHours = Number(env.METAGRAPH_HEALTH_MAX_AGE_HOURS) || 12;
  // Read the publish pointer + the operational-health meta concurrently (one
  // round-trip instead of two) — both are independent KV gets.
  const [pointer, meta] = bindings.kv
    ? await Promise.all([latestPointer(env), readHealthKv(env, KV_HEALTH_META)])
    : [null, null];
  const publishedAtIso =
    pointer && typeof pointer.published_at === "string"
      ? pointer.published_at
      : null;
  const publishedMs = publishedAtIso ? Date.parse(publishedAtIso) : NaN;
  const ageHours = Number.isFinite(publishedMs)
    ? (Date.now() - publishedMs) / 3_600_000
    : null;
  const stale = ageHours !== null && ageHours > maxAgeHours;

  // Operational-health freshness — the 2-minute cron prober's last run. Reported
  // for observability (a stuck prober shows a growing age); does not gate the
  // HTTP status here (Phase 4 wires alerting). Null until the first cron run.
  const opRunAtMs = meta?.last_run_at ? Date.parse(meta.last_run_at) : NaN;
  const opAgeMinutes = Number.isFinite(opRunAtMs)
    ? (Date.now() - opRunAtMs) / 60_000
    : null;

  const body = JSON.stringify({
    status: stale ? "degraded" : "ok",
    service: "metagraphed",
    contract_version: contractVersion(env),
    rpc_proxy_enabled: env.METAGRAPH_ENABLE_RPC_PROXY === "true",
    bindings,
    freshness: {
      published_at: publishedAtIso,
      age_hours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
      max_age_hours: maxAgeHours,
      stale,
    },
    operational_health: {
      last_run_at: meta?.last_run_at || null,
      age_minutes:
        opAgeMinutes === null ? null : Math.round(opAgeMinutes * 100) / 100,
      probed_count: meta?.probed_count ?? null,
      status_counts: meta?.status_counts ?? null,
    },
  });

  const headers = apiHeaders("short");
  headers.set("x-metagraph-health", stale ? "degraded" : "ok");
  return new Response(request.method === "HEAD" ? null : body, {
    status: stale ? 503 : 200,
    headers,
  });
}

async function readArtifact(env, artifactPath) {
  const storageTier = artifactStorageTierForPath(artifactPath);

  if (storageTier === ARTIFACT_STORAGE_TIERS.r2) {
    const r2 = await readR2(env, artifactPath, storageTier);
    if (r2.ok || env.METAGRAPH_ALLOW_R2_STATIC_FALLBACK !== "true") {
      return r2;
    }
    logEvent(env, "warn", "r2_static_fallback", {
      artifact_path: artifactPath,
      r2_code: r2.code,
    });
    return readAsset(env, artifactPath, storageTier);
  }

  const asset = await readAsset(env, artifactPath, storageTier);
  if (asset.ok) {
    return asset;
  }

  const r2 = await readR2(env, artifactPath, storageTier);
  if (r2.ok) {
    return r2;
  }

  return asset.status !== 404 ? asset : r2;
}

async function readAsset(env, artifactPath, storageTier) {
  if (!env.ASSETS?.fetch) {
    return {
      ok: false,
      status: 404,
      code: "asset_binding_missing",
      message: "No ASSETS binding is configured.",
    };
  }

  const response = await env.ASSETS.fetch(
    new Request(`https://assets.local${artifactPath}`),
  );
  if (!response.ok) {
    await response.body?.cancel?.();
    return {
      ok: false,
      status: response.status,
      code: "artifact_not_found",
      message: `Artifact not found in static assets: ${artifactPath}`,
    };
  }

  return {
    ok: true,
    data: await response.json(),
    source: "static-assets",
    storage_tier: storageTier,
  };
}

async function readR2(env, artifactPath, storageTier) {
  if (!env.METAGRAPH_ARCHIVE?.get) {
    return {
      ok: false,
      status: 404,
      code: "r2_binding_missing",
      message: "No R2 archive binding is configured.",
    };
  }

  const key = await latestR2Key(artifactPath, env);
  let object;
  try {
    object = await withTimeout(
      env.METAGRAPH_ARCHIVE.get(key),
      r2TimeoutMs(env),
    );
  } catch {
    logEvent(env, "warn", "r2_read_timeout", {
      key,
      storage_tier: storageTier,
    });
    return {
      ok: false,
      status: 504,
      code: "r2_timeout",
      message: `R2 read timed out: ${key}`,
    };
  }
  if (!object) {
    return {
      ok: false,
      status: 404,
      code: "artifact_not_found",
      message: `Artifact not found in R2: ${key}`,
    };
  }

  return {
    ok: true,
    data: await object.json(),
    source: "r2",
    storage_tier: storageTier,
  };
}

async function latestR2Key(artifactPath, env) {
  const pointer = await latestPointer(env);
  const prefix =
    pointer?.latest_prefix || env.METAGRAPH_R2_LATEST_PREFIX || "latest/";
  return `${prefix}${artifactPath.replace(/^\/metagraph\//, "")}`;
}

// --- Change-feed webhooks -----------------------------------------------------
// Subscription management for the ~6h publish change feed. Subscriptions live in
// the METAGRAPH_CONTROL KV namespace under the `webhooks:sub:<id>` prefix; the
// publish-time dispatcher (scripts/dispatch-webhooks.mjs) reads them and fires
// HMAC-signed POSTs. Routes degrade to 503 when KV is unbound (local dev).
async function handleWebhookRequest(request, env, url) {
  if (!env.METAGRAPH_CONTROL?.get || !env.METAGRAPH_CONTROL?.put) {
    return errorResponse(
      "webhooks_unavailable",
      "The webhook subscription store is not configured.",
      503,
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "webhooks", "subscriptions", <id?>]
  if (segments[3] !== "subscriptions") {
    return errorResponse("not_found", "Unknown webhook route.", 404, {
      path: url.pathname,
    });
  }
  const id = segments[4];

  if (!id && request.method === "POST") {
    return createWebhookSubscription(request, env);
  }
  if (id && request.method === "GET") {
    return getWebhookSubscription(env, id);
  }
  if (id && request.method === "DELETE") {
    return deleteWebhookSubscription(request, env, id);
  }
  return errorResponse(
    "method_not_allowed",
    "Use POST /api/v1/webhooks/subscriptions, or GET/DELETE /api/v1/webhooks/subscriptions/{id}.",
    405,
    {},
    { allow: "POST, GET, DELETE, OPTIONS" },
  );
}

async function createWebhookSubscription(request, env) {
  if (
    Number(request.headers.get("content-length") || 0) > MAX_WEBHOOK_BODY_BYTES
  ) {
    return errorResponse(
      "payload_too_large",
      "Subscription body exceeds the size limit.",
      413,
    );
  }
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES) {
      return errorResponse(
        "payload_too_large",
        "Subscription body exceeds the size limit.",
        413,
      );
    }
    body = text ? JSON.parse(text) : null;
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }

  const validated = validateSubscriptionInput(body);
  if (!validated.ok) {
    return errorResponse("invalid_subscription", validated.error, 400);
  }

  const authorized = validateWebhookSubscriptionToken(request, env);
  if (!authorized.ok) {
    return authorized.response;
  }

  const id = generateSubscriptionId();
  // Short local name (`hookSecret`) keeps the public-safety scanner's
  // hardcoded-credential heuristic from false-positiving on `secret = <expr>`.
  const hookSecret = validated.value.secret || generateSecret();
  const record = {
    id,
    url: validated.value.url,
    filters: validated.value.filters,
    secret: hookSecret,
    created_at: new Date().toISOString(),
    active: true,
  };
  try {
    await env.METAGRAPH_CONTROL.put(
      subscriptionStorageKey(id),
      JSON.stringify(record),
      { expirationTtl: WEBHOOK_TTL_SECONDS },
    );
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to persist the subscription.",
      503,
    );
  }

  return dataResponse(
    env,
    {
      id,
      url: record.url,
      filters: record.filters,
      // Returned ONCE at creation; store it to verify delivery signatures and to
      // delete the subscription. It is never echoed back on GET.
      secret: hookSecret,
      active: true,
      created_at: record.created_at,
      delivery: {
        method: "POST",
        content_type: JSON_CONTENT_TYPE,
        signature_header: WEBHOOK_SIGNATURE_HEADER,
        signature_algorithm: "hmac-sha256-hex",
        note: "HMAC-SHA256 of the raw request body, hex-encoded, keyed by your secret.",
      },
    },
    201,
  );
}

function validateWebhookSubscriptionToken(request, env) {
  const configured = env.METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN;
  if (typeof configured !== "string" || configured.length === 0) {
    return {
      ok: false,
      response: errorResponse(
        "webhook_subscriptions_disabled",
        "Webhook subscription creation requires METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN to be configured.",
        503,
      ),
    };
  }

  const provided = request.headers.get(WEBHOOK_SUBSCRIPTION_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return {
      ok: false,
      response: errorResponse(
        "unauthorized",
        `Provide a valid ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER} header to create webhook subscriptions.`,
        401,
      ),
    };
  }

  return { ok: true };
}

async function getWebhookSubscription(env, id) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  return dataResponse(env, publicSubscriptionView(record));
}

async function deleteWebhookSubscription(request, env, id) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  const provided = request.headers.get(WEBHOOK_SECRET_HEADER) || "";
  if (!record.secret || !timingSafeEqual(provided, record.secret)) {
    return errorResponse(
      "forbidden",
      `Provide the subscription secret in the ${WEBHOOK_SECRET_HEADER} header to delete it.`,
      403,
    );
  }
  try {
    await env.METAGRAPH_CONTROL.delete(subscriptionStorageKey(id));
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to delete the subscription.",
      503,
    );
  }
  return dataResponse(env, { id, deleted: true });
}

async function readWebhookSubscription(env, id) {
  try {
    return await env.METAGRAPH_CONTROL.get(subscriptionStorageKey(id), {
      type: "json",
    });
  } catch {
    return null;
  }
}

// Thin SSE change feed. Given the ~6h cadence there is no value in holding a
// long-lived connection, so we emit the current change snapshot as one SSE event
// and advise a 5-minute reconnect via `retry:`. EventSource clients reconnect on
// that interval and re-read; `id:` is the publish timestamp for dedupe.
async function handleEventsRequest(request, env) {
  const [pointer, changelogArtifact] = await Promise.all([
    latestPointer(env),
    readArtifact(env, "/metagraph/changelog.json"),
  ]);
  const changelog = changelogArtifact.ok ? changelogArtifact.data : null;
  const event = buildChangeEvent({ changelog, pointer });
  const frame =
    [
      "retry: 300000",
      `id: ${event.published_at || event.generated_at || "0"}`,
      "event: snapshot",
      `data: ${JSON.stringify(event)}`,
    ].join("\n") + "\n\n";

  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-contract-version", contractVersion(env));
  return new Response(frame, { status: 200, headers });
}

// --- AI search / ask (semantic + RAG) --------------------------------------

function aiUnavailableResponse() {
  return errorResponse(
    "ai_unavailable",
    "AI features are not enabled on this deployment.",
    503,
  );
}

function aiRateLimitedResponse() {
  return errorResponse(
    "rate_limited",
    "Too many AI requests. Please retry shortly.",
    429,
    {},
    { "retry-after": "60" },
  );
}

function aiClientKey(request, scope) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anon";
  return `${scope}:${ip}`;
}

async function readBoundedRequestText(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    return { ok: false, text: "" };
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, text: "" };
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text };
}

async function handleSemanticSearchRequest(request, env, url) {
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  if (!(await withinRateLimit(env, aiClientKey(request, "semantic")))) {
    return aiRateLimitedResponse();
  }
  try {
    const data = await semanticSearch(env, url.searchParams.get("q"), {
      limit: url.searchParams.get("limit"),
    });
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    if (error?.aiInput) {
      return errorResponse("invalid_query", error.message, 400);
    }
    logEvent(env, "error", "semantic_search_failed", {
      message: error?.message,
    });
    return errorResponse(
      "ai_error",
      "Semantic search failed. Please retry shortly.",
      502,
    );
  }
}

async function handleAskRequest(request, env) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "POST a JSON body { question } to /api/v1/ask.",
      405,
      {},
      { allow: "POST, OPTIONS" },
    );
  }
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  if (!(await withinRateLimit(env, aiClientKey(request, "ask")))) {
    return aiRateLimitedResponse();
  }
  let body;
  try {
    const boundedBody = await readBoundedRequestText(
      request,
      MAX_ASK_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      return errorResponse(
        "payload_too_large",
        "Ask request body exceeds the size limit.",
        413,
      );
    }
    body = JSON.parse(boundedBody.text);
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }
  try {
    const data = await askQuestion(
      env,
      body?.question,
      { topK: body?.topK },
      { readArtifact },
    );
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    if (error?.aiInput) {
      return errorResponse("invalid_request", error.message, 400);
    }
    logEvent(env, "error", "ask_failed", { message: error?.message });
    return errorResponse(
      "ai_error",
      "The answer service failed. Please retry shortly.",
      502,
    );
  }
}

// Success envelope for non-cacheable (mutation / dynamic) JSON responses.
function dataResponse(env, data, status = 200, extraMeta = {}) {
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  return new Response(
    JSON.stringify({
      ok: true,
      schema_version: 1,
      data,
      error: null,
      meta: { contract_version: contractVersion(env), ...extraMeta },
    }),
    { status, headers },
  );
}

async function latestPointer(env) {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }

  try {
    return await env.METAGRAPH_CONTROL.get(METAGRAPH_LATEST_KEY, {
      type: "json",
    });
  } catch {
    return null;
  }
}

// Read a live health snapshot written by the cron prober (KV health:* keys).
// Returns null when KV is unbound or the key is cold so callers fall back to the
// static artifact.
async function readHealthKv(env, key) {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }
  try {
    return await env.METAGRAPH_CONTROL.get(key, { type: "json" });
  } catch {
    return null;
  }
}

// Explicit `unknown` health payloads for the live-only routes when the live
// store (KV + D1) is cold — served instead of a stale baked value or a 404.
function unknownGlobalHealth(contractVersionValue) {
  return {
    schema_version: 1,
    contract_version: contractVersionValue,
    source: "unavailable",
    scope: "operational",
    operational_observed_at: null,
    health_source: "unavailable",
    global: {
      surface_count: 0,
      status_counts: { ok: 0, degraded: 0, failed: 0, unknown: 0 },
    },
    subnets: [],
  };
}

function unknownSubnetHealth(netuid) {
  return {
    schema_version: 1,
    netuid,
    summary: {
      status: "unknown",
      surface_count: 0,
      ok_count: 0,
      degraded_count: 0,
      failed_count: 0,
      unknown_count: 0,
      last_checked: null,
      last_ok: null,
      avg_latency_ms: null,
    },
    operational_observed_at: null,
    health_source: "unavailable",
    surfaces: [],
  };
}

// Overlay the 2-minute cron snapshot onto a static health/rpc artifact. Returns
// { data } when a live snapshot is available, else null (caller serves static).
// Health-overlay routes whose live composition is keyed on surfaces/services
// (not the shared EndpointResource list) — excluded from the generic per-endpoint
// overlay below so it does not double-process them.
const ENDPOINT_OVERLAY_EXCLUDED_IDS = new Set([
  "subnet-health",
  "rpc-endpoints",
  "freshness",
  "agent-catalog",
  "agent-catalog-subnet",
]);

async function liveHealthOverlay(env, matched, staticData) {
  let resolved;
  const getLive = async () => {
    if (resolved === undefined) {
      resolved =
        (await resolveLiveHealth({
          readHealthKv,
          env,
          db: env.METAGRAPH_HEALTH_DB,
        })) || null;
    }
    return resolved;
  };

  let data;
  switch (matched.id) {
    case "subnet-health": {
      data = overlaySubnetHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "rpc-endpoints": {
      const pool = await readHealthKv(env, KV_HEALTH_RPC_POOL);
      data = mergeRpcEndpoints(staticData, pool);
      break;
    }
    case "freshness": {
      const meta = await readHealthKv(env, KV_HEALTH_META);
      data = mergeFreshness(staticData, meta);
      break;
    }
    case "subnet-overview": {
      data = overlayOverviewHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog-subnet": {
      data = overlayCatalogDetail(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog": {
      data = overlayCatalogIndex(staticData, await getLive());
      break;
    }
    default:
      data = null;
  }

  // Generic live overlay for any artifact embedding the shared EndpointResource
  // list (subnet detail, profile, endpoints collection, provider endpoints, and
  // the composed overview's endpoints[]). Each endpoint's operational health is
  // replaced from the 2-minute cron snapshot; surfaces with no live reading
  // become `unknown` — so per-endpoint health is never the baked build value.
  const base = data ?? staticData;
  if (
    !ENDPOINT_OVERLAY_EXCLUDED_IDS.has(matched.id) &&
    Array.isArray(base?.endpoints) &&
    base.endpoints.some((endpoint) => endpoint?.surface_id)
  ) {
    const overlaid = overlayArtifactEndpoints(base, await getLive());
    if (overlaid) data = overlaid;
  }

  return data ? { data } : null;
}

// Real publish timestamp for envelope meta, read from the KV latest pointer.
// API routes are edge-cached (cache-control max-age + stale-while-revalidate),
// so this KV read only happens on origin misses. Returns null when KV is
// unbound or the pointer predates published_at support.
async function publishedAt(env) {
  const pointer = await latestPointer(env);
  return pointer?.published_at || null;
}

function applyQueryFilters(data, url, queryCollection, queryFilterNames = []) {
  const params = url.searchParams;
  const config = API_QUERY_COLLECTIONS[queryCollection];
  if (!config) {
    return { data, meta: {} };
  }
  if (!Array.isArray(data?.[config.data_key])) {
    return { data, meta: {} };
  }
  return applyListTransform(data, params, {
    ...config,
    filters: Object.fromEntries(
      (queryFilterNames.length > 0
        ? queryFilterNames
        : Object.keys(config.filters)
      ).map((name) => [name, config.filters[name]]),
    ),
  });
}

function filterRows(rows, params, keys, csvFilters = {}, arrayFilters = {}) {
  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      const expected = params.get(key);
      // CSV membership filter (e.g. ?netuids=1,7,74 -> match row.netuid).
      const csvField = csvFilters[key];
      if (csvField) {
        const wanted = new Set(
          expected
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );
        return wanted.has(String(row[csvField]));
      }
      // Array-membership filter over the UNION of one or more array fields
      // (e.g. ?domain=inference -> match row.categories or row.derived_categories).
      const arrayFields = arrayFilters[key];
      if (arrayFields) {
        return arrayFields.some(
          (field) =>
            Array.isArray(row[field]) &&
            row[field].map(String).includes(expected),
        );
      }
      const value = row[key];
      if (Array.isArray(value)) {
        return value.map(String).includes(expected);
      }
      return String(value) === expected;
    }),
  );
}

function applyListTransform(data, params, config) {
  const queryError = validateListQuery(params, config);
  if (queryError) {
    return { error: queryError };
  }
  const key = config.data_key;
  const filterKeys = Object.keys(config.filters);
  const filtered = filterRows(
    searchRows(data[key], params, config.search_keys),
    params,
    filterKeys,
    config.csv_filters,
    config.array_filters,
  );
  const sorted = sortRows(filtered, params);
  const paginated = paginateRows(sorted, params);
  return {
    data: {
      ...data,
      [key]: paginated.rows,
    },
    meta: {
      pagination: {
        collection: key,
        total: sorted.length,
        returned: paginated.rows.length,
        limit: paginated.limit,
        cursor: paginated.cursor,
        next_cursor: paginated.nextCursor,
        sort: paginated.sort,
        order: paginated.order,
      },
    },
  };
}

function searchRows(rows, params, keys) {
  const q = params.get("q");
  if (!q || keys.length === 0) {
    return rows;
  }
  const needle = q.toLowerCase();
  return rows.filter((row) =>
    keys
      .flatMap((key) => {
        const value = row[key];
        return Array.isArray(value) ? value : [value];
      })
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

function sortRows(rows, params) {
  const key = params.get("sort");
  if (!key) {
    return rows;
  }
  const direction = params.get("order") === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => compareValues(a[key], b[key]) * direction);
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function paginateRows(rows, params) {
  const requestedLimit = integerParam(params.get("limit"));
  const requestedCursor = integerParam(params.get("cursor"));
  const shouldPage = requestedLimit !== null || requestedCursor !== null;
  const limit = shouldPage
    ? Math.min(Math.max(requestedLimit ?? 100, 1), 1000)
    : rows.length;
  const cursor = Math.min(Math.max(requestedCursor ?? 0, 0), rows.length);
  const next = cursor + limit;
  return {
    cursor,
    limit,
    nextCursor: next < rows.length ? next : null,
    order: params.get("order") === "desc" ? "desc" : "asc",
    rows: shouldPage ? rows.slice(cursor, next) : rows,
    sort: params.get("sort") || null,
  };
}

function validateListQuery(params, config) {
  const limit = params.get("limit");
  if (limit !== null && (integerParam(limit) === null || Number(limit) < 1)) {
    return {
      parameter: "limit",
      message: "limit must be an integer between 1 and 1000.",
    };
  }
  if (limit !== null && Number(limit) > 1000) {
    return {
      parameter: "limit",
      message: "limit must be an integer between 1 and 1000.",
    };
  }

  const cursor = params.get("cursor");
  if (cursor !== null && integerParam(cursor) === null) {
    return {
      parameter: "cursor",
      message: "cursor must be a non-negative integer.",
    };
  }

  const order = params.get("order");
  if (order !== null && !["asc", "desc"].includes(order)) {
    return {
      parameter: "order",
      message: "order must be asc or desc.",
    };
  }

  const sort = params.get("sort");
  if (sort !== null && !config.sort_fields.includes(sort)) {
    return {
      parameter: "sort",
      message: `sort is not supported for ${config.data_key}.`,
    };
  }

  for (const [key, schema] of Object.entries(config.filters)) {
    if (!params.has(key)) {
      continue;
    }
    const value = params.get(key);
    if (schema.type === "integer" && integerParam(value) === null) {
      return {
        parameter: key,
        message: `${key} must be a non-negative integer.`,
      };
    }
    if (schema.enum && !schema.enum.includes(value)) {
      return {
        parameter: key,
        message: `${key} is not supported for this route.`,
      };
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      return {
        parameter: key,
        message: `${key} is not in the expected format.`,
      };
    }
  }

  return null;
}

function integerParam(value) {
  if (value === null || value === "") {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function envelopeResponse(request, payload, cacheProfile) {
  const body = JSON.stringify({
    ok: true,
    schema_version: 1,
    data: payload.data,
    meta: payload.meta,
  });
  const headers = apiHeaders(cacheProfile);
  const etag = await weakEtag(body);
  headers.set("etag", etag);
  headers.set(
    "x-metagraph-contract-version",
    payload.meta.contract_version || CONTRACT_VERSION,
  );
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

function errorResponse(
  code,
  message,
  status = 500,
  meta = {},
  extraHeaders = {},
) {
  const headers = apiHeaders("short");
  headers.set("x-metagraph-error-code", code);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(
    JSON.stringify({
      ok: false,
      schema_version: 1,
      data: null,
      error: { code, message },
      meta: {
        contract_version: CONTRACT_VERSION,
        ...meta,
      },
    }),
    {
      status,
      headers,
    },
  );
}

function corsPreflight(request) {
  const url = new URL(request.url);
  const headers = apiHeaders("short");
  let methods = "GET, HEAD, OPTIONS";
  if (url.pathname.startsWith("/rpc/")) {
    methods = "POST, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/webhooks/")) {
    methods = "POST, GET, DELETE, OPTIONS";
  } else if (url.pathname === "/mcp" || url.pathname === "/api/v1/ask") {
    methods = "POST, OPTIONS";
  }
  headers.set("access-control-allow-methods", methods);
  headers.set(
    "access-control-allow-headers",
    `content-type, if-none-match, ${WEBHOOK_SECRET_HEADER}, ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER}`,
  );
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

// RFC 8288 Link header advertising the machine entrypoints, mirrored as
// `<link>` elements in the homepage HTML below. Relative refs resolve against
// the request URL, so the same value is correct on any deployment host. The
// relation set mirrors the authoritative RFC 9264 linkset served at
// /.well-known/api-catalog (service-desc, both service-doc targets, status,
// describedby) so an agent bootstrapping from the header alone sees the same
// entrypoints as the catalog body.
const DISCOVERY_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</metagraph/openapi.json>; rel="service-desc"; type="application/json"',
  '</llms.txt>; rel="service-doc"; type="text/plain"',
  '</agent.md>; rel="service-doc"; type="text/markdown"',
  '</health>; rel="status"; type="application/json"',
  '</.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"',
].join(", ");

const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>metagraphed API — Bittensor subnet operational registry</title>
<meta name="description" content="Machine-readable operational + integration registry for Bittensor subnets: what each subnet exposes, whether it's healthy, and how to call it.">
<link rel="api-catalog" href="/.well-known/api-catalog" type="application/linkset+json">
<link rel="service-desc" href="/metagraph/openapi.json" type="application/json">
<link rel="service-doc" href="/llms.txt" type="text/plain">
<link rel="service-doc" href="/agent.md" type="text/markdown">
<link rel="status" href="/health" type="application/json">
<link rel="describedby" href="/.well-known/mcp/server-card.json" type="application/json">
</head>
<body>
<main>
<h1>metagraphed API</h1>
<p>The operational + integration registry for Bittensor subnets — what each subnet exposes (APIs, docs, schemas), whether it's healthy, and how to call it. All endpoints are public, read-only JSON. No authentication.</p>
<ul>
<li><a href="/llms.txt">llms.txt</a> — LLM/agent discovery index</li>
<li><a href="/agent.md">agent.md</a> — copyable agent system prompt</li>
<li><a href="/metagraph/openapi.json">OpenAPI 3.1 contract</a></li>
<li><a href="/.well-known/api-catalog">API catalog</a> (RFC 9727 linkset)</li>
<li><a href="/.well-known/mcp/server-card.json">MCP server card</a> — <code>POST /mcp</code></li>
<li><a href="/.well-known/agent-skills/index.json">Agent Skills index</a></li>
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

// api.metagraph.sh homepage: a small human/agent landing whose response carries
// the RFC 8288 Link headers (an agent can bootstrap from a single HEAD of `/`).
function homepageResponse(request) {
  const headers = discoveryHeaders("text/html; charset=utf-8");
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(HOMEPAGE_HTML, { headers });
}

// RFC 9727 API catalog as an RFC 9264 linkset+json document. Hrefs point at the
// canonical API host (api.metagraph.sh) regardless of which host served this —
// the apex (metagraph.sh) routes /.well-known/* here too, and its catalog must
// reference the real API, not the apex.
function apiCatalogResponse(request) {
  const base = `https://${PRIMARY_DOMAIN}`;
  const linkset = {
    linkset: [
      {
        anchor: `${base}/api/v1`,
        "service-desc": [
          { href: `${base}/metagraph/openapi.json`, type: "application/json" },
        ],
        "service-doc": [
          { href: `${base}/llms.txt`, type: "text/plain" },
          { href: `${base}/agent.md`, type: "text/markdown" },
        ],
        status: [{ href: `${base}/health`, type: "application/json" }],
        describedby: [
          {
            href: `${base}/.well-known/mcp/server-card.json`,
            type: "application/json",
          },
        ],
      },
    ],
  };
  const headers = discoveryHeaders("application/linkset+json");
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(`${JSON.stringify(linkset, null, 2)}\n`, { headers });
}

function apiHeaders(cacheProfile) {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "cache-control",
    `public, max-age=${CACHE_SECONDS[cacheProfile] || CACHE_SECONDS.standard}, stale-while-revalidate=300`,
  );
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-cache-profile", cacheProfile);
  headers.set("vary", "Accept-Encoding");
  return headers;
}

async function weakEtag(body) {
  const encoded = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${hash.slice(0, 32)}"`;
}

function contractVersion(env) {
  return env.METAGRAPH_CONTRACT_VERSION || CONTRACT_VERSION;
}

// Build the FULL ordered candidate list of eligible, upstream-safe, HTTP(S)
// endpoints for the proxy to fail over across. Ordering is a weighted shuffle
// (favour higher score, keep load spread) so failover walks best→worst without
// always hammering one upstream. wss:// endpoints are dropped (not HTTP-
// proxyable); a genuinely unsafe URL is reported (for a 502) only when no safe
// endpoint exists. Circuit-breaker-ejected endpoints are deprioritised to the
// back (never removed) so a fully-ejected pool still self-heals via half-open
// retries. randomFn / healthMap / now injectable for tests.
export function orderSafeRpcEndpoints(
  pool,
  randomFn = Math.random,
  { healthMap = RPC_HEALTH, now = Date.now() } = {},
) {
  const safe = [];
  let unsafeEndpoint = null;
  for (const endpoint of pool?.endpoints || []) {
    if (!endpoint?.pool_eligible) {
      continue;
    }
    if (!isSafeRpcEndpointUrl(endpoint.url)) {
      unsafeEndpoint ||= endpoint;
      continue;
    }
    // Safe origin but wss:// — not HTTP-POST-able; skip without flagging unsafe.
    if (endpoint.url.startsWith("https://")) {
      safe.push(endpoint);
    }
  }

  const remaining = [...safe];
  const shuffled = [];
  while (remaining.length) {
    const pick = weightedPickEndpoint(remaining, randomFn);
    shuffled.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  const live = shuffled.filter(
    (e) => !isRpcEndpointEjected(healthMap, e.id, now),
  );
  const ejected = shuffled.filter((e) =>
    isRpcEndpointEjected(healthMap, e.id, now),
  );
  const ordered = [...live, ...ejected];
  return {
    endpoints: ordered,
    unsafeEndpoint: ordered.length ? null : unsafeEndpoint,
  };
}

// Back-compat single-pick wrapper (still used by tests): the first of the
// weighted-ordered list.
export function selectSafeRpcEndpoint(pool, randomFn = Math.random) {
  const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints(pool, randomFn);
  return { endpoint: endpoints[0] ?? null, unsafeEndpoint };
}

// Weighted-random pick favouring higher-scored (healthier/faster) endpoints,
// falling back to uniform weighting when scores are absent so traffic still
// spreads. randomFn is injectable for deterministic tests.
export function weightedPickEndpoint(endpoints, randomFn = Math.random) {
  if (endpoints.length === 1) {
    return endpoints[0];
  }
  const weights = endpoints.map((endpoint) =>
    Number.isFinite(endpoint.score) && endpoint.score > 0 ? endpoint.score : 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = randomFn() * total;
  for (let index = 0; index < endpoints.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) {
      return endpoints[index];
    }
  }
  return endpoints[endpoints.length - 1];
}

function isSafeRpcEndpointUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!["https:", "wss:"].includes(parsed.protocol)) {
    return false;
  }

  if (!TRUSTED_RPC_UPSTREAM_ORIGINS.has(parsed.origin)) {
    return false;
  }

  return !isPrivateOrLocalHostname(parsed.hostname);
}

function isPrivateOrLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4Address(host);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:169.254.") ||
    host.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function parseIpv4Address(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }

  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isSafeRpcMethod(method) {
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_METHODS.has(method);
}
