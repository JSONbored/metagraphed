// Pure, isomorphic helpers for the metagraph.sh change-feed webhooks.
//
// metagraph.sh regenerates its dataset on an event-driven publish (ADR 0007), so the
// "real-time" surface is honestly a CHANGE FEED: a notification pushed within
// seconds of each publish, not a sub-second tail. These helpers are shared by
// the Worker (subscription routes + SSE) and the publish-time dispatch script.
// They perform NO I/O — KV and fetch are injected by callers — so every branch
// is unit-testable. Runs unchanged on the Workers runtime and Node 22 (both
// expose Web Crypto + TextEncoder + URL).
import { ipv6EmbeddedIpv4 } from "./ip-safety.ts";

type Row = Record<string, unknown>;

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
const WEBHOOK_DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const WEBHOOK_DNS_RECORD_TYPES = ["A", "AAAA"];
const WEBHOOK_DNS_TIMEOUT_MS = 3000;

export function subscriptionStorageKey(id: unknown): string {
  return `${WEBHOOK_KV_PREFIX}${id}`;
}

// All of a subscription's parked deliveries share this prefix, so its delivery
// health lists in one scan.
export function deliveryStoragePrefix(subscriptionId: unknown): string {
  return `${WEBHOOK_DELIVERY_PREFIX}${subscriptionId}:`;
}

export function deliveryStorageKey(
  subscriptionId: unknown,
  eventId: unknown,
): string {
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
  /^(22[4-9]|2[3-5]\d)\./, // 224.0.0.0/3 — multicast 224/4 + reserved 240/4 (incl 255/8 broadcast); not unicast, matching the prober's a>=224 guard (#1538)
];

function normalizedHostname(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isIpv4Literal(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isPrivateIpv4Octets(octets: number[]): boolean {
  const dotted = octets.join(".");
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(dotted));
}

function isLiteralIp(host: string): boolean {
  return isIpv4Literal(host) || host.includes(":");
}

export function isPublicWebhookAddress(value: unknown): boolean {
  const host = normalizedHostname(value);
  if (!host) return false;

  if (host.includes(":")) {
    if (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fe") || // fe00::/8 reserved: link-local fe80::/10 + deprecated site-local fec0::/10
      host.startsWith("fc") || // unique-local fc00::/7
      host.startsWith("fd") ||
      host.startsWith("ff") || // ff00::/8 multicast — not global unicast (2000::/3), matching the prober guard (#1538)
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

export function isPublicWebhookUrl(value: unknown): boolean {
  let url: URL;
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

function dnsJsonAddressAnswers(body: unknown): string[] {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as Row).Answer)
  ) {
    return [];
  }
  return ((body as Row).Answer as unknown[])
    .map((answer) => String((answer as Row)?.data || "").trim())
    .filter(
      (data) =>
        isIpv4Literal(normalizedHostname(data)) ||
        normalizedHostname(data).includes(":"),
    );
}

async function resolveWebhookDnsJson(
  host: string,
  recordType: string,
  fetchImpl: typeof fetch,
  endpoint: string = WEBHOOK_DNS_JSON_ENDPOINT,
): Promise<string[]> {
  const query = new URL(endpoint);
  query.searchParams.set("name", host);
  query.searchParams.set("type", recordType);
  try {
    const response = await fetchImpl(query.toString(), {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_DNS_TIMEOUT_MS),
    });
    if (!response?.ok) return [];
    return dnsJsonAddressAnswers(await response.json());
  } catch {
    // A DoH timeout/network error/malformed-JSON parse failure for THIS
    // record type must not sink the other record type's lookup via
    // resolveWebhookHostnamesWithDoh's Promise.all below -- treat it as "no
    // addresses from this lookup" so a public answer from the other record
    // type can still be used, and so a fully-failed lookup fails closed
    // (empty addresses -> resolvedWebhookUrlStatus's `allPublic` check on an
    // empty array is false -> "unsafe") instead of throwing.
    return [];
  }
}

export async function resolveWebhookHostnamesWithDoh(
  host: string,
  {
    fetchImpl = fetch,
    dnsJsonEndpoint = WEBHOOK_DNS_JSON_ENDPOINT,
  }: { fetchImpl?: typeof fetch; dnsJsonEndpoint?: string } = {},
): Promise<string[]> {
  const lookups = await Promise.all(
    WEBHOOK_DNS_RECORD_TYPES.map((type) =>
      resolveWebhookDnsJson(host, type, fetchImpl, dnsJsonEndpoint),
    ),
  );
  return lookups.flat();
}

// Resolve + classify a webhook URL into one of three outcomes:
//   "ok"            — public URL that resolves to public address(es)
//   "unsafe"        — a non-public URL, or one that resolves to a private /
//                     link-local address: a TERMINAL reject (drop the delivery)
//   "resolve-error" — the DNS resolver threw (e.g. a transient EAI_AGAIN / SERVFAIL
//                     blip): a RETRYABLE condition, NOT a terminal reject
// Splitting the transient resolver failure out from a genuine "unsafe" verdict is
// what lets deliverChangeEvent park + retry it instead of silently dropping an
// owed at-least-once delivery when DNS momentarily fails during a sweep.
function isUnsafeWebhookDnsError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null | undefined;
  return (
    err?.code === "UNSAFE_WEBHOOK_DNS_RESULT" ||
    err?.message === "unsafe webhook DNS result"
  );
}

