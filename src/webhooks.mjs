// Pure, isomorphic helpers for the metagraph.sh change-feed webhooks.
//
// metagraph.sh regenerates its dataset on an event-driven publish (ADR 0007), so the
// "real-time" surface is honestly a CHANGE FEED: a notification pushed within
// seconds of each publish, not a sub-second tail. These helpers are shared by
// the Worker (subscription routes + SSE) and the publish-time dispatch script.
// They perform NO I/O — KV and fetch are injected by callers — so every branch
// is unit-testable. Runs unchanged on the Workers runtime and Node 22 (both
// expose Web Crypto + TextEncoder + URL).
import { ipv6EmbeddedIpv4 } from "./ip-safety.mjs";

export const WEBHOOK_KV_PREFIX = "webhooks:sub:";
// Per-(subscription, event) delivery state for at-least-once redelivery: a failed
// transient delivery is parked here, retried on later runs, then dead-lettered.
export const WEBHOOK_DELIVERY_PREFIX = "webhooks:delivery:";
export const WEBHOOK_SIGNATURE_HEADER = "x-metagraph-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-metagraph-timestamp";
export const WEBHOOK_SECRET_HEADER = "x-metagraph-webhook-secret";
// Stable per-content event id + per-(subscription, event) idempotency key so a
// subscriber can dedupe the retries at-least-once delivery implies.
export const WEBHOOK_EVENT_ID_HEADER = "x-metagraph-event-id";
export const WEBHOOK_IDEMPOTENCY_HEADER = "x-metagraph-idempotency-key";
export const WEBHOOK_EVENT_TYPE = "metagraph.publish";

// Redelivery schedule: a parked delivery becomes due `min(base * 2^(round-1), max)`
// after its last attempt, and dead-letters after MAX_DELIVERY_ROUNDS failed rounds.
export const WEBHOOK_MAX_DELIVERY_ROUNDS = 8;
export const WEBHOOK_REDELIVERY_BASE_MS = 5 * 60 * 1000; // 5 min
export const WEBHOOK_REDELIVERY_MAX_MS = 12 * 60 * 60 * 1000; // 12 h
// Parked deliveries self-clean on the same 180-day horizon as dormant subscriptions.
export const WEBHOOK_DELIVERY_TTL_SECONDS = 180 * 24 * 60 * 60;
// Redelivery sweeps are intentionally budgeted so a long-lived failing endpoint
// cannot make publish runs retry an unbounded parked backlog.
export const WEBHOOK_REDELIVERY_LIST_LIMIT = 256;
export const WEBHOOK_REDELIVERY_MAX_PER_RUN = 64;
export const WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION = 8;

const MAX_FILTER_NETUIDS = 64;
const MAX_FILTER_KINDS = 8;
const VALID_CHANGE_KINDS = new Set(["subnets", "artifacts"]);

export function subscriptionStorageKey(id) {
  return `${WEBHOOK_KV_PREFIX}${id}`;
}

// All of a subscription's parked deliveries share this prefix, so its delivery
// health lists in one scan.
export function deliveryStoragePrefix(subscriptionId) {
  return `${WEBHOOK_DELIVERY_PREFIX}${subscriptionId}:`;
}

export function deliveryStorageKey(subscriptionId, eventId) {
  return `${deliveryStoragePrefix(subscriptionId)}${eventId}`;
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
  // 224.0.0.0/3 (multicast 224.0.0.0/4 + reserved/future 240.0.0.0/4, incl. the
  // 255.255.255.255 broadcast) — not valid public unicast targets. The health
  // prober already blocks these (isUnsafeIpv4: `a >= 224`); match it here.
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
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

function isPrivateIpv4Octets(octets) {
  const dotted = octets.join(".");
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(dotted));
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
      host.startsWith("fe") || // fe00::/8 reserved: link-local fe80::/10 + deprecated site-local fec0::/10
      host.startsWith("fc") || // unique-local fc00::/7
      host.startsWith("fd") ||
      host.startsWith("::ffff:") // IPv4-mapped
    ) {
      return false;
    }
    // IPv4-compatible (::a.b.c.d, normalised to ::7f00:1 by the URL parser),
    // 6to4 (2002::/16), and NAT64 (64:ff9b::/96) tunnel a v4 address past the
    // prefix checks above — re-check the embedded v4 against the private ranges.
    const embedded = ipv6EmbeddedIpv4(host);
    if (embedded && isPrivateIpv4Octets(embedded)) return false;
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
  // No filters object (or neither facet present) means "no restriction" — match
  // every event. A PRESENT facet is an allowlist, including an explicit empty
  // one: `{kinds: []}` allows zero kinds, so it must match NOTHING, not fall
  // through to match-all. normalizeFilters preserves an empty array, so a
  // subscriber can create such a filter and would otherwise be flooded with
  // every event instead of receiving none.
  if (
    !filters ||
    (filters.netuids === undefined && filters.kinds === undefined)
  ) {
    return true;
  }
  if (Array.isArray(filters.kinds)) {
    const eventKinds = new Set(event?.change_kinds || []);
    if (!filters.kinds.some((kind) => eventKinds.has(kind))) return false;
  }
  if (Array.isArray(filters.netuids)) {
    const affected = new Set(event?.affected_netuids || []);
    if (!filters.netuids.some((netuid) => affected.has(netuid))) return false;
  }
  return true;
}

