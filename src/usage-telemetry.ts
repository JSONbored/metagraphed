// Typed PostHog usage-event wrapper for the Worker backend (#6030 / #366).
//
// Single chokepoint for product-usage capture: callers pass an allowlisted
// UsageEvent; this module owns the PostHog event name/properties and posts
// them straight to PostHog's public capture API with fetch.
// Nothing outside this file should construct a raw PostHog event.
//
// This module deliberately does NOT import `posthog-node`. That SDK is built
// for long-lived Node servers (batching, flush intervals, shutdown draining) —
// none of which survives a Workers isolate anyway — and it costs ~40 KiB
// gzipped in the bundle. The Worker entry is already within a few KiB of
// Cloudflare's 1 MiB script limit (scripts/worker-bundle-budget.ts), so
// importing it here pushes the deployable bundle past the limit outright.
// One fetch to the documented capture endpoint does the same job at zero
// bundle cost, and fetch is the platform-native transport here.
//
// Safe no-op when POSTHOG_PROJECT_TOKEN is unset — self-hosters / local / CI
// see zero behavior change. Never throws.

/** Env var holding the PostHog project API token (wrangler secret). */
export const POSTHOG_PROJECT_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN";

/** Optional PostHog host override (defaults to PostHog US cloud). */
export const POSTHOG_HOST_ENV = "POSTHOG_HOST";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Stable distinct_id for anonymous Worker-side product events. */
export const USAGE_EVENT_DISTINCT_ID = "metagraphed-worker";

/** PostHog event name owned by this wrapper — do not emit it elsewhere. */
export const USAGE_EVENT_NAME = "usage_event";

// Cap free-form string fields so a buggy caller can't ship unbounded payloads.
const MAX_LABEL_CHARS = 256;

/** REST/GraphQL route path (no query string / bodies) or MCP tool name (no
 * arguments / response content); ok/durationMs describe the outcome. */
export interface UsageEvent {
  route?: string;
  mcpTool?: string;
  ok: boolean;
  durationMs: number;
  // #8963: the dimensions that make 6M events/month queryable. Before these,
  // usage_event carried route + ok + duration_ms and nothing else -- most of a
  // free tier spent on three columns, with no way to ask "which method", "was
  // that a client error or ours", or "who is generating this".
  /** HTTP method, uppercased. Absent for non-HTTP emitters (cron jobs, MCP). */
  method?: string;
  /** Response status class: "2xx" | "3xx" | "4xx" | "5xx". Distinguishes a
   * route correctly rejecting a bad request from a route that broke -- `ok`
   * alone folds every 4xx in with the 2xxs. */
  statusClass?: string;
  /** Coarse caller bucket from the User-Agent (name only, no version), so
   * traffic is attributable without the high-cardinality raw header. */
  client?: string;
  // metagraphed#7726: one of the fixed literal codes a `toolError`-style
  // helper produces (e.g. "invalid_params", "auth_required",
  // "credential_not_supported", "upstream_unavailable", "internal_error") --
  // NEVER a caller-derived value or free-form error message. Only meaningful
  // when `ok` is false; omitted (not just falsy) for a successful call.
  errorCode?: string;
}

/** Public capture endpoint, appended to the resolved PostHog host. */
export const POSTHOG_CAPTURE_PATH = "/i/v0/e/";

export interface RecordUsageEventDeps {
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  /** Override distinct_id (tests). */
  distinctId?: string;
}

// #8963: best-effort client identity from the User-Agent, for the tool calls
// that carry no session to link back to an initialize handshake. MCP HTTP
// clients send a conventional `name/version` first token (claude-code/2.1.220,
// mcporter/0.12.3, python-httpx/0.27.0), so the first token before any space
// is split on its last "/". Anything that doesn't fit that shape yields a name
// with no version rather than a guess. Capped well under the telemetry
// module's own label cap so a hostile UA can't dominate a payload.
const MAX_USER_AGENT_CLIENT_CHARS = 80;

export function parseUserAgentClient(userAgent: unknown): {
  clientName?: string;
  clientVersion?: string;
} {
  if (typeof userAgent !== "string") return {};
  const token = userAgent.trim().split(/\s+/)[0] ?? "";
  if (!token) return {};
  const slash = token.lastIndexOf("/");
  // A leading "/" (or a bare "/") leaves no name -- treat the whole token as
  // the name rather than emitting an empty one.
  const name = slash > 0 ? token.slice(0, slash) : token;
  const version = slash > 0 ? token.slice(slash + 1) : "";
  if (!name) return {};
  return {
    clientName: name.slice(0, MAX_USER_AGENT_CLIENT_CHARS),
    ...(version
      ? { clientVersion: version.slice(0, MAX_USER_AGENT_CLIENT_CHARS) }
      : {}),
  };
}