export async function resolvedWebhookUrlStatus(
  value: unknown,
  resolveHostnames: ((host: string) => Promise<string[]>) | undefined,
): Promise<"ok" | "unsafe" | "resolve-error"> {
  if (!isPublicWebhookUrl(value)) return "unsafe";
  if (typeof resolveHostnames !== "function") return "ok";

  // isPublicWebhookUrl already parsed the URL above, so new URL cannot throw here.
  const host = normalizedHostname(new URL(String(value)).hostname);
  // A literal IP already passed isPublicWebhookUrl's public-address check and has
  // nothing to resolve, so it is "ok" (its private-IP case was rejected upstream).
  if (isLiteralIp(host)) return "ok";

  let addresses: string[];
  try {
    addresses = await resolveHostnames(host);
  } catch (error) {
    return isUnsafeWebhookDnsError(error) ? "unsafe" : "resolve-error";
  }
  const allPublic =
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.every((address) => isPublicWebhookAddress(address));
  return allPublic ? "ok" : "unsafe";
}

interface Filters {
  netuids?: number[];
  kinds?: string[];
}

// --- subscription validation --------------------------------------------------
export function normalizeFilters(filters: unknown): Filters | null {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== "object" || Array.isArray(filters)) return null;
  const input = filters as Row;
  const out: Filters = {};

  if (input.netuids !== undefined) {
    if (!Array.isArray(input.netuids)) return null;
    if (input.netuids.length > MAX_FILTER_NETUIDS) return null;
    const clean: number[] = [];
    for (const netuid of input.netuids) {
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        return null;
      if (!clean.includes(netuid)) clean.push(netuid);
    }
    out.netuids = clean.sort((a, b) => a - b);
  }

  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds)) return null;
    if (input.kinds.length > MAX_FILTER_KINDS) return null;
    const clean: string[] = [];
    for (const kind of input.kinds) {
      if (typeof kind !== "string" || !VALID_CHANGE_KINDS.has(kind))
        return null;
      if (!clean.includes(kind)) clean.push(kind);
    }
    out.kinds = clean.sort();
  }

  return out;
}

export function validateSubscriptionInput(
  input: unknown,
):
  | {
      ok: true;
      value: { url: string; filters: Filters; secret: string | null };
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const body = input as Row;
  if (typeof body.url !== "string" || !isPublicWebhookUrl(body.url)) {
    return {
      ok: false,
      error:
        "`url` must be a public https:// URL (no credentials, no private/loopback hosts, default port).",
    };
  }
  const filters = normalizeFilters(body.filters);
  if (filters === null) {
    return {
      ok: false,
      error:
        '`filters` must be an object {netuids?: integer[], kinds?: ("subnets"|"artifacts")[]}.',
    };
  }
  let secret: string | null = null;
  if (body.secret !== undefined) {
    if (
      typeof body.secret !== "string" ||
      body.secret.length < 16 ||
      body.secret.length > 256
    ) {
      return {
        ok: false,
        error: "`secret`, when provided, must be a 16-256 character string.",
      };
    }
    secret = body.secret;
  }
  return { ok: true, value: { url: body.url, filters, secret } };
}

