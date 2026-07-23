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

// ─── PostHog native MCP analytics (#7737) ───────────────────────────────────
//
// Hand-rolled `$mcp_*` events (same raw-fetch capture as recordUsageEvent).
// posthog-node / @posthog/mcp cannot ship in this Worker (bundle budget —
// see header comment), so there is no SDK redaction pipeline in front of
// `$mcp_parameters` / `$mcp_response`. Whatever we put on the wire is what
// PostHog stores; credential-bearing tool args (call_subnet_surface) must
// never leave this process unredacted.

/** Canonical PostHog MCP handshake event. */
export const MCP_INITIALIZE_EVENT = "$mcp_initialize";

/** Canonical PostHog MCP tools/call event. */
export const MCP_TOOL_CALL_EVENT = "$mcp_tool_call";

/** Placeholder substituted for any sensitive-key value. */
export const MCP_REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Key names (lower-snake) whose values are always replaced before capture.
 * Covers call_subnet_surface's `credential`, alert owner tokens, and the
 * baseline set PostHog's own MCP SDK auto-redacts.
 */
export const MCP_SENSITIVE_KEYS = Object.freeze(
  new Set([
    "credential",
    "owner_token",
    "authorization",
    "cookie",
    "password",
    "token",
    "secret",
    "api_key",
    "private_key",
  ]),
);

// Size caps loosely mirror PostHog SDK truncation (depth/breadth/string) so a
// single tool response cannot blow the capture body. Tuned for Worker cost,
// not byte-identical to the SDK.
const MCP_MAX_DEPTH = 10;
const MCP_MAX_BREADTH = 100;
const MCP_MAX_STRING_CHARS = 8_192;
const MCP_MAX_SERIALIZED_CHARS = 32_768;

export interface McpInitializeAnalytics {
  clientName?: string;
  clientVersion?: string;
  serverName: string;
  serverVersion: string;
  sessionId?: string | null;
}

export interface McpToolCallAnalytics {
  toolName: string;
  toolDescription?: string;
  parameters?: unknown;
  response?: unknown;
  durationMs: number;
  isError: boolean;
  errorType?: string;
  sessionId?: string | null;
}

export interface RecordMcpAnalyticsDeps {
  fetch?: typeof fetch;
  distinctId?: string;
}

/** True when `key` is a sensitive MCP analytics key (case-insensitive). */
export function isSensitiveMcpKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return MCP_SENSITIVE_KEYS.has(key.trim().toLowerCase());
}

/**
 * Recursively redact sensitive-key values and size-cap the result for safe
 * inclusion in `$mcp_parameters` / `$mcp_response`. Never throws.
 */
export function sanitizeMcpPayload(value: unknown, depth = 0): unknown {
  try {
    if (depth > MCP_MAX_DEPTH) return "[truncated:max_depth]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return value.length > MCP_MAX_STRING_CHARS
        ? `${value.slice(0, MCP_MAX_STRING_CHARS)}…[truncated]`
        : value;
    }
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value !== "object") return String(value);

    if (Array.isArray(value)) {
      const items = value
        .slice(0, MCP_MAX_BREADTH)
        .map((item) => sanitizeMcpPayload(item, depth + 1));
      if (value.length > MCP_MAX_BREADTH) {
        items.push(`[truncated:${value.length - MCP_MAX_BREADTH}_more]`);
      }
      return items;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    let count = 0;
    for (const [key, child] of entries) {
      if (count >= MCP_MAX_BREADTH) {
        out["…"] = `[truncated:${entries.length - MCP_MAX_BREADTH}_more]`;
        break;
      }
      count += 1;
      out[key] = isSensitiveMcpKey(key)
        ? MCP_REDACTED_PLACEHOLDER
        : sanitizeMcpPayload(child, depth + 1);
    }
    return out;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Sanitize then enforce a total serialized-size budget. Prefer this over
 * sanitizeMcpPayload alone when building `$mcp_parameters` / `$mcp_response`.
 */
export function captureSafeMcpPayload(value: unknown): unknown {
  const sanitized = sanitizeMcpPayload(value);
  try {
    const serialized = JSON.stringify(sanitized);
    if (
      typeof serialized === "string" &&
      serialized.length > MCP_MAX_SERIALIZED_CHARS
    ) {
      return {
        truncated: true,
        preview: `${serialized.slice(0, MCP_MAX_SERIALIZED_CHARS)}…[truncated]`,
      };
    }
  } catch {
    return "[unserializable]";
  }
  return sanitized;
}

/** Allowlisted `$mcp_initialize` properties, or null when too malformed. */
export function mcpInitializeProperties(
  event: McpInitializeAnalytics | null | undefined,
): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const serverName = sanitizeLabel(event.serverName);
  const serverVersion = sanitizeLabel(event.serverVersion);
  if (!serverName || !serverVersion) return null;

  const properties: Record<string, unknown> = {
    $mcp_server_name: serverName,
    $mcp_server_version: serverVersion,
    // Anonymous Worker sessions must not mint a person profile per handshake.
    $process_person_profile: false,
  };

  const clientName = sanitizeLabel(event.clientName);
  if (clientName !== undefined) properties.$mcp_client_name = clientName;
  const clientVersion = sanitizeLabel(event.clientVersion);
  if (clientVersion !== undefined) {
    properties.$mcp_client_version = clientVersion;
  }
  const sessionId = sanitizeLabel(event.sessionId ?? undefined);
  if (sessionId !== undefined) properties.$session_id = sessionId;

  return properties;
}

