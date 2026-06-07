import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildEndpointResourceArtifact,
  buildEndpointPoolArtifact,
  buildRpcEndpointArtifact,
  buildTimestamp,
  flattenSurfaces,
  isJsonContentType,
  loadProviders,
  isUnsafeResolvedUrl,
  loadSubnets,
  repoRoot,
  writeJson,
} from "./lib.mjs";

const contractVersion = "2026-06-06.1";
const subnets = await loadSubnets();
const providers = await loadProviders();
const allSurfaces = flattenSurfaces(subnets);
const surfaces = allSurfaces.filter(
  (surface) => surface.probe?.enabled && surface.public_safe,
);
const startedAt = Date.now();
const outputRoot = path.join(repoRoot, "public/metagraph");
const priorHistory = await loadPriorHistory();
const subtensorProbeCalls = [
  { key: "chain_getHeader", method: "chain_getHeader", params: [] },
  { key: "system_health", method: "system_health", params: [] },
  { key: "rpc_methods", method: "rpc_methods", params: [] },
  { key: "archive_probe", method: "chain_getBlockHash", params: [1] },
];

async function probeSurface(surface) {
  if (["subtensor-rpc", "subtensor-wss"].includes(surface.kind)) {
    return probeSubtensorSurface(surface);
  }

  const timeoutMs = surface.probe.timeout_ms || 8000;
  let probe = await probeUrl(
    surface.url,
    surface.probe.method,
    acceptHeader(surface.probe.expect),
    timeoutMs,
  );
  if (
    !probe.ok &&
    surface.probe.method === "HEAD" &&
    [400, 403, 405].includes(probe.status_code)
  ) {
    probe = await probeUrl(
      surface.url,
      "GET",
      acceptHeader(surface.probe.expect),
      timeoutMs,
    );
  }
  const classification = classifyProbe(probe, surface);
  const status = statusForClassification(classification, surface);
  const history = priorHistory.get(surface.id) || [];
  const lastOk =
    status === "ok"
      ? probe.verified_at
      : latestString(
          history
            .filter((entry) => entry.status === "ok")
            .map((entry) => entry.verified_at),
        );
  const historyWithCurrent = [
    ...history,
    { status, verified_at: probe.verified_at },
  ];

  return {
    auth_required: surface.auth_required,
    classification,
    content_type: probe.content_type || null,
    error: probe.error || null,
    error_class: probe.error_class || null,
    kind: surface.kind,
    last_checked: probe.verified_at,
    last_ok: lastOk,
    latency_ms: probe.latency_ms,
    method_tested: probe.method_tested,
    netuid: surface.netuid,
    private_redirect_blocked: probe.private_redirect_blocked || false,
    provider: surface.provider,
    public_safe: surface.public_safe,
    redirect_target: probe.redirect_target || null,
    status,
    status_code: probe.status_code || null,
    subnet_name: surface.subnet_name,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    uptime_sample_ratio: uptimeRatio(historyWithCurrent),
    url: surface.url,
    verified_at: probe.verified_at,
  };
}

async function probeSubtensorSurface(surface) {
  const timeoutMs = surface.probe.timeout_ms || 12000;
  const startedAt = new Date().toISOString();
  const probe =
    surface.kind === "subtensor-wss"
      ? await probeSubtensorWss(surface.url, timeoutMs)
      : await probeSubtensorHttp(surface.url, timeoutMs);
  const classification = classifyRpcProbe(probe);
  const status = statusForClassification(classification, surface);
  const history = priorHistory.get(surface.id) || [];
  const verifiedAt = probe.verified_at || startedAt;
  const lastOk =
    status === "ok"
      ? verifiedAt
      : latestString(
          history
            .filter((entry) => entry.status === "ok")
            .map((entry) => entry.verified_at),
        );
  const historyWithCurrent = [...history, { status, verified_at: verifiedAt }];

  return {
    archive_support: probe.archive_support,
    auth_required: surface.auth_required,
    classification,
    content_type: probe.content_type || null,
    error: probe.error || null,
    error_class: probe.error_class || null,
    kind: surface.kind,
    last_checked: verifiedAt,
    last_ok: lastOk,
    latency_ms: probe.latency_ms,
    latest_block: probe.latest_block,
    method_results: probe.method_results,
    method_tested: surface.probe.method,
    methods_supported: probe.methods_supported,
    netuid: surface.netuid,
    private_redirect_blocked: probe.private_redirect_blocked || false,
    provider: surface.provider,
    public_safe: surface.public_safe,
    redirect_target: probe.redirect_target || null,
    rpc_method_count: probe.rpc_method_count,
    status,
    status_code: probe.status_code || null,
    subnet_name: surface.subnet_name,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    uptime_sample_ratio: uptimeRatio(historyWithCurrent),
    url: surface.url,
    verified_at: verifiedAt,
  };
}

