import assert from "node:assert/strict";
import { API_ROUTES } from "../src/contracts.mjs";

const DEFAULT_BASE_URL = "https://metagraph.sh";
const baseUrl = normalizeBaseUrl(
  process.env.METAGRAPH_LIVE_BASE_URL || DEFAULT_BASE_URL,
);
const timeoutMs = Number(process.env.METAGRAPH_LIVE_SMOKE_TIMEOUT_MS || 15000);
const healthDate = await discoverHealthHistoryDate();
const apiChecks = API_ROUTES.map((route) => ({
  route: route.path,
  url: apiRouteUrl(route.path, healthDate),
}));
const rawArtifactChecks = [
  "/metagraph/openapi.json",
  "/metagraph/r2-manifest.json",
  "/metagraph/subnets/7.json",
  "/metagraph/health/latest.json",
  "/metagraph/candidates.json",
  "/metagraph/review-queue.json",
];
const results = [];

for (const check of apiChecks) {
  const result = await fetchJson(check.url);
  assert.equal(result.status, 200, `${check.route}: expected HTTP 200`);
  assertHeader(result, "access-control-allow-origin", "*", check.route);
  assert.ok(result.headers.get("etag"), `${check.route}: missing ETag`);
  assert.ok(
    result.headers.get("x-metagraph-contract-version"),
    `${check.route}: missing contract version header`,
  );
  assert.equal(result.body?.ok, true, `${check.route}: expected ok envelope`);
  assert.equal(
    result.body?.schema_version,
    1,
    `${check.route}: expected schema_version 1`,
  );
  assert.ok(result.body?.data, `${check.route}: expected data payload`);
  assert.ok(result.body?.meta, `${check.route}: expected meta payload`);
  results.push({
    path: new URL(check.url).pathname,
    route: check.route,
    status: result.status,
    source: result.body.meta.source || null,
  });
}

for (const artifactPath of rawArtifactChecks) {
  const result = await fetchJson(`${baseUrl}${artifactPath}`);
  assert.equal(result.status, 200, `${artifactPath}: expected HTTP 200`);
  assertHeader(result, "access-control-allow-origin", "*", artifactPath);
  assert.ok(result.headers.get("etag"), `${artifactPath}: missing ETag`);
  assert.ok(
    result.headers.get("x-metagraph-artifact-source"),
    `${artifactPath}: missing artifact source header`,
  );
  assert.ok(
    result.headers.get("x-metagraph-storage-tier"),
    `${artifactPath}: missing storage tier header`,
  );
  assert.equal(
    typeof result.body,
    "object",
    `${artifactPath}: expected JSON artifact body`,
  );
  results.push({
    path: artifactPath,
    route: artifactPath,
    status: result.status,
    source: result.headers.get("x-metagraph-artifact-source"),
    storage_tier: result.headers.get("x-metagraph-storage-tier"),
  });
}

const invalidQuery = await fetchJson(`${baseUrl}/api/v1/subnets?limit=0`);
assert.equal(invalidQuery.status, 400, "invalid query should return HTTP 400");
assert.equal(
  invalidQuery.body?.error?.code,
  "invalid_query",
  "invalid query should return invalid_query error",
);

// RPC proxy is enabled in production: a non-allowlisted method must be refused
// (proves the proxy is live and the read-only allowlist holds, with no
// dependency on a live upstream), and a safe read method must not report
// "disabled". (The enable gate runs before the method check, so a disabled
// proxy would 501 here rather than 403.)
const blockedRpcProxy = await fetchJson(`${baseUrl}/rpc/v1/finney`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "author_submitExtrinsic",
    params: [],
  }),
});
assert.equal(
  blockedRpcProxy.status,
  403,
  "enabled RPC proxy must refuse non-allowlisted methods",
);
assert.equal(
  blockedRpcProxy.body?.error?.code,
  "rpc_method_blocked",
  "blocked RPC method should return rpc_method_blocked",
);

const safeRpcProxy = await fetchJson(`${baseUrl}/rpc/v1/finney`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
    params: [],
  }),
});
assert.notEqual(
  safeRpcProxy.status,
  501,
  "enabled RPC proxy must not report rpc_proxy_disabled",
);

// The /wss route is WebSocket-only and cannot be HTTP-proxied; it must return a
// clean client error, never a 500.
const wssRpcProxy = await fetchJson(`${baseUrl}/rpc/v1/finney/wss`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
    params: [],
  }),
});
assert.equal(
  wssRpcProxy.status,
  400,
  "the /wss RPC route must be rejected with a clean 400, not 500",
);
assert.equal(
  wssRpcProxy.body?.error?.code,
  "rpc_websocket_unsupported",
  "the /wss RPC route should return rpc_websocket_unsupported",
);

console.log(
  JSON.stringify(
    {
      base_url: baseUrl,
      status: "passed",
      api_route_count: apiChecks.length,
      raw_artifact_count: rawArtifactChecks.length,
      health_history_date: healthDate,
      checked_paths: results,
    },
    null,
    2,
  ),
);

async function discoverHealthHistoryDate() {
  const result = await fetchJson(`${baseUrl}/metagraph/health/latest.json`);
  assert.equal(
    result.status,
    200,
    "/metagraph/health/latest.json: expected HTTP 200",
  );
  const generatedAt =
    result.body?.probe_finished_at ||
    result.body?.probe_started_at ||
    result.body?.generated_at;
  assert.match(
    String(generatedAt || ""),
    /^\d{4}-\d{2}-\d{2}T/,
    "/metagraph/health/latest.json: probe timestamp must be an ISO timestamp",
  );
  return generatedAt.slice(0, 10);
}

function apiRouteUrl(routePath, date) {
  const route = routePath
    .replace("{netuid}", "7")
    .replace("{slug}", "allways")
    .replace("{date}", date);
  const url = new URL(route, baseUrl);
  if (routePath === "/api/v1/subnets") {
    url.searchParams.set("limit", "3");
    url.searchParams.set("sort", "netuid");
  } else if (
    [
      "/api/v1/surfaces",
      "/api/v1/endpoints",
      "/api/v1/candidates",
      "/api/v1/health/history/{date}",
      "/api/v1/search",
    ].includes(routePath)
  ) {
    url.searchParams.set("limit", "3");
  }
  return url.toString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") || "";
  assert.match(
    contentType,
    /application\/json/,
    `${url}: expected JSON content-type, got ${contentType || "none"}`,
  );
  return {
    body: await response.json(),
    headers: response.headers,
    status: response.status,
  };
}

function assertHeader(result, name, expected, route) {
  assert.equal(
    result.headers.get(name),
    expected,
    `${route}: expected ${name}=${expected}`,
  );
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