// --- HMAC signing -------------------------------------------------------------
// Lowercase hex — shared by HMAC signing, secret generation, and the digests below.
function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return bytesToHex(digest);
}

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
  return bytesToHex(signature);
}

// Stable id for an event's content: same bytes ⇒ same id, for every subscriber
// and every (re)delivery of that event. Subscribers use it to correlate retries.
export async function webhookEventId(bodyText) {
  return (await sha256Hex(bodyText)).slice(0, 32);
}

// Idempotency key scoped to one subscriber and one event, derived from the
// subscription id and the exact event body. Every retry within a run and every
// redelivery on a later run carries the same key, so subscribers can dedupe.
export async function webhookIdempotencyKey(subscriptionId, bodyText) {
  return sha256Hex(`${subscriptionId}\n${bodyText}`);
}

export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  // Constant-time compare WITHOUT an early length-mismatch return (which would
  // leak the secret's length via timing). Fold the length difference into the
  // accumulator and iterate the longer string; out-of-range positions compare
  // against 0 (charCodeAt → NaN → 0). Equal length + equal content ⇒ diff 0.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

// --- identifiers --------------------------------------------------------------
export function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
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
// failures (network/timeout/5xx/429) but not deterministic 4xx rejections. The
// result carries `retryable` + the stable `event_id`/`idempotency_key`; pass
// `bodyText` to re-send a stored event verbatim (stable signature across runs).
export async function deliverChangeEvent({
  subscription,
  event,
  bodyText: providedBodyText,
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

  const bodyText =
    typeof providedBodyText === "string"
      ? providedBodyText
      : JSON.stringify(event);
  const timestamp =
    typeof now === "function" ? now() : new Date(0).toISOString();
  const [signature, eventId, idempotencyKey] = await Promise.all([
    signPayload(subscription.secret, bodyText),
    webhookEventId(bodyText),
    webhookIdempotencyKey(subscription.id, bodyText),
  ]);
  const headers = {
    "content-type": "application/json",
    "user-agent": "metagraphed-webhook/1.0",
    [WEBHOOK_SIGNATURE_HEADER]: signature,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_EVENT_ID_HEADER]: eventId,
    [WEBHOOK_IDEMPOTENCY_HEADER]: idempotencyKey,
  };
  const identity = { event_id: eventId, idempotency_key: idempotencyKey };

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
          ...identity,
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
          retryable: false,
          ...identity,
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
          retryable: false,
          ...identity,
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
    retryable: true,
    ...identity,
  };
}