async function probeUrl(url, method, accept, timeoutMs, redirectCount = 0) {
  if (await isUnsafeResolvedUrl(url)) {
    return {
      ok: false,
      error: "unsafe URL",
      latency_ms: 0,
      method_tested: method,
      unsafe_url: true,
      verified_at: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept,
        "user-agent": "metagraphed-smoke-probe/0.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    const latencyMs = Math.round(performance.now() - started);
    const location = response.headers.get("location");
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      location &&
      redirectCount < 5
    ) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeResolvedUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          latency_ms: latencyMs,
          method_tested: method,
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
          status_code: response.status,
          verified_at: new Date().toISOString(),
        };
      }
      await response.body?.cancel();
      const redirected = await probeUrl(
        redirectTarget,
        method,
        accept,
        timeoutMs,
        redirectCount + 1,
      );
      return {
        ...redirected,
        latency_ms: latencyMs + (redirected.latency_ms || 0),
        redirect_target: redirected.redirect_target || redirectTarget,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    await response.body?.cancel();
    return {
      ok: response.ok,
      content_type: contentType || null,
      latency_ms: latencyMs,
      method_tested: method,
      status_code: response.status,
      verified_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      method_tested: method,
      verified_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyProbe(probe, surface) {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (probe.error_class === "AbortError") {
    return "timeout";
  }
  if (probe.status_code === 429) {
    return "rate-limited";
  }
  if ([401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if ([404, 410].includes(probe.status_code)) {
    return "dead";
  }
  if (probe.status_code >= 500) {
    return "transient";
  }
  if (probe.ok && contentMismatch(probe, surface)) {
    return "content-mismatch";
  }
  if (probe.ok && probe.redirect_target) {
    return "redirected";
  }
  if (probe.ok) {
    return "live";
  }
  return "unsupported";
}

function classifyRpcProbe(probe) {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (
    probe.error_class === "AbortError" ||
    probe.error_class === "TimeoutError"
  ) {
    return "timeout";
  }
  if (probe.status_code === 429) {
    return "rate-limited";
  }
  if ([401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if (probe.status_code >= 500) {
    return "transient";
  }
  if (probe.error) {
    return "unsupported";
  }
  if (
    probe.method_results?.chain_getHeader?.ok &&
    probe.method_results?.system_health?.ok
  ) {
    return "live";
  }
  if (probe.method_results?.chain_getHeader?.ok) {
    return "unsupported";
  }
  return "transient";
}

function contentMismatch(probe, surface) {
  if (surface.probe.expect === "json") {
    if (
      String(probe.content_type || "")
        .toLowerCase()
        .includes("text/plain") &&
      (new URL(surface.url).pathname.toLowerCase().endsWith(".json") ||
        new URL(surface.url).hostname === "raw.githubusercontent.com")
    ) {
      return false;
    }
    return !isJsonContentType(probe.content_type);
  }
  if (surface.probe.expect === "html") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("html");
  }
  if (surface.probe.expect === "sse") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("text/event-stream");
  }
  return false;
}

function statusForClassification(classification, surface = null) {
  if (["live", "redirected"].includes(classification)) {
    return "ok";
  }
  if (
    ["rate-limited", "auth-required", "transient", "timeout"].includes(
      classification,
    )
  ) {
    return "degraded";
  }
  if (
    ["unsupported", "dead", "content-mismatch"].includes(classification) &&
    ["registry-observed", "community"].includes(surface?.authority)
  ) {
    return "degraded";
  }
  return "failed";
}

async function probeSubtensorHttp(url, timeoutMs) {
  if (await isUnsafeResolvedUrl(url)) {
    return {
      unsafe_url: true,
      error: "unsafe URL",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  const started = performance.now();
  const methodResults = {};
  let statusCode = null;
  let contentType = null;
  for (const [index, call] of subtensorProbeCalls.entries()) {
    const response = await jsonRpcHttp(
      url,
      call.method,
      call.params,
      index + 1,
      timeoutMs,
    );
    statusCode = response.status_code || statusCode;
    contentType = response.content_type || contentType;
    methodResults[call.key] = normalizeJsonRpcResult(response);
    if (response.transport_error) {
      return {
        ...response,
        content_type: contentType,
        latency_ms: Math.round(performance.now() - started),
        method_results: methodResults,
        status_code: statusCode,
        verified_at: new Date().toISOString(),
      };
    }
  }

  return summarizeRpcProbe({
    content_type: contentType,
    latency_ms: Math.round(performance.now() - started),
    method_results: methodResults,
    status_code: statusCode,
    verified_at: new Date().toISOString(),
  });
}

async function probeSubtensorWss(url, timeoutMs) {
  if (await isUnsafeResolvedUrl(url)) {
    return {
      unsafe_url: true,
      error: "unsafe URL",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  if (typeof WebSocket !== "function") {
    return {
      error: "WebSocket global is unavailable in this Node.js runtime",
      error_class: "UnsupportedRuntime",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  const started = performance.now();
  const methodResults = {};

  try {
    const rawResults = await jsonRpcWss(url, subtensorProbeCalls, timeoutMs);
    for (const call of subtensorProbeCalls) {
      methodResults[call.key] = normalizeJsonRpcResult(
        rawResults.get(call.key) || { error: "missing response" },
      );
    }
    return summarizeRpcProbe({
      latency_ms: Math.round(performance.now() - started),
      method_results: methodResults,
      verified_at: new Date().toISOString(),
    });
  } catch (error) {
    return {
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      method_results: methodResults,
      verified_at: new Date().toISOString(),
    };
  }
}

async function jsonRpcHttp(url, method, params, id, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "metagraphed-subtensor-rpc-probe/0.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual",
      signal: controller.signal,
    });

    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeResolvedUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          transport_error: true,
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
          status_code: response.status,
          error: "redirect target is unsafe",
        };
      }
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return {
        transport_error: true,
        content_type: contentType || null,
        status_code: response.status,
        error: "response was not JSON",
      };
    }

    return {
      content_type: contentType || null,
      ok: response.ok && !body?.error,
      result: body?.result,
      rpc_error: body?.error || null,
      status_code: response.status,
    };
  } catch (error) {
    return {
      transport_error: true,
      error: error.message,
      error_class: error.name,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRpcWss(url, calls, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const byId = new Map(calls.map((call, index) => [index + 1, call.key]));
    const results = new Map();
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close failures after timeout.
      }
      const error = new Error("WebSocket RPC probe timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);

    socket.addEventListener("open", () => {
      calls.forEach((call, index) => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: call.method,
            params: call.params,
          }),
        );
      });
    });

    socket.addEventListener("message", (event) => {
      try {
        const body = JSON.parse(String(event.data));
        const key = byId.get(body.id);
        if (!key) {
          return;
        }
        results.set(key, {
          ok: !body.error,
          result: body.result,
          rpc_error: body.error || null,
        });
        if (results.size === calls.length) {
          clearTimeout(timer);
          socket.close();
          resolve(results);
        }
      } catch (error) {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close failures after parse failure.
        }
        reject(error);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket RPC connection failed"));
    });
  });
}

function normalizeJsonRpcResult(response) {
  const normalized = {
    ok: Boolean(response.ok),
    error: response.error || response.rpc_error?.message || null,
    code: response.rpc_error?.code || null,
    result_type:
      response.result === null
        ? "null"
        : Array.isArray(response.result)
          ? "array"
          : typeof response.result,
    result_present: response.result !== null && response.result !== undefined,
  };
  if (
    response.result &&
    typeof response.result === "object" &&
    !Array.isArray(response.result) &&
    response.result.number
  ) {
    normalized.raw_header = { number: response.result.number };
  }
  if (response.result && Array.isArray(response.result.methods)) {
    normalized.rpc_method_count = response.result.methods.length;
  }
  if (typeof response.result === "string" && response.result.startsWith("0x")) {
    normalized.raw_hex_result_present = true;
  }
  return normalized;
}

function summarizeRpcProbe(probe) {
  const header = probe.method_results.chain_getHeader;
  const methods = probe.method_results.rpc_methods;
  const archiveProbe = probe.method_results.archive_probe;
  const latestBlock = parseBlockNumber(header?.raw_header);
  return {
    ...probe,
    archive_support: Boolean(
      archiveProbe?.ok && archiveProbe.raw_hex_result_present,
    ),
    latest_block: latestBlock,
    methods_supported: {
      chain_getHeader: Boolean(probe.method_results.chain_getHeader?.ok),
      system_health: Boolean(probe.method_results.system_health?.ok),
      rpc_methods: Boolean(probe.method_results.rpc_methods?.ok),
      chain_getBlockHash: Boolean(probe.method_results.archive_probe?.ok),
    },
    rpc_method_count: methods?.rpc_method_count ?? null,
  };
}

function parseBlockNumber(header) {
  if (!header || typeof header !== "object") {
    return null;
  }
  const value = header.number;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.startsWith("0x")
      ? Number.parseInt(value, 16)
      : Number.parseInt(value, 10);
  }
  return null;
}

