import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import {
  ARTIFACT_STORAGE_TIERS,
  R2_STAGING_RELATIVE_ROOT,
  artifactRelativePath,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";

export const repoRoot = new URL("..", import.meta.url).pathname;
export const publicMetagraphRoot = path.join(repoRoot, "public/metagraph");
export const r2StagingRoot = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);

const credentialedUrlParams = new Set([
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
  "x-goog-credential",
  "x-goog-signature",
  "x-goog-security-token",
  "x-goog-signedheaders",
  "x-goog-expires",
  "x-oss-signature",
  "x-oss-credential",
]);

const unsafeIpBlocks = new BlockList();
unsafeIpBlocks.addSubnet("0.0.0.0", 8);
unsafeIpBlocks.addSubnet("10.0.0.0", 8);
unsafeIpBlocks.addSubnet("100.64.0.0", 10);
unsafeIpBlocks.addSubnet("127.0.0.0", 8);
unsafeIpBlocks.addSubnet("169.254.0.0", 16);
unsafeIpBlocks.addSubnet("172.16.0.0", 12);
unsafeIpBlocks.addSubnet("192.0.0.0", 24);
unsafeIpBlocks.addSubnet("192.168.0.0", 16);
unsafeIpBlocks.addSubnet("198.18.0.0", 15);
unsafeIpBlocks.addSubnet("224.0.0.0", 4);
unsafeIpBlocks.addSubnet("255.255.255.255", 32);
unsafeIpBlocks.addSubnet("::", 128, "ipv6");
unsafeIpBlocks.addSubnet("::1", 128, "ipv6");
unsafeIpBlocks.addSubnet("64:ff9b:1::", 48, "ipv6");
unsafeIpBlocks.addSubnet("100::", 64, "ipv6");
unsafeIpBlocks.addSubnet("fc00::", 7, "ipv6");
unsafeIpBlocks.addSubnet("fe80::", 10, "ipv6");
unsafeIpBlocks.addSubnet("ff00::", 8, "ipv6");

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function readArtifactJson(relativePath) {
  return readJson(artifactFilePath(relativePath));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${stableStringify(value)}\n`, "utf8");
}

export function artifactFilePath(relativePath, options = {}) {
  const normalized = artifactRelativePath(relativePath);
  const tier = artifactStorageTierForRelativePath(normalized);
  if (tier !== ARTIFACT_STORAGE_TIERS.r2) {
    return path.join(publicMetagraphRoot, normalized);
  }

  const stagedPath = path.join(r2StagingRoot, normalized);
  const publicPath = path.join(publicMetagraphRoot, normalized);
  const allowPublicFallback = options.allowPublicFallback !== false;
  if (existsSync(stagedPath) || !allowPublicFallback) {
    return stagedPath;
  }
  return publicPath;
}

export function artifactOutputPath(relativePath) {
  const normalized = artifactRelativePath(relativePath);
  const tier = artifactStorageTierForRelativePath(normalized);
  return path.join(
    tier === ARTIFACT_STORAGE_TIERS.r2 ? r2StagingRoot : publicMetagraphRoot,
    normalized,
  );
}

export function artifactDirectoryPath(relativePath) {
  const normalized = artifactRelativePath(relativePath).replace(/\/+$/, "");
  const stagedPath = path.join(r2StagingRoot, normalized);
  if (existsSync(stagedPath)) {
    return stagedPath;
  }
  return path.join(publicMetagraphRoot, normalized);
}

export function createLocalArtifactEnv(overrides = {}) {
  return {
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        const filePath = path.join(
          repoRoot,
          "public",
          url.pathname.replace(/^\/+/, ""),
        );
        try {
          const body = await fs.readFile(filePath);
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": filePath.endsWith(".json")
                ? "application/json"
                : "application/octet-stream",
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_ARCHIVE: {
      async get(key) {
        const relativePath = String(key).replace(/^latest\//, "");
        const filePath = artifactFilePath(relativePath);
        try {
          const body = await fs.readFile(filePath, "utf8");
          return {
            async json() {
              return JSON.parse(body);
            },
            async text() {
              return body;
            },
          };
        } catch {
          return null;
        }
      },
    },
    ...overrides,
  };
}

export async function listJsonFiles(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function listJsonFilesRecursive(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFilesRecursive(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export async function loadProviders() {
  const files = await listJsonFiles(path.join(repoRoot, "registry/providers"));
  return Promise.all(files.map(readJson));
}

export async function loadSubnets() {
  const files = await listJsonFilesRecursive(
    path.join(repoRoot, "registry/subnets"),
  );
  const subnets = await Promise.all(files.map(readJson));
  return subnets.sort(
    (a, b) => a.netuid - b.netuid || a.slug.localeCompare(b.slug),
  );
}

export async function loadNativeSnapshot() {
  return readJson(path.join(repoRoot, "registry/native/finney-subnets.json"));
}

export async function loadCandidates() {
  const files = await listJsonFilesRecursive(
    path.join(repoRoot, "registry/candidates"),
  );
  const documents = await Promise.all(files.map(readJson));
  const candidates = documents.flatMap((document) => {
    if (Array.isArray(document.candidates)) {
      return document.candidates;
    }
    return [document];
  });
  return candidates.sort(
    (a, b) => a.netuid - b.netuid || a.id.localeCompare(b.id),
  );
}

export async function loadVerification() {
  try {
    return await readJson(
      path.join(repoRoot, "registry/verification/latest.json"),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schema_version: 1,
        generated_at: null,
        results: [],
      };
    }
    throw error;
  }
}

export function flattenSurfaces(subnets) {
  return subnets
    .flatMap((subnet) =>
      subnet.surfaces.map((surface) => ({
        ...surface,
        netuid: subnet.netuid,
        subnet_slug: subnet.slug,
        subnet_name: subnet.name,
      })),
    )
    .sort((a, b) => a.netuid - b.netuid || a.id.localeCompare(b.id));
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

export function nativeNameQuality(subnet) {
  const rawName =
    typeof subnet?.raw_name === "string" ? subnet.raw_name : subnet?.name;
  return classifyNativeName(rawName, subnet?.netuid).quality;
}

export function nativeDisplayName(subnet, fallbackName = null) {
  const quality = nativeNameQuality(subnet);
  const candidate =
    quality === "chain"
      ? typeof subnet?.raw_name === "string"
        ? subnet.raw_name
        : subnet?.name
      : fallbackName;
  return candidate || `Subnet ${subnet?.netuid ?? "unknown"}`;
}

export function classifyNativeName(value, netuid) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return { raw_name: null, quality: "empty" };
  }

  const normalized = raw.toLowerCase();
  const genericName =
    Number.isInteger(netuid) && normalized === `subnet ${netuid}`.toLowerCase();
  if (
    genericName ||
    ["unknown", "none", "null", "n/a", "na", "unnamed"].includes(normalized) ||
    !/[\p{L}\p{N}]/u.test(raw)
  ) {
    return { raw_name: raw, quality: "placeholder" };
  }

  return { raw_name: raw, quality: "chain" };
}

export function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }

  return value;
}

export function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:", "wss:", "ws:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isUnsafeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    return isUnsafeHostname(host);
  } catch {
    return true;
  }
}

export async function isUnsafeResolvedUrl(value, resolver = lookup) {
  try {
    const url = new URL(value);
    if (isUnsafeUrl(url.toString())) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    if (isIP(host)) {
      return false;
    }

    const records = await resolver(host, { all: true, verbatim: true });
    return (
      records.length === 0 ||
      records.some((record) => isUnsafeIpAddress(record.address))
    );
  } catch {
    return true;
  }
}

function isUnsafeHostname(host) {
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  return isUnsafeIpAddress(host);
}

function isUnsafeIpAddress(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  return (
    family !== 0 &&
    unsafeIpBlocks.check(normalized, family === 4 ? "ipv4" : "ipv6")
  );
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

export function isCredentialedUrl(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (credentialedUrlParams.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function redactCredentialedUrl(value) {
  if (!isCredentialedUrl(value)) {
    return value;
  }

  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function redactCredentialedUrls(value) {
  if (Array.isArray(value)) {
    return value.map(redactCredentialedUrls);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactCredentialedUrls(nested),
      ]),
    );
  }

  return typeof value === "string" ? redactCredentialedUrl(value) : value;
}

export function normalizePublicUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value
    .trim()
    .replace(/^<|>$/g, "")
    .split("](")[0]
    .replace(/\]+$/g, "");
  if (!candidate) {
    return null;
  }

  if (
    !/^(https?|wss?):\/\//i.test(candidate) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)
  ) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      isUnsafeUrl(url.toString())
    ) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function registrySurfaceKey(entry) {
  const normalizedUrl = normalizePublicUrl(entry?.url);
  return [
    entry?.netuid ?? "unknown",
    entry?.kind || "unknown",
    normalizedUrl || entry?.url || "unknown",
  ]
    .join("|")
    .toLowerCase();
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

export function isJsonContentType(value) {
  return String(value || "")
    .toLowerCase()
    .includes("json");
}

export function isHtmlContentType(value) {
  return String(value || "")
    .toLowerCase()
    .includes("html");
}

export function buildTimestamp() {
  return process.env.METAGRAPH_BUILD_TIMESTAMP || "1970-01-01T00:00:00.000Z";
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function buildRpcEndpointArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces
    .filter((surface) =>
      ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
    )
    .map((surface) => {
      const health = healthBySurface.get(surface.id) || {};
      return {
        id: surface.id,
        netuid: surface.netuid,
        subnet_slug: surface.subnet_slug,
        subnet_name: surface.subnet_name,
        chain: "bittensor",
        network: "finney",
        kind: surface.kind,
        url: surface.url,
        provider: surface.provider,
        authority: surface.authority,
        auth_required: surface.auth_required,
        public_safe: surface.public_safe,
        archive_support: health.archive_support ?? null,
        latest_block: health.latest_block ?? null,
        methods_supported: health.methods_supported || null,
        rpc_method_count: health.rpc_method_count ?? null,
        method_tested: health.method_tested || surface.probe?.method || null,
        status: health.status || "unknown",
        classification: health.classification || "unknown",
        latency_ms: health.latency_ms ?? null,
        last_checked: health.verified_at || health.last_checked || null,
        error: health.error || null,
        rate_limit_notes: surface.rate_limit_notes || null,
        source_urls: surface.source_urls || [],
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes:
      "Bittensor base-layer RPC endpoints only. These are chain-level surfaces, not subnet application APIs.",
    summary: {
      endpoint_count: endpoints.length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
      archive_supported_count: endpoints.filter(
        (endpoint) => endpoint.archive_support === true,
      ).length,
    },
    endpoints,
  };
}

export function buildEndpointResourceArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces.map((surface) => {
    const health = healthBySurface.get(surface.id) || {};
    const monitored = surface.probe?.enabled === true && surface.public_safe;
    const scoreBreakdown = endpointScoreBreakdown({
      ...surface,
      ...health,
      status: health.status || "unknown",
    });
    const poolEligibility = endpointPoolEligibility({
      ...surface,
      status: health.status || "unknown",
    });

    return {
      id: `endpoint-${surface.id}`,
      surface_id: surface.id,
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      subnet_name: surface.subnet_name,
      chain: "bittensor",
      network: "finney",
      layer: endpointLayer(surface.kind),
      kind: surface.kind,
      url: surface.url,
      provider: surface.provider,
      operator: surface.provider,
      authority: surface.authority,
      auth_required: surface.auth_required,
      public_safe: surface.public_safe,
      monitoring_policy: endpointMonitoringPolicy(surface),
      monitoring_status: monitored ? "monitored" : "not_monitored",
      publication_state: endpointPublicationState({
        monitored,
        poolEligible: poolEligibility.eligible,
        surface,
      }),
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons: poolEligibility.reasons,
      archive_support: health.archive_support ?? null,
      latest_block: health.latest_block ?? null,
      method_support: health.methods_supported || null,
      rpc_method_count: health.rpc_method_count ?? null,
      method_tested: health.method_tested || surface.probe?.method || null,
      status: monitored ? health.status || "unknown" : "unknown",
      classification: monitored
        ? health.classification || "unknown"
        : "unknown",
      latency_ms: monitored ? (health.latency_ms ?? null) : null,
      score: scoreBreakdown.score,
      score_reasons: scoreBreakdown.reasons,
      last_checked: monitored
        ? health.verified_at || health.last_checked || null
        : null,
      error: monitored ? health.error || null : null,
      rate_limit_notes: surface.rate_limit_notes || null,
      source_urls: surface.source_urls || [],
    };
  });

  endpoints.sort(
    (a, b) =>
      a.netuid - b.netuid ||
      a.layer.localeCompare(b.layer) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes: [
      "Endpoint resources are normalized from curated public surfaces.",
      "Observed health, latency, and pool eligibility are probe-derived only.",
      "Subnet application APIs are heterogeneous and are not proxied in v1.",
    ],
    summary: {
      endpoint_count: endpoints.length,
      monitored_count: endpoints.filter(
        (endpoint) => endpoint.monitoring_status === "monitored",
      ).length,
      pool_eligible_count: endpoints.filter(
        (endpoint) => endpoint.pool_eligible,
      ).length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_layer: countRecord(endpoints, (endpoint) => endpoint.layer),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_publication_state: countRecord(
        endpoints,
        (endpoint) => endpoint.publication_state,
      ),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
    },
    endpoints,
  };
}

export function buildEndpointPoolArtifact({
  generatedAt,
  contractVersion,
  rpcArtifact = null,
  endpointArtifact = null,
}) {
  const sourceArtifact = endpointArtifact || rpcArtifact || { endpoints: [] };
  const endpoints = (sourceArtifact.endpoints || []).map((endpoint) => {
    const scoreBreakdown = endpointScoreBreakdown(endpoint);
    const poolEligibility = endpointPoolEligibility(endpoint);
    return {
      ...endpoint,
      score: scoreBreakdown.score,
      score_reasons: endpoint.score_reasons || scoreBreakdown.reasons,
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons:
        endpoint.pool_eligibility_reasons || poolEligibility.reasons,
      unsafe_methods_blocked: true,
    };
  });

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: endpointArtifact
      ? "endpoint-resource-probes"
      : "rpc-endpoint-probes",
    notes: [
      "Endpoint pools are advisory only in v1.",
      "Future proxy/load-balancer routes must block write and unsafe RPC methods by default.",
      "Only Bittensor base-layer RPC/WSS endpoints are pool candidates in v1.",
    ],
    disabled_proxy_contract: {
      enabled: false,
      allowed_methods: [
        "chain_getHeader",
        "chain_getBlockHash",
        "system_health",
        "rpc_methods",
      ],
      denied_method_patterns: [
        "author_",
        "state_call",
        "sudo_",
        "payment_",
        "contracts_",
      ],
      feature_flag: "METAGRAPH_ENABLE_RPC_PROXY",
      rate_limit_required: true,
      waf_required: true,
    },
    eligibility_policy: {
      source: "probe-derived",
      eligible_layers: ["bittensor-base"],
      required_status: "ok",
      requires_public_safe: true,
      requires_no_auth: true,
      user_reports_can_change_health: false,
      notes:
        "Pool eligibility is derived from monitored endpoint state only. Contributor reports can trigger review or re-probes, but cannot set health or uptime.",
    },
    provider_scores: endpointProviderScores(endpoints),
    pools: [
      endpointPool("finney-rpc", "subtensor-rpc", endpoints),
      endpointPool("finney-wss", "subtensor-wss", endpoints),
      endpointPool(
        "finney-archive",
        "archive",
        endpoints.filter((endpoint) => endpoint.archive_support === true),
      ),
    ],
  };
}

function endpointPool(id, kind, endpoints) {
  const poolEndpoints = endpoints
    .filter((endpoint) => kind === "archive" || endpoint.kind === kind)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999) ||
        a.id.localeCompare(b.id),
    );
  return {
    id,
    kind,
    endpoint_count: poolEndpoints.length,
    eligible_count: poolEndpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    best_endpoint_id:
      poolEndpoints.find((endpoint) => endpoint.pool_eligible)?.id || null,
    endpoints: poolEndpoints.map((endpoint) => ({
      archive_support: endpoint.archive_support,
      id: endpoint.id,
      kind: endpoint.kind,
      layer: endpoint.layer || endpointLayer(endpoint.kind),
      latency_ms: endpoint.latency_ms,
      latest_block: endpoint.latest_block,
      pool_eligible: endpoint.pool_eligible,
      provider: endpoint.provider,
      score: endpoint.score,
      score_reasons: endpoint.score_reasons || [],
      status: endpoint.status,
      url: endpoint.url,
      pool_eligibility_reasons: endpoint.pool_eligibility_reasons || [],
    })),
  };
}

export function buildEndpointIncidentArtifact({
  endpointArtifact,
  generatedAt,
  contractVersion,
}) {
  const endpoints = endpointArtifact?.endpoints || [];
  const incidents = endpoints
    .filter((endpoint) => endpoint.monitoring_status === "monitored")
    .filter((endpoint) => ["failed", "degraded"].includes(endpoint.status))
    .map((endpoint) => {
      const severity = endpoint.status === "failed" ? "critical" : "warning";
      const reason =
        endpoint.error ||
        endpoint.classification ||
        `${endpoint.status} endpoint probe result`;
      return {
        id: `incident-${endpoint.id}`,
        endpoint_id: endpoint.id,
        surface_id: endpoint.surface_id,
        netuid: endpoint.netuid,
        subnet_slug: endpoint.subnet_slug,
        subnet_name: endpoint.subnet_name,
        layer: endpoint.layer,
        kind: endpoint.kind,
        provider: endpoint.provider,
        operator: endpoint.operator,
        status: endpoint.status,
        classification: endpoint.classification,
        severity,
        state: "active",
        reason,
        detected_at: endpoint.last_checked || generatedAt,
        last_checked: endpoint.last_checked,
        pool_eligible: false,
        user_reported: false,
        source: "probe-derived",
      };
    })
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.netuid - b.netuid ||
        a.kind.localeCompare(b.kind) ||
        a.endpoint_id.localeCompare(b.endpoint_id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "endpoint-resource-probes",
    notes: [
      "Endpoint incidents are generated from observed probe state only.",
      "Contributor reports can create review or re-probe work, but cannot set uptime, latency, health, or pool eligibility.",
      "Resolved incident history is expected to live in R2/D1 once persistent probe history is enabled.",
    ],
    summary: {
      incident_count: incidents.length,
      active_count: incidents.filter((incident) => incident.state === "active")
        .length,
      by_kind: countRecord(incidents, (incident) => incident.kind),
      by_layer: countRecord(incidents, (incident) => incident.layer),
      by_provider: countRecord(incidents, (incident) => incident.provider),
      by_severity: countRecord(incidents, (incident) => incident.severity),
      by_status: countRecord(incidents, (incident) => incident.status),
    },
    incidents,
  };
}

function endpointLayer(kind) {
  if (isBaseLayerEndpoint(kind) || kind === "archive") {
    return "bittensor-base";
  }
  if (
    ["subnet-api", "openapi", "sse", "dashboard", "sdk", "example"].includes(
      kind,
    )
  ) {
    return "subnet-app";
  }
  if (kind === "data-artifact") {
    return "data-provider";
  }
  return "docs-provider";
}

function isBaseLayerEndpoint(kind) {
  return ["subtensor-rpc", "subtensor-wss"].includes(kind);
}

function endpointMonitoringPolicy(surface) {
  if (!surface.probe) {
    return {
      enabled: false,
      method: null,
      expect: null,
      source: "not-configured",
    };
  }
  return {
    enabled: surface.probe.enabled === true,
    method: surface.probe.method || null,
    expect: surface.probe.expect || null,
    timeout_ms: surface.probe.timeout_ms || null,
    source: "surface-probe-config",
  };
}

function endpointPublicationState({ monitored, poolEligible, surface }) {
  if (surface.public_safe !== true) {
    return "disabled";
  }
  if (poolEligible) {
    return "pool-eligible";
  }
  if (monitored) {
    return "monitored";
  }
  return "verified";
}

function endpointScoreBreakdown(endpoint) {
  let score = 0;
  const reasons = [];
  function add(reason, points) {
    score += points;
    reasons.push({ reason, points });
  }

  if (endpoint.status === "ok") add("status-ok", 50);
  if (endpoint.archive_support === true) add("archive-support", 15);
  if (endpoint.latest_block) add("latest-block-observed", 10);
  const methodSupport = endpoint.methods_supported || endpoint.method_support;
  if (
    methodSupport &&
    typeof methodSupport === "object" &&
    !Array.isArray(methodSupport)
  ) {
    add(
      "method-support",
      Math.min(Object.values(methodSupport).filter(Boolean).length * 5, 20),
    );
  } else if (Array.isArray(methodSupport)) {
    add("method-support", Math.min(methodSupport.length, 20));
  }
  if (Number.isFinite(endpoint.latency_ms))
    add("latency", Math.max(0, 20 - Math.round(endpoint.latency_ms / 100)));
  if (endpoint.auth_required) add("auth-required", -25);
  if (endpoint.status === "degraded") add("status-degraded", -10);
  if (endpoint.status === "failed") add("status-failed", -50);

  return {
    score: Math.max(0, score),
    reasons: reasons.filter((reason) => reason.points !== 0),
  };
}

function endpointPoolEligibility(endpoint) {
  const reasons = [];
  if (!isBaseLayerEndpoint(endpoint.kind)) {
    reasons.push("not-bittensor-base-layer");
  }
  if (endpoint.status !== "ok") {
    reasons.push(`status-${endpoint.status || "unknown"}`);
  }
  if (endpoint.auth_required !== false) {
    reasons.push("auth-required");
  }
  if (endpoint.public_safe !== true) {
    reasons.push("not-public-safe");
  }
  return {
    eligible: reasons.length === 0,
    reasons: reasons.length ? reasons : ["eligible"],
  };
}

function endpointProviderScores(endpoints) {
  const providers = new Map();
  for (const endpoint of endpoints) {
    const provider = endpoint.provider || "unknown";
    const row = providers.get(provider) || {
      provider,
      endpoint_count: 0,
      monitored_count: 0,
      ok_count: 0,
      failed_count: 0,
      degraded_count: 0,
      pool_eligible_count: 0,
      score_total: 0,
    };
    row.endpoint_count += 1;
    if (endpoint.monitoring_status === "monitored") {
      row.monitored_count += 1;
    }
    if (endpoint.status === "ok") row.ok_count += 1;
    if (endpoint.status === "failed") row.failed_count += 1;
    if (endpoint.status === "degraded") row.degraded_count += 1;
    if (endpoint.pool_eligible) row.pool_eligible_count += 1;
    row.score_total += endpoint.score || 0;
    providers.set(provider, row);
  }

  return [...providers.values()]
    .map((row) => {
      const publicRow = { ...row };
      delete publicRow.score_total;
      return {
        ...publicRow,
        average_score: row.endpoint_count
          ? Math.round(row.score_total / row.endpoint_count)
          : 0,
        operational_score:
          row.endpoint_count === 0
            ? 0
            : Math.max(
                0,
                Math.round(
                  (row.ok_count / row.endpoint_count) * 70 +
                    (row.pool_eligible_count / row.endpoint_count) * 20 -
                    (row.failed_count / row.endpoint_count) * 30 -
                    (row.degraded_count / row.endpoint_count) * 10,
                ),
              ),
      };
    })
    .sort(
      (a, b) =>
        b.operational_score - a.operational_score ||
        b.average_score - a.average_score ||
        a.provider.localeCompare(b.provider),
    );
}

function severityRank(severity) {
  return { critical: 3, warning: 2, info: 1 }[severity] || 0;
}

function countRecord(items, keyFn) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        const key = keyFn(item) || "unknown";
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
