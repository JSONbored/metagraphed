// Pure, isomorphic helpers for the metagraph.sh change-feed webhooks.
//
// metagraph.sh regenerates its dataset on an event-driven publish (ADR 0007), so the
// "real-time" surface is honestly a CHANGE FEED: a notification pushed within
// seconds of each publish, not a sub-second tail. These helpers are shared by
// the Worker (subscription routes + SSE) and the publish-time dispatch script.
// They perform NO I/O — KV and fetch are injected by callers — so every branch
// is unit-testable. Runs unchanged on the Workers runtime and Node 22 (both
// expose Web Crypto + TextEncoder + URL).

export const WEBHOOK_KV_PREFIX = "webhooks:sub:";
export const WEBHOOK_SIGNATURE_HEADER = "x-metagraph-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-metagraph-timestamp";
export const WEBHOOK_SECRET_HEADER = "x-metagraph-webhook-secret";
export const WEBHOOK_EVENT_TYPE = "metagraph.publish";

const MAX_FILTER_NETUIDS = 64;
const MAX_FILTER_KINDS = 8;
const VALID_CHANGE_KINDS = new Set(["subnets", "artifacts"]);

export function subscriptionStorageKey(id) {
  return `${WEBHOOK_KV_PREFIX}${id}`;
}

// --- URL safety: best-effort SSRF guard ---------------------------------------
// Blocks non-https URLs, embedded credentials, non-standard ports, localhost-like
// names, literal private/loopback/link-local IPs, unsafe DNS answers when a
// resolver is injected, and redirects at delivery time.
const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^255\./,
];

function normalizedHostname(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isIpv4Literal(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isLiteralIp(host) {
  return isIpv4Literal(host) || host.includes(":");
}

export function isPublicWebhookAddress(value) {
  const host = normalizedHostname(value);
  if (!host) return false;

  if (host.includes(":")) {
    if (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fe80") || // link-local
      host.startsWith("fc") || // unique-local fc00::/7
      host.startsWith("fd") ||
      host.startsWith("::ffff:") // IPv4-mapped
    ) {
      return false;
    }
    return true;
  }

  if (isIpv4Literal(host)) {
    return !PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host));
  }

  return false;
}

export function isPublicWebhookUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;

  // URL keeps the brackets on an IPv6 literal hostname; strip them so the
  // private-range prefix checks below see the bare address.
  const host = normalizedHostname(url.hostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".internal") || host.endsWith(".local")) return false;

  if (isLiteralIp(host)) return isPublicWebhookAddress(host);

  // Registrable hostname: require at least one dot so bare labels ("router")
  // that may resolve to LAN hosts are rejected.
  return host.includes(".");
}

export async function isResolvedPublicWebhookUrl(value, resolveHostnames) {
  if (!isPublicWebhookUrl(value)) return false;
  if (typeof resolveHostnames !== "function") return true;

  let host;
  try {
    host = normalizedHostname(new URL(String(value)).hostname);
  } catch {
    return false;
  }
  if (isLiteralIp(host)) return isPublicWebhookAddress(host);

  let addresses;
  try {
    addresses = await resolveHostnames(host);
  } catch {
    return false;
  }
  return (
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.every((address) => isPublicWebhookAddress(address))
  );
}

// --- subscription validation --------------------------------------------------
export function normalizeFilters(filters) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== "object" || Array.isArray(filters)) return null;
  const out = {};

  if (filters.netuids !== undefined) {
    if (!Array.isArray(filters.netuids)) return null;
    if (filters.netuids.length > MAX_FILTER_NETUIDS) return null;
    const clean = [];
    for (const netuid of filters.netuids) {
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        return null;
      if (!clean.includes(netuid)) clean.push(netuid);
    }
    out.netuids = clean.sort((a, b) => a - b);
  }

  if (filters.kinds !== undefined) {
    if (!Array.isArray(filters.kinds)) return null;
    if (filters.kinds.length > MAX_FILTER_KINDS) return null;
    const clean = [];
    for (const kind of filters.kinds) {
      if (typeof kind !== "string" || !VALID_CHANGE_KINDS.has(kind))
        return null;
      if (!clean.includes(kind)) clean.push(kind);
    }
    out.kinds = clean.sort();
  }

  return out;
}