function acceptHeader(expect) {
  switch (expect) {
    case "json":
      return "application/json";
    case "html":
      return "text/html,application/xhtml+xml";
    case "sse":
      return "text/event-stream";
    default:
      return "*/*";
  }
}

const results = await mapLimit(surfaces, 16, probeSurface);
const artifact = buildHealthArtifacts(results, {
  generatedAt: buildTimestamp(),
  source: "live-smoke-probe",
  probeStartedAt: new Date(startedAt).toISOString(),
  probeFinishedAt: new Date().toISOString(),
});

if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
  const rpcEndpointArtifact = buildRpcEndpointArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  const endpointResourceArtifact = buildEndpointResourceArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  await writeJson(path.join(outputRoot, "health/latest.json"), artifact.latest);
  await writeJson(
    path.join(outputRoot, "health/summary.json"),
    artifact.summary,
  );
  await writeJson(
    path.join(outputRoot, "rpc-endpoints.json"),
    rpcEndpointArtifact,
  );
  await writeJson(
    path.join(outputRoot, "endpoints.json"),
    endpointResourceArtifact,
  );
  await writeJson(
    path.join(outputRoot, "rpc/pools.json"),
    buildEndpointPoolArtifact({
      generatedAt: buildTimestamp(),
      contractVersion,
      rpcArtifact: rpcEndpointArtifact,
    }),
  );
  await writeJson(
    path.join(outputRoot, "endpoint-pools.json"),
    buildEndpointPoolArtifact({
      generatedAt: buildTimestamp(),
      contractVersion,
      endpointArtifact: endpointResourceArtifact,
    }),
  );
  await fs.rm(path.join(outputRoot, "endpoints"), {
    recursive: true,
    force: true,
  });
  for (const subnet of subnets) {
    const subnetEndpoints = endpointResourceArtifact.endpoints.filter(
      (endpoint) => endpoint.netuid === subnet.netuid,
    );
    await writeJson(path.join(outputRoot, `endpoints/${subnet.netuid}.json`), {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: buildTimestamp(),
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      summary: summarizeEndpoints(subnetEndpoints),
      endpoints: subnetEndpoints,
    });
  }
  for (const provider of providers) {
    const providerEndpoints = endpointResourceArtifact.endpoints.filter(
      (endpoint) => endpoint.provider === provider.id,
    );
    await writeJson(
      path.join(outputRoot, `providers/${provider.id}/endpoints.json`),
      {
        schema_version: 1,
        contract_version: contractVersion,
        generated_at: buildTimestamp(),
        provider: {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          authority: provider.authority,
        },
        summary: summarizeEndpoints(providerEndpoints),
        endpoints: providerEndpoints,
      },
    );
  }
  const day = artifact.latest.probe_finished_at.slice(0, 10);
  await writeJson(
    path.join(outputRoot, `health/history/${day}.json`),
    buildHealthHistoryArtifact(artifact.latest, day),
  );
  await fs.rm(path.join(outputRoot, "health/subnets"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(outputRoot, "health/badges"), {
    recursive: true,
    force: true,
  });
  for (const [netuid, subnetHealth] of artifact.subnets) {
    await writeJson(
      path.join(outputRoot, `health/subnets/${netuid}.json`),
      subnetHealth,
    );
  }
  for (const [netuid, badge] of artifact.badges) {
    await writeJson(
      path.join(outputRoot, `health/badges/${netuid}.json`),
      badge,
    );
  }
}