/** True when this deployment has a non-empty PostHog project token configured. */
export function isUsageTelemetryConfigured(
  env: Env | null | undefined,
): boolean {
  const token = env?.[POSTHOG_PROJECT_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * Build the allowlisted PostHog properties object, or null when the event is
 * too malformed to record (missing ok / non-finite duration).
 */
export function usageEventProperties(
  event: UsageEvent | null | undefined,
): Record<string, string | number | boolean> | null {
  if (!event || typeof event !== "object") return null;
  if (typeof event.ok !== "boolean") return null;
  if (
    typeof event.durationMs !== "number" ||
    !Number.isFinite(event.durationMs) ||
    event.durationMs < 0
  ) {
    return null;
  }

  const properties: Record<string, string | number | boolean> = {
    ok: event.ok,
    // Coarse integer ms — drop sub-ms noise; clamp absurd values at 24h.
    duration_ms: Math.min(Math.round(event.durationMs), 86_400_000),
  };

  const route = sanitizeLabel(event.route);
  if (route !== undefined) properties.route = route;

  const mcpTool = sanitizeLabel(event.mcpTool);
  if (mcpTool !== undefined) properties.mcp_tool = mcpTool;

  // metagraphed#7726: categorizes WHY a failed call failed, so analytics can
  // break failures down by cause instead of only a success/fail ratio. Only
  // ever one of a small set of literal codes this codebase itself defines
  // (see UsageEvent.errorCode) -- sanitizeLabel is reused here purely for
  // defense-in-depth (the same cap every other free-ish-form field gets),
  // not because this field is expected to need it.
  const errorCode = sanitizeLabel(event.errorCode);
  if (errorCode !== undefined) properties.error_code = errorCode;

  // #8963 dimensions. Each is omitted (not defaulted) when absent, matching
  // the contract every other optional field here already follows.
  const method = sanitizeLabel(event.method);
  if (method !== undefined) properties.method = method.toUpperCase();

  const statusClass = sanitizeLabel(event.statusClass);
  if (statusClass !== undefined) properties.status_class = statusClass;

  const client = sanitizeLabel(event.client);
  if (client !== undefined) properties.client = client;

  return properties;
}

/**
 * Map an HTTP status to its class label (#8963). Anything outside 100-599 is
 * not a status we produced, so it yields undefined rather than a bucket that
 * would quietly absorb garbage.
 */
export function statusClassOf(status: unknown): string | undefined {
  if (typeof status !== "number" || !Number.isFinite(status)) return undefined;
  if (status < 100 || status > 599) return undefined;
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Record one product-usage event. Resolves without throwing; returns whether
 * an event was handed to PostHog. Callers that need Workers flush semantics
 * should schedule the returned promise via `ctx.waitUntil(...)`.
 */
export async function recordUsageEvent(
  env: Env | null | undefined,
  event: UsageEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties = usageEventProperties(event);
    if (!properties) return false;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: USAGE_EVENT_NAME,
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    // A rejected capture is PostHog's problem, not the request's — report it
    // as not-recorded rather than throwing.
    return response?.ok === true;
  } catch {
    // Telemetry must never surface into the request/tool path.
    return false;
  }
}

export function resolvePostHogHost(env: Env | null | undefined): string {
  return typeof env?.[POSTHOG_HOST_ENV] === "string" &&
    env[POSTHOG_HOST_ENV].trim()
    ? env[POSTHOG_HOST_ENV].trim()
    : DEFAULT_POSTHOG_HOST;
}

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS
    ? trimmed.slice(0, MAX_LABEL_CHARS)
    : trimmed;
}

// ─── $mcp_error_type projection (#8963) ────────────────────────────────────
//
// PostHog's MCP Analytics dashboards group failures by $mcp_error_type, whose
// vocabulary is a small fixed set. This codebase already carries a richer,
// developer-defined error code on every failed tool result
// (structuredContent.error.code — see toolError in src/mcp-server.ts), so the
// projection below is the only missing piece: it maps OUR code onto THEIR
// bucket. Nothing here invents classification the tool path didn't already
// have.
//
// Two layers, deliberately:
//
//   1. EXPLICIT — every code the MCP tool path is known to raise, mapped by
//      hand. This is the authoritative layer; when a code's bucket is not
//      obvious from its name, it belongs here.
//   2. CONVENTION — suffix/prefix rules over this codebase's own naming
//      habits (`*_unavailable`, `*_rate_limited`, `invalid_*`). The code
//      vocabulary is open-ended by design: helpers outside mcp-server.ts
//      (health-history-mcp.ts, stake-quote.ts, the per-domain sync modules)
//      each mint their own codes and propagate them through toolError, and
//      new ones land without touching this file. A hand-maintained list
//      alone would silently degrade every new code to `internal`; the rules
//      keep the long tail classified.
//
// Anything neither layer recognizes falls back to `internal`, which is
// PostHog's own documented catch-all bucket.

/** PostHog's fixed $mcp_error_type vocabulary. */
export type McpErrorType =
  | "validation"
  | "permission"
  | "api_4xx"
  | "missing_context"
  | "rate_limited"
  | "api_5xx"
  | "timeout"
  | "internal";

/**
 * Layer 1: codes whose bucket is not derivable from the name, or where the
 * naming convention would derive the WRONG bucket. Keep alphabetical.
 */
export const MCP_ERROR_TYPE_BY_CODE: Record<string, McpErrorType> = {
  // A caller offering a credential the target surface has no slot for is a
  // malformed request, not an authorization failure — the call would fail
  // identically with a perfectly valid credential.
  credential_not_supported: "validation",
  forbidden: "permission",
  auth_required: "permission",
  internal_error: "internal",
  // "This surface exists but declares no callable path/schema" — the caller
  // is missing context about the target, not sending bad syntax.
  no_schema: "missing_context",
  not_callable: "missing_context",
  not_found: "missing_context",
  path_not_declared: "missing_context",
  // Blocked by our own method policy, not by the upstream.
  rpc_method_blocked: "permission",
  // The caller asked for more than the pool can fill — an input problem, not a
  // fault. Reachable from get_subnet_stake_quote / get_stake_action_preview via
  // computeStakeQuote's own code.
  insufficient_liquidity: "validation",
  // An adapter's upstream provider failed or answered with garbage. Both are
  // somebody else's 5xx from the caller's side.
  provider_error: "api_5xx",
  provider_invalid_response: "api_5xx",
  // The artifact existed and was withdrawn — the caller is missing context
  // about what is current, not sending bad syntax.
  retired_artifact: "missing_context",
  // The upstream answered, but with something unparseable — their fault.
  rpc_invalid_response: "api_5xx",
  // ...whereas an invalid *request* is the caller's.
  rpc_invalid_request: "validation",
  rpc_upstream_error: "api_5xx",
  // A tools/call naming a tool this server does not register. Classified as
  // validation rather than missing_context: `name` is an argument of the
  // tools/call request, and the caller can fix it from tools/list alone.
  unknown_tool: "validation",
  unsupported_content_type: "validation",
};

/**
 * Layer 2: naming-convention rules, in precedence order. First match wins.
 */
const MCP_ERROR_TYPE_RULES: [RegExp, McpErrorType][] = [
  // Checked before `*_unavailable`, since `rpc_state_query_rate_limited` and
  // friends would otherwise fall through to the 5xx rule below.
  //
  // The `^rate_limited$` alternative is load-bearing and was MISSING. The bare
  // code -- what `requireAiRateLimit` and every plain limiter raises, and by
  // far the most common member of the family -- has no underscore prefix, so
  // `_rate_limited$` alone did not match it and it fell through to `internal`.
  // The unit tests did not catch it because the production sample they were
  // built from contained `data_rate_limited` and `graphql_rate_limited` but no
  // bare `rate_limited`: MCP AI rate limiting had not tripped during the
  // measurement window. Found by tripping the live limiter and reading the
  // emitted event.
  [/^rate_limited$|_rate_limited$/, "rate_limited"],
  [/^timeout$|_timeout$/, "timeout"],
  [/^invalid_|^malformed_|_invalid$/, "validation"],
  // Our own dependency (a tier, a binding, an upstream provider) could not
  // serve the call. From the caller's side this is indistinguishable from a
  // 5xx, which is the bucket PostHog intends for it.
  [/_unavailable$|_unreachable$|^unavailable$/, "api_5xx"],
  [/_not_configured$|_missing$|_not_found$/, "missing_context"],
  // Refused by our own policy rather than by a dependency (api_key_blocked;
  // rpc_method_blocked is already named explicitly above).
  [/_blocked$/, "permission"],
];

/**
 * Project one internal tool-error code onto PostHog's $mcp_error_type bucket.
 * Never returns undefined — an unrecognized code is `internal`, so a failure
 * is never silently unclassified in the dashboards.
 */
export function classifyMcpErrorType(code: unknown): McpErrorType {
  if (typeof code !== "string") return "internal";
  const normalized = code.trim().toLowerCase();
  if (!normalized) return "internal";
  const explicit = MCP_ERROR_TYPE_BY_CODE[normalized];
  if (explicit) return explicit;
  for (const [pattern, type] of MCP_ERROR_TYPE_RULES) {
    if (pattern.test(normalized)) return type;
  }
  return "internal";
}

/**
 * Stamp client + server attribution onto an outgoing $mcp_* property bag
 * (#8963). Shared by every event in the family so a breakdown by client or by
 * deploy version behaves identically whichever event it starts from.
 */
function assignMcpAttribution(
  properties: Record<string, unknown>,
  event: {
    clientName?: string;
    clientVersion?: string;
    clientNameSource?: McpClientNameSource;
    authTier?: string;
  } & McpServerIdentity,
): void {
  // #8967: "anonymous", or the tier of the verified mg_ key. This is the one
  // dimension that makes the MCP access model measurable -- authentication
  // currently buys throughput only, and without this there is no way to ask
  // what share of traffic is authenticated, which is the question any decision
  // to extend the tier system has to start from.
  const authTier = sanitizeLabel(event.authTier);
  if (authTier !== undefined) properties["$mcp_auth_tier"] = authTier;

  const clientName = sanitizeLabel(event.clientName);
  if (clientName !== undefined) {
    properties["$mcp_client_name"] = clientName;
    // Provenance rides with the value, never separately — an unlabelled
    // client name would be indistinguishable from an MCP-declared one.
    if (event.clientNameSource) {
      properties["$mcp_client_name_source"] = event.clientNameSource;
    }
  }

  const clientVersion = sanitizeLabel(event.clientVersion);
  if (clientVersion !== undefined) {
    properties["$mcp_client_version"] = clientVersion;
  }

  const serverName = sanitizeLabel(event.serverName);
  if (serverName !== undefined) properties["$mcp_server_name"] = serverName;

  const serverVersion = sanitizeLabel(event.serverVersion);
  if (serverVersion !== undefined) {
    properties["$mcp_server_version"] = serverVersion;
  }
}

// MCP Analytics events (#7737). Emit PostHog's canonical $mcp_* event family
// so PostHog's built-in MCP Analytics dashboards work out of the box.
// Implemented via the same raw-fetch pattern as recordUsageEvent — posthog-
// node cannot be bundled into the Worker (bundle-budget constraint; see the
// header comment), so there is no SDK `instrument()` wrapper here and no
// SDK-provided default redaction sitting in front of what gets sent. Whatever
// this module includes in $mcp_parameters / $mcp_response, it redacts itself.
//
// redactMcpSensitiveFields mirrors the key-name-substring redaction
// posthog-node/@posthog/mcp applies automatically when instrument() drives
// capture (authorization/cookie/password/token/secret/api_key/private_key,
// per https://posthog.com/docs/mcp-analytics/privacy) — plus `credential`,
// which that default list does NOT cover and which call_subnet_surface's own
// `credential` argument (src/call-subnet-surface.ts) needs: a bearer token,
// API key, or Bittensor hotkey-signed bundle a caller supplies for one call.
// Every other sensitive argument this server takes is already covered by the
// baseline set — e.g. get_alert_trigger's `owner_token` via the "token"
// substring — so `credential` is the only addition needed.

const MCP_SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|token|secret|api[_-]?key|private[_-]?key|credential/i;

const MCP_REDACTED_VALUE = "[redacted]";

// Caps recursion on a pathologically deep structure (call_subnet_surface's
// `body` argument and its upstream response body are both fully caller/
// third-party-controlled) — a v8 stack limit is a much uglier failure mode
// than a placeholder string.
const MCP_REDACT_MAX_DEPTH = 8;

function redactMcpSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > MCP_REDACT_MAX_DEPTH) return "[max depth exceeded]";
  if (Array.isArray(value)) {
    return value.map((entry) => redactMcpSensitiveFields(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      redacted[key] = MCP_SENSITIVE_KEY_PATTERN.test(key)
        ? MCP_REDACTED_VALUE
        : redactMcpSensitiveFields(entry, depth + 1);
    }
    return redacted;
  }
  return value;
}