/** Allowlisted `$mcp_tool_call` properties, or null when too malformed. */
export function mcpToolCallProperties(
  event: McpToolCallAnalytics | null | undefined,
): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const toolName = sanitizeLabel(event.toolName);
  if (!toolName) return null;
  if (typeof event.isError !== "boolean") return null;
  if (
    typeof event.durationMs !== "number" ||
    !Number.isFinite(event.durationMs) ||
    event.durationMs < 0
  ) {
    return null;
  }

  const properties: Record<string, unknown> = {
    $mcp_tool_name: toolName,
    $mcp_duration_ms: Math.min(Math.round(event.durationMs), 86_400_000),
    $mcp_is_error: event.isError,
    $mcp_parameters: captureSafeMcpPayload(event.parameters ?? {}),
    $mcp_response: captureSafeMcpPayload(event.response ?? null),
    $process_person_profile: false,
  };

  const description = sanitizeLabel(event.toolDescription);
  if (description !== undefined) properties.$mcp_tool_description = description;

  if (event.isError) {
    const errorType = sanitizeLabel(event.errorType);
    if (errorType !== undefined) properties.$mcp_error_type = errorType;
  }

  const sessionId = sanitizeLabel(event.sessionId ?? undefined);
  if (sessionId !== undefined) properties.$session_id = sessionId;

  return properties;
}

/**
 * Post one native `$mcp_*` analytics event. Same safe no-op / never-throw
 * contract as recordUsageEvent.
 */
export async function recordMcpAnalyticsEvent(
  env: Env | null | undefined,
  eventName: typeof MCP_INITIALIZE_EVENT | typeof MCP_TOOL_CALL_EVENT,
  properties: Record<string, unknown>,
  deps: RecordMcpAnalyticsDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;
    if (
      eventName !== MCP_INITIALIZE_EVENT &&
      eventName !== MCP_TOOL_CALL_EVENT
    ) {
      return false;
    }
    if (!properties || typeof properties !== "object") return false;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event: eventName,
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

/** Convenience: build + post `$mcp_initialize`. */
export async function recordMcpInitializeEvent(
  env: Env | null | undefined,
  event: McpInitializeAnalytics,
  deps: RecordMcpAnalyticsDeps = {},
): Promise<boolean> {
  const properties = mcpInitializeProperties(event);
  if (!properties) return false;
  return recordMcpAnalyticsEvent(env, MCP_INITIALIZE_EVENT, properties, deps);
}

/** Convenience: build + post `$mcp_tool_call` with redacted payloads. */
export async function recordMcpToolCallEvent(
  env: Env | null | undefined,
  event: McpToolCallAnalytics,
  deps: RecordMcpAnalyticsDeps = {},
): Promise<boolean> {
  const properties = mcpToolCallProperties(event);
  if (!properties) return false;
  return recordMcpAnalyticsEvent(env, MCP_TOOL_CALL_EVENT, properties, deps);
}