// --- change-event construction ------------------------------------------------
// Map a per-subnet artifact path back to its netuid for netuid-scoped filters.
const NETUID_ARTIFACT_PATTERN =
  /(?:^|\/)(?:subnets|surfaces|profiles|endpoints|candidates|evidence|health\/subnets|health\/badges|verification\/subnets|review\/gaps)\/(\d+)\.json$/;

function netuidFromArtifactPath(artifactPath: unknown): number | null {
  const match = String(artifactPath || "").match(NETUID_ARTIFACT_PATTERN);
  return match ? Number(match[1]) : null;
}

function artifactPaths(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : (entry as Row)?.path))
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

// Build the public change-feed payload from changelog.json + the KV `latest`
// pointer. Deterministic and side-effect-free.
export function buildChangeEvent({
  changelog,
  pointer,
}: { changelog?: Row; pointer?: Row } = {}): Row {
  const cl = changelog && typeof changelog === "object" ? changelog : {};
  const artifacts =
    cl.artifacts && typeof cl.artifacts === "object"
      ? (cl.artifacts as Row)
      : {};
  const subnets =
    cl.subnets && typeof cl.subnets === "object" ? (cl.subnets as Row) : {};

  const added = artifactPaths(artifacts.added);
  const modified = artifactPaths(artifacts.modified);
  const removed = artifactPaths(artifacts.removed);
  const subnetsAdded = Array.isArray(subnets.added) ? subnets.added : [];
  const subnetsRemoved = Array.isArray(subnets.removed) ? subnets.removed : [];
  const subnetsRenamed = Array.isArray(subnets.renamed) ? subnets.renamed : [];

  const netuids = new Set<number>();
  for (const entry of [...subnetsAdded, ...subnetsRemoved, ...subnetsRenamed]) {
    const netuid =
      typeof entry === "number"
        ? entry
        : entry && typeof (entry as Row).netuid === "number"
          ? ((entry as Row).netuid as number)
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

export function eventMatchesFilters(
  event: Row | null | undefined,
  filters: Filters | null | undefined,
): boolean {
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
    const eventKinds = new Set((event?.change_kinds as unknown[]) || []);
    if (!filters.kinds.some((kind) => eventKinds.has(kind))) return false;
  }
  if (Array.isArray(filters.netuids)) {
    const affected = new Set((event?.affected_netuids as unknown[]) || []);
    if (!filters.netuids.some((netuid) => affected.has(netuid))) return false;
  }
  return true;
}

// --- HMAC signing -------------------------------------------------------------
// Lowercase hex — shared by HMAC signing, secret generation, and the digests below.
function bytesToHex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return bytesToHex(digest);
}