const ok = results.filter((result) => result.status === "ok").length;
const degraded = results.filter(
  (result) => result.status === "degraded",
).length;
const failed = results.filter((result) => result.status === "failed").length;
console.log(
  `Smoke-probed ${results.length} surface(s): ${ok} ok, ${degraded} degraded, ${failed} failed.`,
);

for (const result of results) {
  const latency =
    result.latency_ms === undefined ? "" : ` ${result.latency_ms}ms`;
  const code =
    result.status_code === undefined || result.status_code === null
      ? ""
      : ` HTTP ${result.status_code}`;
  console.log(
    `${result.status.padEnd(8)} ${result.classification.padEnd(16)} ${result.surface_id}${code}${latency}`,
  );
}

if (failed > 0 && process.env.METAGRAPH_STRICT_PROBES === "1") {
  process.exit(1);
}

process.exit(0);

function buildHealthArtifacts(surfaceHealth, options) {
  const byNetuid = groupByNetuid(surfaceHealth);
  const subnetArtifacts = new Map();
  const badgeArtifacts = new Map();
  const subnetSummaries = [];

  for (const subnet of subnets) {
    const subnetSurfaces = byNetuid.get(subnet.netuid) || [];
    const summary = summarizeSubnet(subnet, subnetSurfaces);
    subnetSummaries.push(summary);
    subnetArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      summary,
      surfaces: subnetSurfaces,
    });
    badgeArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      label: `SN${subnet.netuid}`,
      message: summary.status,
      status: summary.status,
      color: badgeColor(summary.status),
      surface_count: summary.surface_count,
      ok_count: summary.ok_count,
      failed_count: summary.failed_count,
      degraded_count: summary.degraded_count,
    });
  }

  const latest = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: options.generatedAt,
    probe_started_at: options.probeStartedAt,
    probe_finished_at: options.probeFinishedAt,
    source: options.source,
    summary: {
      surface_count: surfaceHealth.length,
      status_counts: countBy(surfaceHealth, "status"),
      classification_counts: countBy(surfaceHealth, "classification"),
    },
    surfaces: surfaceHealth,
  };

  return {
    latest,
    summary: {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      source: options.source,
      global: latest.summary,
      subnets: subnetSummaries.sort((a, b) => a.netuid - b.netuid),
    },
    subnets: subnetArtifacts,
    badges: badgeArtifacts,
  };
}