export function validateSubscriptionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  if (typeof input.url !== "string" || !isPublicWebhookUrl(input.url)) {
    return {
      ok: false,
      error:
        "`url` must be a public https:// URL (no credentials, no private/loopback hosts, default port).",
    };
  }
  const filters = normalizeFilters(input.filters);
  if (filters === null) {
    return {
      ok: false,
      error:
        '`filters` must be an object {netuids?: integer[], kinds?: ("subnets"|"artifacts")[]}.',
    };
  }
  let secret = null;
  if (input.secret !== undefined) {
    if (
      typeof input.secret !== "string" ||
      input.secret.length < 16 ||
      input.secret.length > 256
    ) {
      return {
        ok: false,
        error: "`secret`, when provided, must be a 16-256 character string.",
      };
    }
    secret = input.secret;
  }
  return { ok: true, value: { url: input.url, filters, secret } };
}

// --- change-event construction ------------------------------------------------
// Map a per-subnet artifact path back to its netuid for netuid-scoped filters.
const NETUID_ARTIFACT_PATTERN =
  /(?:^|\/)(?:subnets|surfaces|profiles|endpoints|candidates|evidence|health\/subnets|health\/badges|verification\/subnets|review\/gaps)\/(\d+)\.json$/;

function netuidFromArtifactPath(artifactPath) {
  const match = String(artifactPath || "").match(NETUID_ARTIFACT_PATTERN);
  return match ? Number(match[1]) : null;
}

function artifactPaths(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((value) => typeof value === "string" && value.length > 0);
}

// Build the public change-feed payload from changelog.json + the KV `latest`
// pointer. Deterministic and side-effect-free.
export function buildChangeEvent({ changelog, pointer } = {}) {
  const cl = changelog && typeof changelog === "object" ? changelog : {};
  const artifacts =
    cl.artifacts && typeof cl.artifacts === "object" ? cl.artifacts : {};
  const subnets =
    cl.subnets && typeof cl.subnets === "object" ? cl.subnets : {};

  const added = artifactPaths(artifacts.added);
  const modified = artifactPaths(artifacts.modified);
  const removed = artifactPaths(artifacts.removed);
  const subnetsAdded = Array.isArray(subnets.added) ? subnets.added : [];
  const subnetsRemoved = Array.isArray(subnets.removed) ? subnets.removed : [];
  const subnetsRenamed = Array.isArray(subnets.renamed) ? subnets.renamed : [];

  const netuids = new Set();
  for (const entry of [...subnetsAdded, ...subnetsRemoved, ...subnetsRenamed]) {
    const netuid =
      typeof entry === "number"
        ? entry
        : entry && typeof entry.netuid === "number"
          ? entry.netuid
          : null;
    if (netuid !== null) netuids.add(netuid);
  }
  for (const path of [...added, ...modified, ...removed]) {
    const netuid = netuidFromArtifactPath(path);
    if (netuid !== null) netuids.add(netuid);
  }

  const hasArtifactChanges =
    added.length + modified.length + removed.length > 0;
  const hasSubnetChanges =
    subnetsAdded.length + subnetsRemoved.length + subnetsRenamed.length > 0;

  return {
    type: WEBHOOK_EVENT_TYPE,
    published_at: pointer?.published_at ?? null,
    generated_at: cl.generated_at ?? null,
    contract_version: cl.contract_version ?? pointer?.contract_version ?? null,
    change_kinds: [
      hasSubnetChanges ? "subnets" : null,
      hasArtifactChanges ? "artifacts" : null,
    ].filter(Boolean),
    affected_netuids: [...netuids].sort((a, b) => a - b),
    summary: {
      artifacts: {
        added: added.length,
        modified: modified.length,
        removed: removed.length,
      },
      subnets: {
        added: subnetsAdded.length,
        removed: subnetsRemoved.length,
        renamed: subnetsRenamed.length,
      },
    },
    subnets: {
      added: subnetsAdded,
      removed: subnetsRemoved,
      renamed: subnetsRenamed,
    },
    artifacts: { added, modified, removed },
  };
}

export function eventMatchesFilters(event, filters) {
  if (
    !filters ||
    (filters.netuids === undefined && filters.kinds === undefined)
  ) {
    return true;
  }
  if (Array.isArray(filters.kinds) && filters.kinds.length > 0) {
    const eventKinds = new Set(event?.change_kinds || []);
    if (!filters.kinds.some((kind) => eventKinds.has(kind))) return false;
  }
  if (Array.isArray(filters.netuids) && filters.netuids.length > 0) {
    const affected = new Set(event?.affected_netuids || []);
    if (!filters.netuids.some((netuid) => affected.has(netuid))) return false;
  }
  return true;
}

// --- HMAC signing -------------------------------------------------------------
export async function signPayload(secret, bodyText) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(String(bodyText)),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

