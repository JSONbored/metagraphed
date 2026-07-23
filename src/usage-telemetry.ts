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

  return properties;
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

/** Inputs for a single MCP tool-call analytics event. */
export interface McpToolCallEvent {
  toolName?: string;
  isError: boolean;
  durationMs: number;
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
export interface McpInitializeEvent {
  clientName?: string;
  clientVersion?: string;
  /** Mcp-Session-Id header value; omitted from the payload when absent. */
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
      $mcp_duration_ms: Math.min(Math.round(event.durationMs), 86_400_000),
    };

    const toolName = sanitizeLabel(event.toolName);
    if (toolName !== undefined) properties["$mcp_tool_name"] = toolName;

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

    const properties: Record<string, string | number | boolean> = {};

    const clientName = sanitizeLabel(event.clientName);
    if (clientName !== undefined) properties["$mcp_client_name"] = clientName;

    const clientVersion = sanitizeLabel(event.clientVersion);
    if (clientVersion !== undefined)
      properties["$mcp_client_version"] = clientVersion;

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