export async function signPayload(
  secret: unknown,
  bodyText: unknown,
): Promise<string> {
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
export async function webhookEventId(bodyText: unknown): Promise<string> {
  return (await sha256Hex(bodyText)).slice(0, 32);
}

// Idempotency key scoped to one subscriber and one event, derived from the
// subscription id and the exact event body. Every retry within a run and every
// redelivery on a later run carries the same key, so subscribers can dedupe.
export async function webhookIdempotencyKey(
  subscriptionId: unknown,
  bodyText: unknown,
): Promise<string> {
  return sha256Hex(`${subscriptionId}\n${bodyText}`);
}

export function timingSafeEqual(a: unknown, b: unknown): boolean {
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
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function generateSubscriptionId(): string {
  return crypto.randomUUID();
}

// A subscription id is a UUID v4; validate before using it as a KV key.
export function isValidSubscriptionId(id: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(id),
  );
}

// Strip the secret before returning a subscription to a client.
export function publicSubscriptionView(
  record: Row | null | undefined,
): Row | null {
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
  sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  resolveHostnames,
}: {
  subscription: Row | null | undefined;
  event: Row;
  bodyText?: string;
  fetchFn: typeof fetch;
  now?: () => string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  resolveHostnames?: (host: string) => Promise<string[]>;
}): Promise<Row> {
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
  if (!eventMatchesFilters(event, subscription.filters as Filters | null)) {
    return { id: subscription.id, status: "filtered" };
  }
  if (typeof subscription.secret !== "string" || !subscription.secret) {
    return { id: subscription.id, status: "skipped", reason: "no-secret" };
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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "metagraphed-webhook/1.0",
    [WEBHOOK_SIGNATURE_HEADER]: signature,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_EVENT_ID_HEADER]: eventId,
    [WEBHOOK_IDEMPOTENCY_HEADER]: idempotencyKey,
  };
  const identity = { event_id: eventId, idempotency_key: idempotencyKey };

  // Resolve + classify the URL AFTER identity is computed, so a transient resolver
  // failure can be parked (it needs an event_id) and retried instead of dropped.
  // A statically-unsafe URL, or one that resolves to a private address, is a
  // terminal "skipped"; a resolver THROW (a DNS blip) is a retryable "failed" —
  // returning "skipped" there would delete the parked record on the redelivery
  // sweep and silently lose an owed at-least-once delivery to a healthy endpoint.
  const urlStatus = await resolvedWebhookUrlStatus(
    subscription.url,
    resolveHostnames,
  );
  if (urlStatus === "resolve-error") {
    return {
      id: subscription.id,
      status: "failed",
      reason: "resolve-error",
      retryable: true,
      ...identity,
    };
  }
  if (urlStatus !== "ok") {
    return { id: subscription.id, status: "skipped", reason: "unsafe-url" };
  }

  let lastReason = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | null;
    try {
      response = await fetchFn(subscription.url as string, {
        method: "POST",
        headers,
        body: bodyText,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const err = error as { name?: string } | null | undefined;
      lastReason = err?.name === "TimeoutError" ? "timeout" : "network-error";
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
// `fn` calls. Shared by the fresh fan-out and the redelivery sweep -- exported
// (#4984 Part 3 adversarial-review fix) so workers/alerter-hub.ts's own
// delivery fan-out can reuse it rather than duplicating this logic.
export async function mapBounded<T, R>(
  items: T[] | null | undefined,
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const list = [...(items || [])];
  // Place each result at its INPUT index, not in completion order — workers
  // resolve concurrently (and the per-item work does real async I/O: crypto
  // signing + fetch), so a push-on-complete would return results in a
  // nondeterministic order. Order-preserving output is what every caller relies
  // on (the redelivery sweep's per-subscription budget + redelivered sequence).
  const results: R[] = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(list[index]);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, list.length)) },
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
}: {
  subscriptions: Row[] | null | undefined;
  event: Row;
  bodyText?: string;
  fetchFn: typeof fetch;
  now?: () => string;
  timeoutMs?: number;
  maxAttempts?: number;
  resolveHostnames?: (host: string) => Promise<string[]>;
  concurrency?: number;
}): Promise<Row[]> {
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
}: {
  existing: Row | null | undefined;
  result: Row;
  bodyText: string;
  nowIso: string;
  nowMs: number;
  maxRounds: number;
  baseMs: number;
  maxMs: number;
}): Row {
  const round = ((existing?.round as number) || 0) + 1;
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
export function summarizeDeliveryRecords(
  records: Row[] | null | undefined,
): Row {
  const list = (records || []).filter(
    (record) => record && typeof record === "object",
  );
  let pending = 0;
  let deadLetter = 0;
  let latest: Row | null = null; // the failure with the most recent attempt (ISO sorts lexically)
  for (const record of list) {
    if (record.state === "dead") deadLetter += 1;
    else pending += 1;
    if (
      !latest ||
      (record.last_attempt_at as string) > (latest.last_attempt_at as string)
    ) {
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

interface DeliveryStore {
  listKeys: (prefix: string, options: { limit?: number }) => Promise<string[]>;
  get: (key: string) => Promise<Row | null>;
  put: (
    key: string,
    value: Row,
    options: { ttlSeconds: number },
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
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
}: {
  subscriptions: Row[] | null | undefined;
  event: Row;
  fetchFn: typeof fetch;
  now?: () => string;
  store: DeliveryStore | null | undefined;
  resolveHostnames?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  ttlSeconds?: number;
  maxRounds?: number;
  redeliveryBaseMs?: number;
  redeliveryMaxMs?: number;
  redeliveryListLimit?: number;
  maxRedeliveriesPerRun?: number;
  maxRedeliveriesPerSubscription?: number;
}): Promise<{ delivered: Row[]; redelivered: Row[] }> {
  const nowIso = typeof now === "function" ? now() : new Date(0).toISOString();
  const nowMs = Date.parse(nowIso) || 0; // 0 on the epoch fallback or a bad clock
  const subList = (subscriptions || []).filter(Boolean);
  const subById = new Map(
    subList
      .filter((sub) => sub.id)
      .map((sub) => [sub.id as string, sub] as [string, Row]),
  );

  // Store wrappers: a control-store hiccup degrades to a retry next run, never throws.
  const safeListKeys = async (
    prefix: string,
    limit: number,
  ): Promise<string[]> => {
    try {
      const keys = await store!.listKeys(prefix, { limit });
      return Number.isFinite(limit) && limit >= 0 ? keys.slice(0, limit) : keys;
    } catch {
      return [];
    }
  };
  const safeGet = async (key: string): Promise<Row | null> => {
    try {
      return await store!.get(key);
    } catch {
      return null;
    }
  };
  const safePut = async (key: string, value: Row): Promise<void> => {
    try {
      await store!.put(key, value, { ttlSeconds });
    } catch {
      /* deduped via the idempotency key on the next run's retry */
    }
  };
  const safeDelete = async (key: string): Promise<void> => {
    try {
      await store!.delete(key);
    } catch {
      /* a stale record is harmless and TTL-reaped */
    }
  };
  const park = (
    key: string,
    existing: Row | null | undefined,
    result: Row,
    bodyText: string,
  ) =>
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
    : new Set<string>();

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
  const due: { key: string; record: Row }[] = [];
  const dueBySubscription = new Map<string, number>();
  // Sweep the parked backlog in a STABLE lexicographic key order — the order KV
  // itself lists in — so the shared per-run / per-subscription budget always
  // selects the same records for the same inputs, independent of the injected
  // store's iteration order or the concurrent get-completion order.
  for (const candidate of (
    await mapBounded(
      [...parked].sort(),
      concurrency,
      async (key): Promise<{ key: string; record: Row } | null> => {
        const record = await safeGet(key);
        return record &&
          record.state === "pending" &&
          subById.has(record.subscription_id as string) && // gone/beyond cap → TTL reaps it
          !(
            record.next_attempt_at &&
            Date.parse(record.next_attempt_at as string) > nowMs
          )
          ? { key, record }
          : null;
      },
    )
  ).filter((entry): entry is { key: string; record: Row } => entry != null)) {
    if (due.length >= maxRedeliveriesPerRun) break;
    const subscriptionId = candidate.record.subscription_id as string;
    const count = dueBySubscription.get(subscriptionId) || 0;
    if (count >= maxRedeliveriesPerSubscription) continue;
    dueBySubscription.set(subscriptionId, count + 1);
    due.push(candidate);
  }
  const redelivered = await mapBounded(
    due,
    concurrency,
    async ({ key, record }) => {
      const result = await deliverChangeEvent({
        subscription: subById.get(record.subscription_id as string),
        event: safeParseJson(record.body as string) as Row,
        bodyText: record.body as string,
        fetchFn,
        now,
        timeoutMs,
        maxAttempts,
        resolveHostnames,
      });
      if (result.status === "failed") {
        await park(key, record, result, record.body as string);
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

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
