import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_ROUTES } from "../src/contracts.mjs";
import { MCP_TOOLS } from "../src/mcp-server.mjs";

const DEFAULT_BASE_URL = "https://api.metagraph.sh";
const baseUrl = normalizeBaseUrl(
  process.env.METAGRAPH_LIVE_BASE_URL || DEFAULT_BASE_URL,
);
const timeoutMs = Number(process.env.METAGRAPH_LIVE_SMOKE_TIMEOUT_MS || 15000);

// Only fire the live smoke when this file is executed directly (npm run
// smoke:live). Importing it for the PR-time substitution unit test must not hit
// the network.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runLiveSmoke();
}

async function runLiveSmoke() {
  const healthDate = await discoverHealthHistoryDate();
  const fixtureSurfaceId =
    process.env.METAGRAPH_LIVE_FIXTURE_SURFACE_ID ||
    (await discoverFixtureSurfaceId());
  const apiChecks = liveSmokeApiRoutes(fixtureSurfaceId).map((route) => ({
    route: route.path,
    url: apiRouteUrl(route.path, healthDate, { surfaceId: fixtureSurfaceId }),
  }));
  const rawArtifactChecks = [
    "/metagraph/openapi.json",
    "/metagraph/r2-manifest.json",
    "/metagraph/subnets/7.json",
    // Current-state health artifacts are retired (410); the durable daily
    // history snapshot is the live raw health artifact still served from R2.
    `/metagraph/health/history/${healthDate}.json`,
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
  assert.equal(
    invalidQuery.status,
    400,
    "invalid query should return HTTP 400",
  );
  assert.equal(
    invalidQuery.body?.error?.code,
    "invalid_query",
    "invalid query should return invalid_query error",
  );

  // Subnet slug aliases resolve to the netuid (e.g. allways → 7).
  const slugAlias = await fetchJson(`${baseUrl}/api/v1/subnets/allways`);
  assert.equal(
    slugAlias.status,
    200,
    "slug alias /api/v1/subnets/allways should resolve",
  );
  assert.equal(
    slugAlias.body?.data?.subnet?.netuid,
    7,
    "allways slug should resolve to netuid 7",
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

  // Remote MCP server: the JSON-RPC handshake must work and expose every tool,
  // and a representative tools/call must resolve real registry data.
  const mcpInit = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  });
  assert.equal(
    mcpInit.status,
    200,
    "POST /mcp initialize must return HTTP 200",
  );
  assert.equal(
    mcpInit.body?.result?.serverInfo?.name,
    "metagraphed",
    "MCP initialize must identify the metagraphed server",
  );

  const mcpTools = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(
    mcpTools.body?.result?.tools?.length,
    MCP_TOOLS.length,
    `MCP tools/list must expose all ${MCP_TOOLS.length} tools`,
  );

  const mcpCall = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_subnet_apis", arguments: { netuid: 7 } },
    }),
  });
  assert.equal(
    mcpCall.body?.result?.isError,
    false,
    "MCP list_subnet_apis(7) must succeed against live data",
  );
  assert.ok(
    mcpCall.body?.result?.structuredContent?.service_count >= 1,
    "MCP list_subnet_apis(7) must return at least one service",
  );

  // AI routes (semantic search + /ask). Tolerant of the kill-switch: a 503
  // ai_unavailable is an accepted "disabled" state; when enabled we validate the
  // envelope shape (results may be empty if the embedding index is still cold).
  let aiStatus = "disabled";
  const semantic = await fetchJson(
    `${baseUrl}/api/v1/search/semantic?q=image%20generation&limit=5`,
  );
  if (semantic.status === 200) {
    aiStatus = "enabled";
    assert.equal(
      semantic.body?.ok,
      true,
      "semantic search must return an ok envelope",
    );
    assert.ok(
      Array.isArray(semantic.body?.data?.results),
      "semantic search must return a results array",
    );

    const ask = await fetchJson(`${baseUrl}/api/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Which subnets expose a public API?" }),
    });
    assert.equal(
      ask.status,
      200,
      "ask must return HTTP 200 when AI is enabled",
    );
    assert.equal(
      typeof ask.body?.data?.answer,
      "string",
      "ask must return an answer string",
    );
    assert.ok(
      Array.isArray(ask.body?.data?.citations),
      "ask must return a citations array",
    );
  } else {
    assert.equal(
      semantic.status,
      503,
      "semantic search must be 200 (enabled) or 503 (disabled)",
    );
    assert.equal(semantic.body?.error?.code, "ai_unavailable");
  }

  // AI-crawler access regression check: Cloudflare's "Block AI bots" zone setting
  // once served 403s to AI user-agents on the exact endpoints built for them
  // (llms.txt, agent-catalog) — fatal for an AI-native registry, and invisible to
  // default-UA checks. Assert agent UAs are never blocked again.
  const AI_USER_AGENTS = [
    "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Claude-User/1.0",
    "GPTBot/1.2",
  ];
  for (const userAgent of AI_USER_AGENTS) {
    for (const path of ["/llms.txt", "/api/v1/agent-catalog"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel?.();
      assert.notEqual(
        response.status,
        403,
        `${path}: AI agent UA "${userAgent}" is blocked (403) — the Cloudflare AI-bot block has regressed`,
      );
      assert.equal(
        response.status,
        200,
        `${path}: expected 200 for AI agent UA "${userAgent}", got ${response.status}`,
      );
    }
  }

  // Rollup/detail self-consistency: a real, once-live bug had
  // /api/v1/endpoints' summary.by_status silently drift from the actual
  // endpoints[] rows in the SAME response -- schema-valid on both sides, the
  // values just didn't reconcile with each other, which no shape validator
  // catches. Recompute each rollup independently from the response's own
  // detail array and assert they still agree. Checked unpaginated (no
  // `?limit`) -- a rollup describing a total across pages while the detail
  // array is one page is normal pagination, not drift, so this must never
  // run against a limited request.
  const endpointsGlobal = await fetchJson(`${baseUrl}/api/v1/endpoints`);
  assert.equal(
    endpointsGlobal.status,
    200,
    "/api/v1/endpoints: expected HTTP 200",
  );
  const globalEndpoints = endpointsGlobal.body?.data?.endpoints;
  assert.ok(
    Array.isArray(globalEndpoints),
    "/api/v1/endpoints: expected data.endpoints array",
  );
  assertRollupsReconcile(
    "/api/v1/endpoints",
    endpointsGlobal.body?.data?.summary,
    globalEndpoints,
    { by_status: "status", by_kind: "kind", by_provider: "provider" },
  );

  // Second, distinct artifact with the same rollup+detail shape (not just a
  // second field on the same response) -- generalizes the check rather than
  // hardcoding one endpoint.
  const sampleProvider = Object.keys(
    endpointsGlobal.body?.data?.summary?.by_provider ?? {},
  )[0];
  if (sampleProvider) {
    const providerEndpoints = await fetchJson(
      `${baseUrl}/api/v1/providers/${sampleProvider}/endpoints`,
    );
    assert.equal(
      providerEndpoints.status,
      200,
      `/api/v1/providers/${sampleProvider}/endpoints: expected HTTP 200`,
    );
    const scopedEndpoints = providerEndpoints.body?.data?.endpoints;
    assert.ok(
      Array.isArray(scopedEndpoints),
      `/api/v1/providers/${sampleProvider}/endpoints: expected data.endpoints array`,
    );
    assertRollupsReconcile(
      `/api/v1/providers/${sampleProvider}/endpoints`,
      providerEndpoints.body?.data?.summary,
      scopedEndpoints,
      { by_status: "status", by_kind: "kind" },
    );
  }

  console.log(
    JSON.stringify(
      {
        base_url: baseUrl,
        status: "passed",
        api_route_count: apiChecks.length,
        raw_artifact_count: rawArtifactChecks.length,
        mcp_tool_count: MCP_TOOLS.length,
        ai_status: aiStatus,
        ai_crawler_access: "unblocked",
        health_history_date: healthDate,
        checked_paths: results,
      },
      null,
      2,
    ),
  );
}

// Recomputes each named rollup from `detail` (tallying `detail[row][field]`)
// and asserts it exactly matches `summary[rollupKey]` -- same key set, same
// counts. Deliberately limited to plain single-field count rollups
// (by_status/by_kind/by_provider): a derived/composite rollup (e.g.
// by_publication_state, which folds in auth/pool-eligibility rules) would
// need its derivation logic reimplemented here to check safely, which is
// its own bug surface -- skip those rather than guess.
export function reconcileRollups(summary, detail, fieldsToKeys) {
  const mismatches = [];
  for (const [rollupKey, field] of Object.entries(fieldsToKeys)) {
    const rollup = summary?.[rollupKey];
    if (!rollup || typeof rollup !== "object") continue;
    const actual = Object.create(null);
    for (const row of detail) {
      const value = row?.[field];
      if (value === undefined || value === null) continue;
      actual[value] = (actual[value] || 0) + 1;
    }
    const keysMatch =
      Object.keys(rollup).sort().join(",") ===
      Object.keys(actual).sort().join(",");
    const countsMatch = Object.keys(rollup).every(
      (key) => rollup[key] === actual[key],
    );
    if (!keysMatch || !countsMatch) {
      mismatches.push({ rollupKey, expected: rollup, actual: { ...actual } });
    }
  }
  return mismatches;
}

function assertRollupsReconcile(routeLabel, summary, detail, fieldsToKeys) {
  const mismatches = reconcileRollups(summary, detail, fieldsToKeys);
  assert.deepEqual(
    mismatches,
    [],
    `${routeLabel}: summary rollup(s) don't reconcile against this response's own detail array: ${JSON.stringify(mismatches)}`,
  );
}

async function discoverHealthHistoryDate() {
  // Current-state health is live-only — the static /metagraph/health/latest.json
  // artifact is retired (410). Bootstrap the probe date from the live
  // /api/v1/health endpoint, then walk backward to the most recent date that
  // actually has a daily health-history snapshot. History is sparse (some days
  // have no snapshot), so this keeps the downstream history check stable and
  // robust across the midnight boundary.
  const health = await fetchJson(`${baseUrl}/api/v1/health`);
  assert.equal(health.status, 200, "/api/v1/health: expected HTTP 200");
  const observedAt =
    health.body?.data?.operational_observed_at ||
    health.body?.data?.generated_at ||
    health.body?.meta?.published_at;
  assert.match(
    String(observedAt || ""),
    /^\d{4}-\d{2}-\d{2}T/,
    "/api/v1/health: expected an ISO operational timestamp",
  );
  const startMs = new Date(observedAt).getTime();
  for (let back = 0; back < 14; back += 1) {
    const date = new Date(startMs - back * 86400000).toISOString().slice(0, 10);
    const snapshot = await fetchJson(
      `${baseUrl}/api/v1/health/history/${date}`,
    );
    if (snapshot.status === 200 && snapshot.body?.ok) {
      return date;
    }
  }
  throw new assert.AssertionError({
    message:
      "no daily health-history snapshot found in the last 14 days via /api/v1/health/history/{date}",
  });
}

export function apiRouteUrl(routePath, date, options = {}) {
  // D1-tier detail routes carry id placeholders beyond {netuid}/{slug}/{date}.
  // Substitute constant, dependency-free sample ids that resolve to a live 200:
  // uid 0 always exists; an all-zero hash / block 0 hit the cold→null wrapper
  // (still a 200 envelope); the accounts route requires a checksum-valid SS58, so
  // use the canonical dev address (Alice) rather than an arbitrary string (which
  // 404s on the checksum). Without these, the smoke step requests literal-
  // placeholder URLs that match no route and 404 (#1682).
  const route = routePath
    .replace("{netuid}", "7")
    .replace("{slug}", "allways")
    .replace("{date}", date)
    .replace("{uid}", "0")
    .replace("{hash}", `0x${"0".repeat(64)}`)
    .replace("{ref}", "0")
    .replace("{surface_id}", options.surfaceId || "7:subnet-api:new_v2")
    .replace("{ss58}", "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM")
    .replace("{hotkey}", "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM")
    .replace("{tag}", "inference")
    .replace("{h160}", "0x0000000000000000000000000000000000000001");
  // Guard against the recurring #1682 class: any leftover `{` means a route
  // placeholder was never substituted, which silently 404s against a live URL
  // that matches no route. Fail fast with the offending path.
  if (route.includes("{")) {
    throw new Error(`unsubstituted placeholder in route ${routePath}`);
  }
  const url = new URL(route, baseUrl);
  if (routePath === "/api/v1/subnets") {
    url.searchParams.set("limit", "3");
    url.searchParams.set("sort", "netuid");
  } else if (routePath === "/api/v1/compare") {
    // compare requires `netuids` — a bare GET is a 400 (#1682).
    url.searchParams.set("netuids", "7,8");
  } else if (routePath === "/api/v1/subnets/{netuid}/stake-quote") {
    // stake-quote requires `amount` — a bare GET is a correct 400
    // invalid_amount, not a route failure (same #1682 class as compare above).
    url.searchParams.set("amount", "1");
  } else if (routePath === "/api/v1/compare/validators") {
    // compare/validators requires `hotkeys` — a bare GET is a 400 invalid_query
    // (same #1682 class as compare/stake-quote above). Alice's address is the
    // same known-good SS58 already substituted for {ss58}/{hotkey} above.
    url.searchParams.set(
      "hotkeys",
      "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    );
  } else if (
    [
      "/api/v1/surfaces",
      "/api/v1/endpoints",
      "/api/v1/candidates",
      "/api/v1/search",
    ].includes(routePath)
  ) {
    url.searchParams.set("limit", "3");
  }
  return url.toString();
}

export function liveSmokeApiRoutes(fixtureSurfaceId = null) {
  // Fixture detail is a live, R2-only detail route whose path requires a
  // currently published surface id. The smoke runner derives that id from the
  // fixture index when the deployment does not supply an explicit override.
  return API_ROUTES.filter(
    (route) => route.id !== "fixture-detail" || fixtureSurfaceId,
  );
}

export async function discoverFixtureSurfaceId() {
  const result = await fetchJson(`${baseUrl}/api/v1/fixtures`);
  return fixtureSurfaceIdFromIndex(result.body);
}

export function fixtureSurfaceIdFromIndex(body) {
  const fixtures = body?.data?.fixtures;
  if (!Array.isArray(fixtures)) {
    return null;
  }
  return (
    fixtures.find((fixture) => typeof fixture?.surface_id === "string")
      ?.surface_id || null
  );
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