// Generous for typical tool-call arguments; far below call_subnet_surface's
// own 256 KiB response cap (src/call-subnet-surface.ts's MAX_RESPONSE_BYTES)
// so one large response can't balloon a PostHog capture payload.
const MCP_PAYLOAD_MAX_CHARS = 4096;

function boundedMcpPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  const redacted = redactMcpSensitiveFields(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return undefined;
  }
  if (typeof serialized !== "string") return undefined;
  if (serialized.length <= MCP_PAYLOAD_MAX_CHARS) return redacted;
  return {
    truncated: true,
    preview: serialized.slice(0, MCP_PAYLOAD_MAX_CHARS),
  };
}

/** Server identity stamped on every $mcp_* event (#8963), so a regression can
 * be pinned to the deploy that introduced it. Set by the MCP server from the
 * same constants that feed serverInfo / server.json. */
export interface McpServerIdentity {
  serverName?: string;
  serverVersion?: string;
}

/** Where a client name came from (#8963). `client_info` is the MCP handshake's
 * own clientInfo.name and is authoritative; `user_agent` is derived from the
 * HTTP User-Agent because this server is stateless and ~80% of production
 * tool calls arrive with no Mcp-Session-Id to link them back to an
 * initialize. Recorded alongside the name so a dashboard can tell an
 * MCP-declared identity from a transport-level guess. */
