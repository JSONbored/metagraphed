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

// --- PostHog native MCP analytics (#7737) -----------------------------------
//
// The `$mcp_*` event family PostHog's MCP Analytics wizard instruments,
// hand-rolled through the same raw-fetch capture path as `usage_event` above
// (the `posthog-node`/`@posthog/mcp` SDK wrapper is ruled out by the bundle
// budget -- see the header comment). Because there is no SDK-provided
// redaction pipeline in front of `$mcp_parameters`/`$mcp_response` on this
// path, this module owns one: recursive key-name-based redaction that must
// run before anything is serialized into a capture.

/** PostHog-native MCP lifecycle event names owned by this wrapper. */
export const MCP_INITIALIZE_EVENT_NAME = "$mcp_initialize";
export const MCP_TOOL_CALL_EVENT_NAME = "$mcp_tool_call";

/** Placeholder every redacted value is replaced with. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

// Key names whose values must never leave this server in an analytics
// payload: the credential-bearing tool arguments this codebase itself defines
// (`credential`, `owner_token`) plus the baseline set PostHog's own SDK
// auto-redacts. Matched case-insensitively as substrings so wrappers like
// `Authorization`, `session_cookie`, or `refresh_token` are covered too --
// over-redacting an analytics capture is always safe, leaking never is.
const REDACTED_KEY_NAMES = [
  "credential",
  "owner_token",
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "api_key",
  "private_key",
];

// Bound the serialized parameter/response captures. 4 KiB keeps the whole
// capture request comfortably small while retaining enough of a payload to
// be diagnostically useful.
const MAX_CAPTURE_JSON_CHARS = 4096;

// Fail closed past this nesting depth: anything deeper is replaced with the
// placeholder rather than passed through unexamined.
const MAX_REDACTION_DEPTH = 8;

function isRedactedKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return REDACTED_KEY_NAMES.some((name) => lowered.includes(name));
}

/**
 * Recursively replace the values of sensitive-named keys with
 * REDACTED_PLACEHOLDER. Arrays are walked element-wise; primitives pass
 * through; anything nested beyond MAX_REDACTION_DEPTH is redacted wholesale
 * (fail closed) instead of being emitted unexamined.
 */
export function redactAnalyticsValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACTION_DEPTH) return REDACTED_PLACEHOLDER;
  if (Array.isArray(value)) {
    return value.map((entry) => redactAnalyticsValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isRedactedKey(key)
        ? REDACTED_PLACEHOLDER
        : redactAnalyticsValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact, serialize, and size-cap a `$mcp_parameters`/`$mcp_response`
 * capture. Returns undefined when there is nothing to capture or the value
 * cannot be serialized (cycles, exotic objects) -- dropping a capture is
 * always preferable to failing or leaking.
 */
export function redactedCaptureJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(redactAnalyticsValue(value));
    if (typeof json !== "string") return undefined;
    return json.length > MAX_CAPTURE_JSON_CHARS
      ? json.slice(0, MAX_CAPTURE_JSON_CHARS)
      : json;
  } catch {
    return undefined;
  }
}

/** One PostHog-native MCP analytics event (#7737). `parameters`/`response`
 * are the RAW values -- redaction and capping happen inside this module, so
 * no caller ever has to remember to pre-scrub them. */
export interface McpAnalyticsEvent {
  type: "initialize" | "tool_call";
  toolName?: string;
  parameters?: unknown;
  response?: unknown;
  ok?: boolean;
  durationMs?: number;
  /** Same fixed-literal-code contract as UsageEvent.errorCode (#7726). */
  errorCode?: string;
}

/**
 * Build the properties for one `$mcp_*` capture, or null when the event is
 * malformed. Every free-form field is redacted/capped here -- nothing
 * reaches the capture body unscrubbed.
 */
export function mcpAnalyticsProperties(
  event: McpAnalyticsEvent | null | undefined,
): Record<string, string | number | boolean> | null {
  if (!event || typeof event !== "object") return null;
  if (event.type !== "initialize" && event.type !== "tool_call") return null;

  const properties: Record<string, string | number | boolean> = {};

  const toolName = sanitizeLabel(event.toolName);
  if (toolName !== undefined) properties.$mcp_tool_name = toolName;

  if (typeof event.ok === "boolean") properties.ok = event.ok;

  if (
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0
  ) {
    properties.duration_ms = Math.min(Math.round(event.durationMs), 86_400_000);
  }

  const errorCode = sanitizeLabel(event.errorCode);
  if (errorCode !== undefined) properties.error_code = errorCode;

  const parameters = redactedCaptureJson(event.parameters);
  if (parameters !== undefined) properties.$mcp_parameters = parameters;

  const response = redactedCaptureJson(event.response);
  if (response !== undefined) properties.$mcp_response = response;

  return properties;
}

/**
 * Record one PostHog-native MCP analytics event through the same raw-fetch
 * capture path as recordUsageEvent. Same contract: resolves without
 * throwing, returns whether a capture was handed to PostHog, safe no-op when
 * the deployment is unconfigured.
 */
export async function recordMcpAnalyticsEvent(
  env: Env | null | undefined,
  event: McpAnalyticsEvent,
  deps: RecordUsageEventDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties = mcpAnalyticsProperties(event);
    if (!properties) return false;

    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_CAPTURE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          event:
            event.type === "initialize"
              ? MCP_INITIALIZE_EVENT_NAME
              : MCP_TOOL_CALL_EVENT_NAME,
          distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
          properties,
        }),
      },
    );

    return response?.ok === true;
  } catch {
    // Telemetry must never surface into the request/tool path.
    return false;
  }
}

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS
    ? trimmed.slice(0, MAX_LABEL_CHARS)
    : trimmed;
}
