import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  CACHE_SECONDS,
  CONTRACT_VERSION,
  artifactPathFromTemplate,
  compileRoutePattern,
} from "../src/contracts.mjs";
import {
  artifactStorageTierForPath,
  ARTIFACT_STORAGE_TIERS,
} from "../src/artifact-storage.mjs";

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
const TRUSTED_RPC_UPSTREAM_ORIGINS = new Set([
  "https://bittensor-finney.api.onfinality.io",
  "https://bittensor-public.nodies.app",
  "wss://archive.chain.opentensor.ai",
  "wss://bittensor-finney.api.onfinality.io",
  "wss://entrypoint-finney.opentensor.ai",
  "wss://lite.chain.opentensor.ai",
]);

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, _ctx = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request);
  }

  if (url.pathname.startsWith("/rpc/v1/")) {
    return handleRpcProxyRequest(request, env, url);
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

  if (url.pathname === "/health") {
    return handleHealthRequest(request, env);
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    return handleApiRequest(request, env, url);
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

async function handleRawArtifactRequest(request, env, url) {
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

  const artifact = await readArtifact(env, url.pathname);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: url.pathname,
    });
  }
  const body = JSON.stringify(artifact.data);
  const headers = apiHeaders("standard");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("x-metagraph-artifact-source", artifact.source);
  headers.set("x-metagraph-storage-tier", artifact.storage_tier);
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
// ![](https://metagraph.sh/metagraph/health/badges/7.svg) — no shields.io
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
  const available = artifact.ok && artifact.data;
  const badge = available
    ? artifact.data
    : { label: `SN${netuid}`, message: "unavailable", color: "lightgrey" };
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

async function handleApiRequest(request, env, url) {
  const matched = matchRoute(url.pathname);
  if (!matched) {
    return errorResponse("not_found", "No API route matched this path.", 404);
  }

  const artifact = await readArtifact(env, matched.artifactPath);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: matched.artifactPath,
    });
  }

  const transformed = applyQueryFilters(
    artifact.data,
    url,
    matched.queryCollection,
    matched.queryFilterNames,
  );
  if (transformed.error) {
    return errorResponse("invalid_query", transformed.error.message, 400, {
      artifact_path: matched.artifactPath,
      parameter: transformed.error.parameter,
    });
  }
  return envelopeResponse(
    request,
    {
      data: transformed.data,
      meta: {
        artifact_path: matched.artifactPath,
        cache: matched.cache,
        contract_version: contractVersion(env),
        generated_at: artifact.data?.generated_at || null,
        // Real publish time from the KV latest pointer; null until a publish has
        // populated it. Unlike generated_at (a deterministic content marker),
        // this is safe to render as a human "last updated" timestamp.
        published_at: await publishedAt(env),
        source: artifact.source,
        ...transformed.meta,
      },
    },
    matched.cache,
  );
}

async function handleRpcProxyRequest(request, env, url) {
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
        { "retry-after": "60" },
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

  const poolId = url.pathname.includes("/wss") ? "finney-wss" : "finney-rpc";
  const pool = (poolArtifact.data.pools || []).find(
    (candidate) => candidate.id === poolId,
  );
  const endpointSelection = selectSafeRpcEndpoint(pool);
  if (endpointSelection.unsafeEndpoint) {
    return errorResponse(
      "rpc_endpoint_unsafe",
      "Eligible RPC endpoint URL is not allowed by the Worker upstream safety policy.",
      502,
      {
        endpoint_id: endpointSelection.unsafeEndpoint.id || null,
        pool_id: poolId,
      },
    );
  }
  if (!endpointSelection.endpoint) {
    return errorResponse(
      "rpc_endpoint_unavailable",
      "No eligible public RPC endpoint is available for proxy routing.",
      503,
      {
        pool_id: poolId,
      },
    );
  }

  const endpoint = endpointSelection.endpoint;
  const upstream = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: bodyText,
    signal: AbortSignal.timeout(10000),
  });
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  headers.set("x-metagraph-rpc-endpoint-id", endpoint.id);
  headers.set("x-metagraph-rpc-provider", endpoint.provider);
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
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
  };

  // Data freshness — the scheduled refresh (ADR 0001) advances the KV `latest`
  // pointer's published_at every ~6h. If that pipeline silently stops, the
  // pointer goes stale; report `degraded` + HTTP 503 so an uptime monitor
  // pointed at /health catches a broken data-refresh. Only a *present* stale
  // pointer trips it, so local/dev and the worker-test harness (no published
  // pointer) stay healthy.
  const maxAgeHours = Number(env.METAGRAPH_HEALTH_MAX_AGE_HOURS) || 12;
  const pointer = bindings.kv ? await latestPointer(env) : null;
  const publishedAtIso =
    pointer && typeof pointer.published_at === "string"
      ? pointer.published_at
      : null;
  const publishedMs = publishedAtIso ? Date.parse(publishedAtIso) : NaN;
  const ageHours = Number.isFinite(publishedMs)
    ? (Date.now() - publishedMs) / 3_600_000
    : null;
  const stale = ageHours !== null && ageHours > maxAgeHours;

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

function filterRows(rows, params, keys) {
  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      const expected = params.get(key);
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
  headers.set(
    "access-control-allow-methods",
    url.pathname.startsWith("/rpc/") ? "POST, OPTIONS" : "GET, HEAD, OPTIONS",
  );
  headers.set("access-control-allow-headers", "content-type, if-none-match");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
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

// Load-balance across ALL eligible + upstream-safe endpoints rather than always
// picking the highest-scored one, so no single upstream becomes a hotspot.
// Returns an unsafe endpoint (for a 502) only when every eligible endpoint fails
// the upstream safety policy, and a null endpoint when none are eligible (503).
export function selectSafeRpcEndpoint(pool, randomFn = Math.random) {
  const safe = [];
  let unsafeEndpoint = null;
  for (const endpoint of pool?.endpoints || []) {
    if (!endpoint?.pool_eligible) {
      continue;
    }
    if (isSafeRpcEndpointUrl(endpoint.url)) {
      safe.push(endpoint);
    } else {
      unsafeEndpoint ||= endpoint;
    }
  }

  if (!safe.length) {
    return { endpoint: null, unsafeEndpoint };
  }
  return {
    endpoint: weightedPickEndpoint(safe, randomFn),
    unsafeEndpoint: null,
  };
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