export type McpClientNameSource = "client_info" | "user_agent";

/** Inputs for a single MCP tool-call analytics event. */
export interface McpToolCallEvent extends McpServerIdentity {
  toolName?: string;
  isError: boolean;
  /**
   * Elapsed wall-clock ms. Cloudflare Workers freeze Date.now() between I/O
   * operations, so a call that rejects before performing any I/O measures
   * exactly 0 — indistinguishable from a genuinely instant call. Pass the
   * measured value; recordMcpToolCallEvent OMITS the property when it is 0
   * rather than reporting a fabricated zero (see JSONbored/loopover#10279).
   */
  durationMs: number;
  /**
   * The internal tool-error code from structuredContent.error.code. Projected
   * onto $mcp_error_type by classifyMcpErrorType; also emitted verbatim as
   * $mcp_error_code so the coarse bucket can be drilled into. Only meaningful
   * when isError is true.
   */
  errorCode?: string;
  clientName?: string;
  clientVersion?: string;
  clientNameSource?: McpClientNameSource;
  /**
   * #8967 / ADR 0027: which side of the MCP access model this call fell on --
   * "anonymous", or the tier of a verified mg_ key ("free" / "community" /
   * "paid"). Resolved by the rate-limit gate, which had to verify the bearer
   * token anyway, so labelling costs no extra verification.
   */
  authTier?: string;
  /** Mcp-Session-Id header value; omitted from the payload when absent. */
  sessionId?: string | null;
  /**
   * The tool call's raw arguments / result. Redacted (redactMcpSensitiveFields)
   * and size-capped (boundedMcpPayload) before ever being included in the
   * posted event — this module owns that, callers pass the raw value through.
   */
  parameters?: unknown;
  response?: unknown;
}

