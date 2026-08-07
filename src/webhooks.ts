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
// Per-(subscription, event) delivery OUTCOME, for the public status surface.
// It used to be delivery STATE -- a failed delivery was parked here and a later
// run swept it -- but the queue schedules retries now (metagraphed-infra#354),
// so nothing reads these to decide what to do. They are reporting only.
export const WEBHOOK_DELIVERY_PREFIX = "webhooks:delivery:";
export const WEBHOOK_SIGNATURE_HEADER = "x-metagraph-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-metagraph-timestamp";
export const WEBHOOK_SECRET_HEADER = "x-metagraph-webhook-secret";
// Stable per-content event id + per-(subscription, event) idempotency key so a
// subscriber can dedupe the retries at-least-once delivery implies.
export const WEBHOOK_EVENT_ID_HEADER = "x-metagraph-event-id";
export const WEBHOOK_IDEMPOTENCY_HEADER = "x-metagraph-idempotency-key";
export const WEBHOOK_EVENT_TYPE = "metagraph.publish";

// THE PUBLISHED REDELIVERY CONTRACT. These are what subscribers were told, and
// they outlive the mechanism that first implemented them: src/webhook-queue.ts
// derives the queue's `max_retries` and `delaySeconds` curve from exactly these
// numbers, so the transport can change without the promise changing.
export const WEBHOOK_MAX_DELIVERY_ROUNDS = 8;
export const WEBHOOK_REDELIVERY_BASE_MS = 5 * 60 * 1000; // 5 min
export const WEBHOOK_REDELIVERY_MAX_MS = 12 * 60 * 60 * 1000; // 12 h
// Parked deliveries self-clean on the same 180-day horizon as dormant subscriptions.
export const WEBHOOK_DELIVERY_TTL_SECONDS = 180 * 24 * 60 * 60;
// How many delivery records the subscription-status surface reads back. The
// per-run and per-subscription redelivery budgets that used to sit here are
// GONE (metagraphed-infra#354): they rationed a shared per-run sweep, and a
// queue has no such resource -- see src/webhook-queue.ts for the full argument.
export const WEBHOOK_REDELIVERY_LIST_LIMIT = 256;

const MAX_FILTER_NETUIDS = 64;
const MAX_FILTER_KINDS = 8;
const VALID_CHANGE_KINDS = new Set(["subnets", "artifacts"]);
const WEBHOOK_DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const WEBHOOK_DNS_RECORD_TYPES = ["A", "AAAA"];
const WEBHOOK_DNS_TIMEOUT_MS = 3000;

export function subscriptionStorageKey(id: unknown): string {
  return `${WEBHOOK_KV_PREFIX}${id}`;
}

// All of a subscription's delivery records share this prefix, so its delivery
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
// what lets a DNS blip come back as `retryable: true` -- so the queue reschedules
// it -- instead of a terminal "skipped" that dead-letters an owed delivery to a
// healthy endpoint.
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

export function validateSubscriptionInput(input: unknown):
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
// subscription id and the exact event body. Every attempt carries the same key --
// the inner HTTP retries and all eight queue attempts alike -- so subscribers can
// dedupe.
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

  // Resolve + classify the URL AFTER identity is computed, so the result carries
  // an event_id whichever way it goes. A statically-unsafe URL, or one that
  // resolves to a private address, is a terminal "skipped"; a resolver THROW (a
  // DNS blip) is a retryable "failed" — returning "skipped" there would
  // dead-letter an owed at-least-once delivery to a healthy endpoint on the
  // strength of one bad lookup.
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
// `fn` calls. Its two webhook callers -- the fresh fan-out and the redelivery
// sweep -- are both gone (metagraphed-infra#354), and it survives for
// workers/alerter-hub.ts, which was given it in #4984 rather than duplicating it.
// It lives here rather than moving because that is a file move for one caller,
// and the next fan-out that needs a bound will look here first.
export async function mapBounded<T, R>(
  items: T[] | null | undefined,
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const list = [...(items || [])];
  // Place each result at its INPUT index, not in completion order — workers
  // resolve concurrently (and the per-item work does real async I/O: crypto
  // signing + fetch), so a push-on-complete would return results in a
  // nondeterministic order. The alerter's fan-out zips these back against its
  // input list, so the order is load-bearing there.
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

// The scheduler that used to live here -- `nextDeliveryRecord`, folding a
// failed round into a parked record with its own backoff and dead-letter cap --
// is GONE (metagraphed-infra#354). The queue schedules retries now, and the
// round counter it maintained by hand is carried by the platform's `attempts`.
//
// What survives is the READ below: a subscriber debugging a missed event still
// needs to see delivery outcomes, so the consumer writes a record and this
// summarises it. Reporting, not control.

/**
 * One delivery outcome, in the shape the summary below reads.
 *
 * THE WRITER AND THE READER LIVE TOGETHER NOW, and that is the point. #354's
 * consumer wrote `{status, attempts, last_status, updated_at}` while this file
 * kept reading `{state, round, reason, status_code, last_attempt_at}` — the old
 * parked-record vocabulary. Not one field overlapped, so `dead_letter` was
 * permanently 0, every record counted as pending (a fully delivered
 * subscription reported `retrying`), and every `last_failure` field came back
 * undefined. The tests missed it because they hand-seeded records instead of
 * writing what the consumer writes.
 *
 * `state` is the DISPOSITION, not the HTTP outcome: `delivered` is terminal
 * success, `pending` is scheduled for another attempt, `dead` is terminal
 * failure. The summary counts on exactly those three.
 */
export function deliveryRecordFor({
  subscriptionId,
  eventId,
  result,
  disposition,
  attempts,
  nowIso,
  nextAttemptAt = null,
}: {
  subscriptionId: string;
  eventId: string;
  result: Row | null | undefined;
  disposition: "delivered" | "retry" | "dead";
  attempts: number;
  nowIso: string;
  /** When the queue will try again, for a retried delivery. Null otherwise --
   * a terminal record has no next attempt, and inventing one would read as a
   * delivery still to come. */
  nextAttemptAt?: string | null;
}): Row {
  return {
    subscription_id: subscriptionId,
    event_id: eventId,
    state: disposition === "retry" ? "pending" : disposition,
    // The queue's attempt counter, which is what replaced the hand-kept round.
    round: attempts,
    // Absent on a success, and deliberately not defaulted to "ok": `reason` is
    // read as a failure cause, and a delivered record having one would be a lie
    // that reads like a diagnosis.
    reason: (result?.reason as string) ?? null,
    status_code: (result?.status_code as number) ?? null,
    last_attempt_at: nowIso,
    next_attempt_at: disposition === "retry" ? nextAttemptAt : null,
  };
}

// Roll a subscription's delivery records into a compact health view for the
// public GET. Pure — the caller injects the records it listed from the store.
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
    // A DELIVERED RECORD IS NEITHER. It used to fall into `pending` through the
    // else, so a subscription whose every event landed reported `retrying` with
    // a pending count equal to its recent history.
    else if (record.state !== "delivered") pending += 1;
    // `last_failure`, so a success does not become the reported failure just by
    // being the most recent thing that happened.
    if (
      record.state !== "delivered" &&
      (!latest ||
        (record.last_attempt_at as string) > (latest.last_attempt_at as string))
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