// Bounded-concurrency map: drains `items` through at most `concurrency` in-flight
// `fn` calls. Shared by the fresh fan-out and the redelivery sweep.
async function mapBounded(items, concurrency, fn) {
  const queue = [...(items || [])];
  const results = [];
  const worker = async () => {
    while (queue.length > 0) {
      results.push(await fn(queue.shift()));
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// Bounded fan-out over many subscriptions. Concurrency-capped; never rejects —
// each subscription resolves to a result record (delivered/failed/filtered/
// skipped) so one bad endpoint can't sink the batch.
export async function dispatchChangeEvent({
  subscriptions,
  event,
  bodyText,
  fetchFn,
  now,
  timeoutMs,
  maxAttempts,
  resolveHostnames,
  concurrency = 8,
}) {
  return mapBounded(subscriptions, concurrency, (subscription) =>
    deliverChangeEvent({
      subscription,
      event,
      bodyText,
      fetchFn,
      now,
      timeoutMs,
      maxAttempts,
      resolveHostnames,
    }),
  );
}

// --- at-least-once delivery (persisted redelivery + dead-letter) --------------
// Fold one failed round into a parked record: bump the round, schedule the next
// attempt with bounded backoff, and dead-letter at the cap or on a hard failure.
function nextDeliveryRecord({
  existing,
  result,
  bodyText,
  nowIso,
  nowMs,
  maxRounds,
  baseMs,
  maxMs,
}) {
  const round = (existing?.round || 0) + 1;
  const dead = result.retryable === false || round >= maxRounds;
  const delayMs = Math.min(baseMs * 2 ** (round - 1), maxMs);
  return {
    subscription_id: result.id,
    event_id: result.event_id,
    idempotency_key: result.idempotency_key,
    body: bodyText,
    state: dead ? "dead" : "pending",
    round,
    reason: result.reason,
    status_code: result.status_code ?? null,
    first_failed_at: existing?.first_failed_at || nowIso,
    last_attempt_at: nowIso,
    next_attempt_at: dead ? null : new Date(nowMs + delayMs).toISOString(),
  };
}

// Roll a subscription's parked records into a compact health view for the public
// GET. Pure — the caller injects the records it listed from the store.
export function summarizeDeliveryRecords(records) {
  const list = (records || []).filter(
    (record) => record && typeof record === "object",
  );
  let pending = 0;
  let deadLetter = 0;
  let latest = null; // the failure with the most recent attempt (ISO sorts lexically)
  for (const record of list) {
    if (record.state === "dead") deadLetter += 1;
    else pending += 1;
    if (!latest || record.last_attempt_at > latest.last_attempt_at) {
      latest = record;
    }
  }
  return {
    status: deadLetter > 0 ? "dead_letter" : pending > 0 ? "retrying" : "ok",
    pending,
    dead_letter: deadLetter,
    last_failure: latest
      ? {
          event_id: latest.event_id,
          attempts: latest.round,
          reason: latest.reason,
          status_code: latest.status_code,
          state: latest.state,
          last_attempt_at: latest.last_attempt_at,
          next_attempt_at: latest.next_attempt_at,
        }
      : null,
  };
}

// At-least-once dispatch: deliver the current event, then redeliver the backlog of
// previously-failed deliveries now due, persisting state to an injected `store`
// ({ listKeys, get, put, delete }). Store calls are best-effort — a hiccup degrades
// to a redelivery next run (the idempotency key keeps that safe), never a throw.
export async function dispatchWithRedelivery({
  subscriptions,
  event,
  fetchFn,
  now,
  store,
  resolveHostnames,
  timeoutMs,
  maxAttempts,
  concurrency = 8,
  ttlSeconds = WEBHOOK_DELIVERY_TTL_SECONDS,
  maxRounds = WEBHOOK_MAX_DELIVERY_ROUNDS,
  redeliveryBaseMs = WEBHOOK_REDELIVERY_BASE_MS,
  redeliveryMaxMs = WEBHOOK_REDELIVERY_MAX_MS,
  redeliveryListLimit = WEBHOOK_REDELIVERY_LIST_LIMIT,
  maxRedeliveriesPerRun = WEBHOOK_REDELIVERY_MAX_PER_RUN,
  maxRedeliveriesPerSubscription = WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION,
}) {
  const nowIso = typeof now === "function" ? now() : new Date(0).toISOString();
  const nowMs = Date.parse(nowIso) || 0; // 0 on the epoch fallback or a bad clock
  const subList = (subscriptions || []).filter(Boolean);
  const subById = new Map(
    subList.filter((sub) => sub.id).map((sub) => [sub.id, sub]),
  );

  // Store wrappers: a control-store hiccup degrades to a retry next run, never throws.
  const safeListKeys = async (prefix, limit) => {
    try {
      const keys = await store.listKeys(prefix, { limit });
      return Number.isFinite(limit) && limit >= 0 ? keys.slice(0, limit) : keys;
    } catch {
      return [];
    }
  };
  const safeGet = async (key) => {
    try {
      return await store.get(key);
    } catch {
      return null;
    }
  };
  const safePut = async (key, value) => {
    try {
      await store.put(key, value, { ttlSeconds });
    } catch {
      /* deduped via the idempotency key on the next run's retry */
    }
  };
  const safeDelete = async (key) => {
    try {
      await store.delete(key);
    } catch {
      /* a stale record is harmless and TTL-reaped */
    }
  };
  const park = (key, existing, result, bodyText) =>
    safePut(
      key,
      nextDeliveryRecord({
        existing,
        result,
        bodyText,
        nowIso,
        nowMs,
        maxRounds,
        baseMs: redeliveryBaseMs,
        maxMs: redeliveryMaxMs,
      }),
    );

  // Snapshot the parked backlog once. Phase 1 consumes the keys it touches so it
  // only reads/writes KV when a record actually exists (no blind deletes on the
  // healthy path); Phase 2 then sweeps whatever remains.
  const parked = store
    ? new Set(await safeListKeys(WEBHOOK_DELIVERY_PREFIX, redeliveryListLimit))
    : new Set();

  // --- Phase 1: deliver the freshly-published event ---------------------------
  // One body for all subscribers (only the per-subscriber signature/key differ),
  // so what we send is exactly what we park.
  const freshBody = JSON.stringify(event);
  const delivered = await dispatchChangeEvent({
    subscriptions: subList,
    event,
    bodyText: freshBody,
    fetchFn,
    now,
    timeoutMs,
    maxAttempts,
    resolveHostnames,
    concurrency,
  });
  if (store) {
    for (const result of delivered) {
      if (!result?.event_id) continue; // skipped/filtered → nothing was attempted
      const key = deliveryStorageKey(result.id, result.event_id);
      const wasParked = parked.delete(key); // claim it so Phase 2 won't redo it
      if (result.status === "delivered") {
        if (wasParked) await safeDelete(key); // recovered → clear the prior park
      } else if (result.status === "failed" && result.retryable) {
        // Read the prior record straight from KV, not via `wasParked`: the parked
        // snapshot is capped at `redeliveryListLimit` and KV lists
        // lexicographically, so a still-parked key sorting past the cap is absent
        // from the snapshot. Trusting `wasParked` there would re-park it as a
        // brand-new record (round reset to 1, backoff + first_failed_at reset), so
        // a chronically-failing endpoint with a large backlog never reaches the
        // dead-letter cap. safeGet returns null on a genuine miss, so the healthy
        // "nothing parked yet" path still parks at round 1.
        await park(key, await safeGet(key), result, freshBody);
      }
    }
  }

  // --- Phase 2: redeliver whatever is still parked and now due ----------------
  // Records (re)parked in Phase 1 were removed from `parked`, so they can't be
  // re-attempted this run. Independent keys → concurrent sweep.
  const due = [];
  const dueBySubscription = new Map();
  for (const candidate of (
    await mapBounded([...parked], concurrency, async (key) => {
      const record = await safeGet(key);
      return record &&
        record.state === "pending" &&
        subById.has(record.subscription_id) && // gone/beyond cap → TTL reaps it
        !(record.next_attempt_at && Date.parse(record.next_attempt_at) > nowMs)
        ? { key, record }
        : null;
    })
  ).filter(Boolean)) {
    if (due.length >= maxRedeliveriesPerRun) break;
    const count = dueBySubscription.get(candidate.record.subscription_id) || 0;
    if (count >= maxRedeliveriesPerSubscription) continue;
    dueBySubscription.set(candidate.record.subscription_id, count + 1);
    due.push(candidate);
  }
  const redelivered = await mapBounded(
    due,
    concurrency,
    async ({ key, record }) => {
      const result = await deliverChangeEvent({
        subscription: subById.get(record.subscription_id),
        event: safeParseJson(record.body),
        bodyText: record.body,
        fetchFn,
        now,
        timeoutMs,
        maxAttempts,
        resolveHostnames,
      });
      if (result.status === "failed") {
        await park(key, record, result, record.body);
      } else {
        // delivered, or no longer applicable (filters/secret changed) → stop tracking
        await safeDelete(key);
      }
      return {
        id: record.subscription_id,
        event_id: record.event_id,
        status: result.status,
        round: record.round,
      };
    },
  );

  return { delivered, redelivered };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