function summarizeEndpoints(endpoints) {
  return {
    endpoint_count: endpoints.length,
    monitored_count: endpoints.filter(
      (endpoint) => endpoint.monitoring_status === "monitored",
    ).length,
    pool_eligible_count: endpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    by_kind: countBy(endpoints, "kind"),
    by_layer: countBy(endpoints, "layer"),
    by_publication_state: countBy(endpoints, "publication_state"),
    by_status: countBy(endpoints, "status"),
  };
}

function buildHealthHistoryArtifact(latest, date) {
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: latest.generated_at,
    date,
    probe_started_at: latest.probe_started_at || null,
    probe_finished_at: latest.probe_finished_at || null,
    source: latest.source,
    summary: latest.summary,
    surfaces: latest.surfaces.map((surface) => ({
      classification: surface.classification || "unknown",
      error_class: surface.error_class || null,
      kind: surface.kind,
      last_checked: surface.last_checked || null,
      last_ok: surface.last_ok || null,
      latency_ms: Number.isFinite(surface.latency_ms)
        ? surface.latency_ms
        : null,
      netuid: surface.netuid,
      provider: surface.provider,
      status: surface.status,
      status_code: Number.isInteger(surface.status_code)
        ? surface.status_code
        : null,
      surface_id: surface.surface_id,
      verified_at: surface.verified_at || null,
    })),
  };
}