// --- identifiers --------------------------------------------------------------
export function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateSubscriptionId() {
  return crypto.randomUUID();
}

// A subscription id is a UUID v4; validate before using it as a KV key.
export function isValidSubscriptionId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(id),
  );
}

// Strip the secret before returning a subscription to a client.
export function publicSubscriptionView(record) {
  if (!record || typeof record !== "object") return null;
  return {
    id: record.id,
    url: record.url,
    filters: record.filters || {},
    created_at: record.created_at ?? null,
    active: record.active !== false,
  };
}

// --- delivery (publish-time dispatch) -----------------------------------------
// Deliver one change event to one subscription. Pure w.r.t. I/O: `fetchFn` and
// `now` are injected so the dispatcher is fully unit-testable. Re-validates the
// URL at delivery time (defense in depth vs. a record that slipped past intake),
// skips on filter mismatch, signs with HMAC-SHA256, and retries transient
// failures (network/timeout/5xx/429) but not deterministic 4xx rejections.
export async function deliverChangeEvent({
  subscription,
  event,
  fetchFn,
  now,
  timeoutMs = 8000,
  maxAttempts = 3,
  backoffBaseMs = 500,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  resolveHostnames,
}) {
  if (!subscription || typeof subscription.url !== "string") {
    return {
      id: subscription?.id ?? null,
      status: "skipped",
      reason: "invalid",
    };
  }
  if (!isPublicWebhookUrl(subscription.url)) {
    return { id: subscription.id, status: "skipped", reason: "unsafe-url" };
  }
  if (!eventMatchesFilters(event, subscription.filters)) {
    return { id: subscription.id, status: "filtered" };
  }
  if (typeof subscription.secret !== "string" || !subscription.secret) {
    return { id: subscription.id, status: "skipped", reason: "no-secret" };
  }
  if (!(await isResolvedPublicWebhookUrl(subscription.url, resolveHostnames))) {
    return { id: subscription.id, status: "skipped", reason: "unsafe-url" };
  }

  const bodyText = JSON.stringify(event);
  const timestamp =
    typeof now === "function" ? now() : new Date(0).toISOString();
  const signature = await signPayload(subscription.secret, bodyText);
  const headers = {
    "content-type": "application/json",
    "user-agent": "metagraphed-webhook/1.0",
    [WEBHOOK_SIGNATURE_HEADER]: signature,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
  };

  let lastReason = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchFn(subscription.url, {
        method: "POST",
        headers,
        body: bodyText,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastReason = error?.name === "TimeoutError" ? "timeout" : "network-error";
      response = null; // transient — fall through to backoff + retry
    }
    if (response) {
      const status = response.status;
      if (status >= 200 && status < 300) {
        return {
          id: subscription.id,
          status: "delivered",
          status_code: status,
          attempts: attempt,
        };
      }
      lastReason = `http-${status}`;
      if (status >= 300 && status < 400) {
        return {
          id: subscription.id,
          status: "failed",
          status_code: status,
          reason: "redirect-not-followed",
          attempts: attempt,
        };
      }
      // 4xx (except 429) is a deterministic rejection — do not retry.
      if (status >= 400 && status < 500 && status !== 429) {
        return {
          id: subscription.id,
          status: "failed",
          status_code: status,
          reason: lastReason,
          attempts: attempt,
        };
      }
      // 5xx / 429 — fall through to backoff + retry.
    }
    // Transient failure (network/timeout/5xx/429): exponential backoff before
    // the next attempt — 500ms, 1s, 2s… — skipped after the final attempt so a
    // permanently-down endpoint doesn't add a trailing wait.
    if (attempt < maxAttempts) {
      await sleepFn(backoffBaseMs * 2 ** (attempt - 1));
    }
  }
  return {
    id: subscription.id,
    status: "failed",
    reason: lastReason,
    attempts: maxAttempts,
  };
}

// Bounded fan-out over many subscriptions. Concurrency-capped; never rejects —
// each subscription resolves to a result record (delivered/failed/filtered/
// skipped) so one bad endpoint can't sink the batch.
export async function dispatchChangeEvent({
  subscriptions,
  event,
  fetchFn,
  now,
  timeoutMs,
  maxAttempts,
  resolveHostnames,
  concurrency = 8,
}) {
  const queue = [...(subscriptions || [])];
  const results = [];
  const worker = async () => {
    while (queue.length > 0) {
      const subscription = queue.shift();
      const result = await deliverChangeEvent({
        subscription,
        event,
        fetchFn,
        now,
        timeoutMs,
        maxAttempts,
        resolveHostnames,
      });
      results.push(result);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