/** Inputs for an MCP initialize-handshake analytics event. */
export interface McpInitializeEvent extends McpServerIdentity {
  clientName?: string;
  clientVersion?: string;
  /** Mcp-Session-Id header value; omitted from the payload when absent. */
  sessionId?: string | null;
}

/** Inputs for an MCP `tools/list` analytics event (#8963). Discovery traffic —
 * registry crawlers listing the catalogue — is otherwise invisible: before
 * this event existed, a client that only ever called tools/list produced no
 * record at all. */
export interface McpToolsListEvent extends McpServerIdentity {
  /** How many tools the response advertised. */
  toolCount?: number;
  clientName?: string;
  clientVersion?: string;
  clientNameSource?: McpClientNameSource;
  sessionId?: string | null;
}

/**
 * Emit a PostHog `$mcp_tool_call` event via the capture endpoint.
 * Same no-throw contract as recordUsageEvent.
 */
export async function recordMcpToolCallEvent(
  env: Env | null | undefined,
  event: McpToolCallEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    if (typeof event.isError !== "boolean") return false;
    if (
      typeof event.durationMs !== "number" ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0
    ) {
      return false;
    }

    const properties: Record<string, unknown> = {
      $mcp_is_error: event.isError,
    };

    // Duration honesty (#8963): a 0 here means Date.now() never advanced,
    // which on Workers means no I/O happened — the call is unmeasurable, not
    // instantaneous. Omit the property entirely so percentile math and the
    // "fast call" bucket are computed only over real measurements. See the
    // durationMs doc comment on McpToolCallEvent.
    const durationMs = Math.min(Math.round(event.durationMs), 86_400_000);
    if (durationMs > 0) properties["$mcp_duration_ms"] = durationMs;

    const toolName = sanitizeLabel(event.toolName);
    if (toolName !== undefined) properties["$mcp_tool_name"] = toolName;

    // Failure classification (#8963). Emitted only on failure: an
    // $mcp_error_type on a successful call would poison every breakdown.
    if (event.isError) {
      const errorCode = sanitizeLabel(event.errorCode);
      if (errorCode !== undefined) properties["$mcp_error_code"] = errorCode;
      properties["$mcp_error_type"] = classifyMcpErrorType(event.errorCode);
    }

    assignMcpAttribution(properties, event);

    if (typeof event.sessionId === "string" && event.sessionId.trim()) {
      properties["$session_id"] = event.sessionId.trim();
    }

    const parameters = boundedMcpPayload(event.parameters);
    if (parameters !== undefined) properties["$mcp_parameters"] = parameters;

    const responseBody = boundedMcpPayload(event.response);
    if (responseBody !== undefined) properties["$mcp_response"] = responseBody;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$mcp_tool_call",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Emit a PostHog `$mcp_initialize` event via the capture endpoint.
 * Same no-throw contract as recordUsageEvent.
 */
export async function recordMcpInitializeEvent(
  env: Env | null | undefined,
  event: McpInitializeEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties: Record<string, unknown> = {};

    // clientInfo from the handshake itself is always authoritative here.
    assignMcpAttribution(properties, {
      ...event,
      clientNameSource: event.clientName ? "client_info" : undefined,
    });

    if (typeof event.sessionId === "string" && event.sessionId.trim()) {
      properties["$session_id"] = event.sessionId.trim();
    }

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$mcp_initialize",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Emit a PostHog `$mcp_tools_list` event via the capture endpoint (#8963).
 * Same no-throw contract as recordUsageEvent.
 */
export async function recordMcpToolsListEvent(
  env: Env | null | undefined,
  event: McpToolsListEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties: Record<string, unknown> = {};

    if (
      typeof event.toolCount === "number" &&
      Number.isFinite(event.toolCount) &&
      event.toolCount >= 0
    ) {
      properties["$mcp_tools_count"] = Math.round(event.toolCount);
    }

    assignMcpAttribution(properties, event);

    if (typeof event.sessionId === "string" && event.sessionId.trim()) {
      properties["$session_id"] = event.sessionId.trim();
    }

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$mcp_tools_list",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

// Error tracking via PostHog's manual/raw $exception capture (#7758). No SDK
// needed for this either -- PostHog documents a raw capture-API shape for
// exactly the "no SDK for your platform" case (a real, first-class path, not
// a hack). The public docs page (posthog.com/docs/api/capture) only
// summarizes the shape; the exact property names/types below are confirmed
// against PostHog's own repo (docs/onboarding/error-tracking/api.tsx, the
// source their public docs render from), including a real example payload.
// Originally landed as a parallel-run alongside each site's existing
// Sentry.captureException call, additive rather than a replacement
// (metagraphed#7757 is the consolidation epic). #7766 has since removed
// Sentry everywhere this wires into once parity was proven, so PostHog is
// now the only exception-capture path at every one of these call sites.

/** One PostHog `$exception_list` stack frame. `platform`/`lang` are always
 * "custom"/"javascript" -- PostHog's required marker for a manually built
 * (non-SDK) frame, not something derived from the actual error. */
interface ExceptionStackFrame {
  platform: "custom";
  lang: "javascript";
  function: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

// Caps how many stack frames get sent -- a runaway recursive error could
// otherwise produce hundreds of near-identical frames for little value.
const MAX_EXCEPTION_FRAMES = 30;

// Matches V8's `Error.prototype.stack` frame format (Workers run the same V8
// engine Node does): "    at functionName (file:line:col)" or
// "    at file:line:col" for an anonymous/top-level frame. Never throws on
// an unrecognized line -- it still becomes a frame (the raw text as
// `function`, no file/line/col) rather than being silently dropped.
const STACK_FRAME_PATTERN =
  /^\s*at\s+(?:(.+?)\s+\()?([^()]+):(\d+):(\d+)\)?\s*$/;

function parseStackFrames(stack: string): ExceptionStackFrame[] {
  // The first line is "ErrorName: message", not a frame.
  const lines = stack.split("\n").slice(1, MAX_EXCEPTION_FRAMES + 1);
  const frames: ExceptionStackFrame[] = [];
  for (const line of lines) {
    const match = STACK_FRAME_PATTERN.exec(line);
    if (match) {
      const [, fn, filename, lineno, colno] = match;
      frames.push({
        platform: "custom",
        lang: "javascript",
        function: fn?.trim() || "<anonymous>",
        filename: filename.trim(),
        lineno: Number(lineno),
        colno: Number(colno),
        in_app: !filename.includes("node_modules"),
      });
    } else if (line.trim()) {
      frames.push({
        platform: "custom",
        lang: "javascript",
        function: line.trim(),
      });
    }
  }
  // PostHog/Sentry's event protocol (this shape is explicitly modeled on
  // Sentry's) orders frames oldest-call-first -- the LAST entry is where the
  // exception was thrown. That's the reverse of how V8 prints a stack
  // (most-recent-call-first), so the parsed order is reversed here to match.
  return frames.reverse();
}

/** Inputs for a captured exception. `error` is the raw caught value -- this
 * module extracts type/message/stack itself, callers never format it.
 * `route`/`mcpTool` mirror UsageEvent's own fields (same vocabulary, so
 * insights can filter consistently across usage_event/$mcp_tool_call/
 * $exception) and double as the fingerprint's grouping key. */
export interface ExceptionEvent {
  error: unknown;
  route?: string;
  mcpTool?: string;
  errorCode?: string;
}

function exceptionListEntry(error: unknown): {
  type: string;
  entry: Record<string, unknown>;
} {
  const isError = error instanceof Error;
  const type =
    sanitizeLabel(isError && error.name ? error.name : "Error") ?? "Error";
  const rawMessage = isError ? error.message : String(error);
  const value = sanitizeLabel(rawMessage) ?? "(no message)";
  const frames =
    isError && typeof error.stack === "string"
      ? parseStackFrames(error.stack)
      : [];
  return {
    type,
    entry: {
      type,
      value,
      // Every capture site wraps a genuinely caught (try/catch), non-fatal
      // fault -- never an uncaught/fatal one. Since #7766 removed Sentry's
      // automatic withSentry() wrap, a truly uncaught throw has no dedicated
      // $exception capture of its own; it still surfaces as an ok:false
      // usage event (and trace span, if sampled) via withUsageTelemetry's
      // finally block in workers/api.ts, just without a stack trace.
      mechanism: { handled: true, synthetic: false },
      stacktrace: { type: "raw", frames },
    },
  };
}

/**
 * Capture one exception as a PostHog `$exception` event. Same no-throw,
 * no-op-when-unconfigured contract as recordUsageEvent/recordMcpToolCallEvent.
 *
 * Message/stack text is NOT run through the key-based redaction
 * (redactMcpSensitiveFields) that $mcp_parameters/$mcp_response get --
 * that helper redacts by object KEY name, and an exception message is free
 * text with no keys to match. Every capture site this wires into is an
 * unexpected internal fault (not a caller-input-echoing path), and the one
 * call site that could plausibly embed a credential in an error string
 * (call_subnet_surface's own fetches) already scrubs it at the source
 * (redactCredentialValue in src/call-subnet-surface.ts) before it ever
 * becomes a thrown/logged error -- so there is no known raw-secret vector
 * into this function, only the general caution free text always deserves.
 */
export async function recordExceptionEvent(
  env: Env | null | undefined,
  event: ExceptionEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;
    if (!event || typeof event !== "object") return false;

    const { type, entry } = exceptionListEntry(event.error);
    const route = sanitizeLabel(event.route);
    const mcpTool = sanitizeLabel(event.mcpTool);
    const properties: Record<string, unknown> = {
      $exception_list: [entry],
      // A stable string groups every occurrence of "this site threw this
      // error type" into one PostHog issue -- matching the route/mcp_tool
      // tag Sentry already gets at these sites, so the two dashboards read
      // consistently. Falls back to "unknown" only if neither is supplied.
      $exception_fingerprint: `${route ?? mcpTool ?? "unknown"}:${type}`,
    };
    if (route !== undefined) properties.route = route;
    if (mcpTool !== undefined) properties.mcp_tool = mcpTool;
    const errorCode = sanitizeLabel(event.errorCode);
    if (errorCode !== undefined) properties.error_code = errorCode;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$exception",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

// AI generation observability via PostHog's raw `$ai_generation` event (#7763).
// Same raw-fetch, no-throw, no-op-when-unconfigured contract as the other
// recordX helpers above -- no SDK (posthog-ai pulls in an LLM-provider client
// layer neither needed nor affordable inside the Worker bundle budget; see the
// header comment). The exact property names/units below are NOT from PostHog's
// docs pages (posthog.com/docs/ai-engineering/observability/manual-capture and
// .../python both 404 as of this writing) -- they're read off PostHog's own
// posthog-js-lite SDK source (posthog-ai/src/utils.ts), the same
// verify-against-source approach #7758's $exception shape used.
//
// #7763 started this content-free (only cost/token/latency/model metadata,
// never prompt/completion text) as the default posture for an unscoped LLM
// surface. #8082 is the deliberate reversal that clause called for: the one
// caller of this function (askQuestion() in ai-search.ts) only ever answers
// questions about public on-chain/registry data -- no private/authenticated
// user content is ever in scope -- so the content-free default didn't earn
// its keep here, and withholding it left PostHog's Input/Output Message
// columns blank and Sentiment analysis unable to run (it reads the input/
// output text). `input`/`outputChoices` below are genuinely optional on the
// TYPE (a future caller with a real privacy-sensitive surface can simply
// omit them and get the original #7763 behavior back).

/** Inputs for one AI generation call. `error` mirrors ExceptionEvent's own
 * `error` (raw caught value, this module extracts type/message itself) --
 * never a caller-preformatted string. */
export interface AiGenerationEvent {
  provider: string;
  model: string;
  /** Groups an event to its call; PostHog requires one per generation even
   * outside a multi-step chain, so a fresh UUID is minted when omitted --
   * mirrors posthog-ai's own `uuidv4()` fallback. */
  traceId?: string;
  /** Display label for the trace on PostHog's Traces page (e.g. "ask"). */
  traceName?: string;
  latencyMs: number;
  isError: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Only included when BOTH are finite -- see costUsd() in ai-search.ts,
   * which returns undefined for missing/invalid token counts. */
  inputCostUsd?: number;
  outputCostUsd?: number;
  /** Generation config (e.g. `{ max_tokens }`), never prompt/completion text. */
  modelParameters?: Record<string, string | number | boolean>;
  /** The prompt sent to the model, PostHog's `{role, content}[]` shape. See
   * the module comment above for why this caller includes it. */
  input?: Array<{ role: string; content: string }>;
  /** The model's response, in PostHog's completion-choice shape. Same
   * inclusion reasoning as `input` above. */
  outputChoices?: Array<{ role: string; content: string }>;
  error?: unknown;
}

/** A degraded AI path (#8965): work the caller asked for that never reached a
 * model. Deliberately NOT a $ai_generation with isError — a rate-limited call
 * made no model request, so counting it as a failed generation would corrupt
 * both the error rate and the cost figures. Mirrors loopover's
 * `selfhost_ai_degraded` precedent. */
export interface AiDegradedEvent {
  /** Why the path degraded, from a fixed set this codebase defines. */
  reason: "rate_limited" | "ai_disabled" | "ai_unconfigured";
  /** Which entry point was refused (`ask`, `semantic_search`). */
  surface?: string;
}

/**
 * Record one degraded-AI-path event as `ai_degraded` (#8965). Same no-throw,
 * no-op-when-unconfigured contract as every recorder here.
 */
export async function recordAiDegradedEvent(
  env: Env | null | undefined,
  event: AiDegradedEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;
    const reason = sanitizeLabel(event?.reason);
    if (reason === undefined) return false;

    const properties: Record<string, unknown> = { reason };
    const surface = sanitizeLabel(event.surface);
    if (surface !== undefined) properties.surface = surface;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "ai_degraded",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

/** One embedding call (#8965). PostHog's `$ai_embedding` shares the
 * generation contract's shape minus the completion half — no output tokens, no
 * output choices, no completion cost. */
export interface AiEmbeddingEvent {
  provider: string;
  model: string;
  /** Ties the query-time embedding to the retrieval and completion it feeds,
   * so one `ask` reads as a single trace rather than three unrelated events.
   * The cron sync mints one trace per run. */
  traceId?: string;
  traceName?: string;
  latencyMs: number;
  isError: boolean;
  inputTokens?: number;
  /** How many texts were embedded in this call — 1 for a query, a batch size
   * for the cron sync. Workers AI bills per call, so a 200-document batch and a
   * single query are not comparable without it. */
  inputCount?: number;
  error?: unknown;
}

/**
 * Capture one embedding call as a PostHog `$ai_embedding` event (#8965). Same
 * no-throw, no-op-when-unconfigured contract as recordAiGenerationEvent.
 *
 * No cost is reported. Workers AI bills embeddings in neurons, not per token,
 * and there is no published neuron→USD rate stable enough to hard-code the way
 * ASK_MODEL's per-million-token prices are (see ai-search.ts). Emitting a
 * fabricated $ai_total_cost_usd would poison the same cost dashboards the
 * generation events feed honestly, so the call count and token count are
 * reported and the cost column is left genuinely empty.
 */
export async function recordAiEmbeddingEvent(
  env: Env | null | undefined,
  event: AiEmbeddingEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;
    if (typeof event.isError !== "boolean") return false;
    if (
      typeof event.latencyMs !== "number" ||
      !Number.isFinite(event.latencyMs) ||
      event.latencyMs < 0
    ) {
      return false;
    }

    const properties: Record<string, unknown> = {
      $ai_trace_id: event.traceId ?? crypto.randomUUID(),
      $ai_model: sanitizeLabel(event.model) ?? "unknown",
      $ai_provider: sanitizeLabel(event.provider) ?? "unknown",
      // PostHog reports latency in SECONDS, as with $ai_generation.
      $ai_latency: event.latencyMs / 1000,
      $ai_http_status: event.isError ? 500 : 200,
      $ai_is_error: event.isError,
    };

    // Workers AI's embedding response carries no `usage` object, so a token
    // count is genuinely unavailable here -- not zero. Reporting 0 would be
    // the same fabricated-value defect #8963 fixed for $mcp_duration_ms: it
    // makes "we cannot measure this" indistinguishable from "this embedded
    // nothing", and it drags any sum or average over embeddings toward zero.
    // Omit unless a caller actually has a count. ($ai_generation keeps its own
    // 0 default: Workers AI does return usage for completions, so a 0 there is
    // a real reading, and changing it would rewrite established semantics
    // mid-stream.)
    if (Number.isFinite(event.inputTokens)) {
      properties.$ai_input_tokens = event.inputTokens;
    }

    const traceName = sanitizeLabel(event.traceName);
    if (traceName !== undefined) properties.$ai_trace_name = traceName;

    if (
      Number.isFinite(event.inputCount) &&
      (event.inputCount as number) >= 0
    ) {
      properties.$ai_input_count = Math.round(event.inputCount as number);
    }

    if (event.isError) {
      const { type, entry } = exceptionListEntry(event.error);
      properties.$ai_error = `${type}: ${entry.value}`;
    }

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$ai_embedding",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Capture one LLM call as a PostHog `$ai_generation` event. Same no-throw,
 * no-op-when-unconfigured contract as recordUsageEvent/recordExceptionEvent.
 */
export async function recordAiGenerationEvent(
  env: Env | null | undefined,
  event: AiGenerationEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;
    if (typeof event.isError !== "boolean") return false;
    if (
      typeof event.latencyMs !== "number" ||
      !Number.isFinite(event.latencyMs) ||
      event.latencyMs < 0
    ) {
      return false;
    }

    const properties: Record<string, unknown> = {
      $ai_trace_id: event.traceId ?? crypto.randomUUID(),
      $ai_model: sanitizeLabel(event.model) ?? "unknown",
      $ai_provider: sanitizeLabel(event.provider) ?? "unknown",
      // PostHog's $ai_generation schema reports latency in SECONDS, not ms.
      $ai_latency: event.latencyMs / 1000,
      // env.AI.run() is a Workers RPC binding, not raw HTTP -- there is no
      // real transport status to report, so this is derived from isError.
      $ai_http_status: event.isError ? 500 : 200,
      $ai_input_tokens: Number.isFinite(event.inputTokens)
        ? event.inputTokens
        : 0,
      $ai_output_tokens: Number.isFinite(event.outputTokens)
        ? event.outputTokens
        : 0,
      $ai_is_error: event.isError,
    };

    const traceName = sanitizeLabel(event.traceName);
    if (traceName !== undefined) properties.$ai_trace_name = traceName;

    if (event.modelParameters) {
      properties.$ai_model_parameters = event.modelParameters;
    }

    if (Array.isArray(event.input) && event.input.length > 0) {
      properties.$ai_input = event.input;
    }

    if (Array.isArray(event.outputChoices) && event.outputChoices.length > 0) {
      properties.$ai_output_choices = event.outputChoices;
    }

    if (
      Number.isFinite(event.inputCostUsd) &&
      Number.isFinite(event.outputCostUsd)
    ) {
      properties.$ai_input_cost_usd = event.inputCostUsd;
      properties.$ai_output_cost_usd = event.outputCostUsd;
      properties.$ai_total_cost_usd =
        (event.inputCostUsd as number) + (event.outputCostUsd as number);
    }

    if (event.isError) {
      const { type, entry } = exceptionListEntry(event.error);
      properties.$ai_error = `${type}: ${entry.value}`;
    }

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: "$ai_generation",
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    return false;
  }
}