function summarizeSubnet(subnet, subnetSurfaces) {
  const okCount = subnetSurfaces.filter(
    (surface) => surface.status === "ok",
  ).length;
  const failedCount = subnetSurfaces.filter(
    (surface) => surface.status === "failed",
  ).length;
  const degradedCount = subnetSurfaces.filter(
    (surface) => surface.status === "degraded",
  ).length;
  const unknownCount = subnetSurfaces.filter(
    (surface) => surface.status === "unknown",
  ).length;
  return {
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    status: classifySubnetStatus({
      okCount,
      failedCount,
      degradedCount,
      unknownCount,
      surfaceCount: subnetSurfaces.length,
    }),
    surface_count: subnetSurfaces.length,
    ok_count: okCount,
    failed_count: failedCount,
    degraded_count: degradedCount,
    unknown_count: unknownCount,
    last_checked: latestString(
      subnetSurfaces.map(
        (surface) => surface.verified_at || surface.last_checked,
      ),
    ),
    last_ok: latestString(subnetSurfaces.map((surface) => surface.last_ok)),
    avg_latency_ms: average(
      subnetSurfaces
        .map((surface) => surface.latency_ms)
        .filter(Number.isFinite),
    ),
  };
}

function classifySubnetStatus({
  okCount,
  failedCount,
  degradedCount,
  unknownCount,
  surfaceCount,
}) {
  if (surfaceCount === 0 || unknownCount === surfaceCount) {
    return "unknown";
  }
  if (failedCount === 0 && degradedCount === 0) {
    return "ok";
  }
  if (okCount > 0 || degradedCount > 0) {
    return "degraded";
  }
  return "failed";
}

async function loadPriorHistory() {
  const historyRoot = path.join(outputRoot, "health/history");
  let entries;
  try {
    entries = await fs.readdir(historyRoot, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const bySurface = new Map();
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-30)) {
    try {
      const artifact = JSON.parse(
        await fs.readFile(path.join(historyRoot, entry.name), "utf8"),
      );
      for (const surface of artifact.surfaces || []) {
        const history = bySurface.get(surface.surface_id) || [];
        history.push(surface);
        bySurface.set(surface.surface_id, history);
      }
    } catch {
      // Ignore malformed historical snapshots; validate catches current artifacts.
    }
  }
  return bySurface;
}

function uptimeRatio(history) {
  if (history.length === 0) {
    return null;
  }
  const recent = history.slice(-30);
  return Number(
    (
      recent.filter((entry) => entry.status === "ok").length / recent.length
    ).toFixed(4),
  );
}

function badgeColor(status) {
  return (
    {
      ok: "brightgreen",
      degraded: "yellow",
      failed: "red",
      unknown: "lightgrey",
    }[status] || "lightgrey"
  );
}

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const results = [];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        results.push(await mapper(item));
      }
    },
  );
  await Promise.all(workers);
  return results.sort(
    (a, b) =>
      a.subnet_slug.localeCompare(b.subnet_slug) ||
      a.surface_id.localeCompare(b.surface_id),
  );
}

function groupByNetuid(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.netuid) || [];
    group.push(item);
    groups.set(item.netuid, group);
  }
  return groups;
}

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function latestString(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}
