import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";

export const repoRoot = new URL("..", import.meta.url).pathname;

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${stableStringify(value)}\n`, "utf8");
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
    ["unknown", "none", "null", "n/a", "na", "unnamed"].includes(normalized)
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

    return isUnsafeHostname(url.hostname);
  } catch {
    return true;
  }
}

export async function isUnsafeUrlResolved(value, resolver = dnsLookup) {
  if (isUnsafeUrl(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    const host = normalizeHostname(url.hostname);
    if (isIP(host)) {
      return false;
    }

    const records = await resolver(host, { all: true, verbatim: true });
    return records.some((record) => isUnsafeHostname(record.address));
  } catch {
    return false;
  }
}

export function isUnsafeHostname(hostname) {
  const host = normalizeHostname(hostname);
  const literalIp = isIP(host);
  if (host === "localhost") {
    return true;
  }
  if (literalIp === 4) {
    return isUnsafeIpv4(host);
  }
  if (literalIp === 6) {
    return isUnsafeIpv6(host);
  }

  return false;
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isUnsafeIpv4(host) {
  const octets = host.split(".").map((part) => Number(part));
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isUnsafeIpv6(host) {
  const value = parseIpv6(host);
  if (value === null) {
    return true;
  }

  if (value === 0n || value === 1n) {
    return true;
  }

  const mappedPrefix = 0xffffn << 32n;
  if (value >> 32n === mappedPrefix >> 32n) {
    return isUnsafeIpv4(bigIntToIpv4(value & 0xffffffffn));
  }

  return (
    inIpv6Range(value, 0xfc00n << 112n, 7n) ||
    inIpv6Range(value, 0xfe80n << 112n, 10n) ||
    inIpv6Range(value, 0xfec0n << 112n, 10n) ||
    inIpv6Range(value, 0xff00n << 112n, 8n)
  );
}

function inIpv6Range(value, prefix, bits) {
  return value >> (128n - bits) === prefix >> (128n - bits);
}

function parseIpv6(host) {
  const normalized = host.includes(".") ? expandEmbeddedIpv4(host) : host;
  const parts = normalized.split("::");
  if (parts.length > 2) {
    return null;
  }

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) {
    return null;
  }

  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) {
    return null;
  }

  return groups.reduce((accumulator, group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    const parsed = BigInt(`0x${group}`);
    return accumulator === null ? null : (accumulator << 16n) + parsed;
  }, 0n);
}

function expandEmbeddedIpv4(host) {
  const lastColon = host.lastIndexOf(":");
  const prefix = host.slice(0, lastColon + 1);
  const octets = host
    .slice(lastColon + 1)
    .split(".")
    .map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) {
    return host;
  }

  const high = (octets[0] << 8) + octets[1];
  const low = (octets[2] << 8) + octets[3];
  return `${prefix}${high.toString(16)}:${low.toString(16)}`;
}

function bigIntToIpv4(value) {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 255n))
    .join(".");
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

export function buildEndpointPoolArtifact({
  generatedAt,
  contractVersion,
  rpcArtifact,
}) {
  const endpoints = (rpcArtifact.endpoints || []).map((endpoint) => {
    const score = endpointScore(endpoint);
    return {
      ...endpoint,
      score,
      pool_eligible:
        endpoint.status === "ok" &&
        endpoint.auth_required === false &&
        endpoint.public_safe === true,
      unsafe_methods_blocked: true,
    };
  });

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "rpc-endpoint-probes",
    notes: [
      "Endpoint pools are advisory only in v1.",
      "Future proxy/load-balancer routes must block write and unsafe RPC methods by default.",
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
      latency_ms: endpoint.latency_ms,
      latest_block: endpoint.latest_block,
      pool_eligible: endpoint.pool_eligible,
      provider: endpoint.provider,
      score: endpoint.score,
      status: endpoint.status,
      url: endpoint.url,
    })),
  };
}

function endpointScore(endpoint) {
  let score = 0;
  if (endpoint.status === "ok") score += 50;
  if (endpoint.archive_support === true) score += 15;
  if (endpoint.latest_block) score += 10;
  if (
    endpoint.methods_supported &&
    typeof endpoint.methods_supported === "object"
  ) {
    score += Math.min(
      Object.values(endpoint.methods_supported).filter(Boolean).length * 5,
      20,
    );
  } else if (Array.isArray(endpoint.methods_supported)) {
    score += Math.min(endpoint.methods_supported.length, 20);
  }
  if (Number.isFinite(endpoint.latency_ms))
    score += Math.max(0, 20 - Math.round(endpoint.latency_ms / 100));
  if (endpoint.auth_required) score -= 25;
  if (endpoint.status === "degraded") score -= 10;
  if (endpoint.status === "failed") score -= 50;
  return Math.max(0, score);
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
