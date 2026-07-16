// Typed PostHog usage-event wrapper for the Worker backend (#6030 / #366).
//
// Single chokepoint for product-usage capture: callers pass an allowlisted
// UsageEvent; this module owns the PostHog event name/properties and posts
// directly to PostHog's public capture API via fetch. We deliberately do NOT
// import `posthog-node` here — that SDK's workerd build adds ~35 KiB gzipped
// and this Worker's bundle is already within a few KiB of Cloudflare's 1 MiB
// script limit (see scripts/worker-bundle-budget.mjs).
//
// Safe no-op when POSTHOG_PROJECT_TOKEN is unset — self-hosters / local / CI
// see zero behavior change. Never throws. MCP tool-dispatch (#6031) is the
// first caller; REST/GraphQL request-handler wiring is #6032.

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

/**
 * @typedef {object} UsageEvent
 * @property {string} [route] REST/GraphQL route path (no query string / bodies).
 * @property {string} [mcpTool] MCP tool name (no arguments / response content).
 * @property {boolean} ok Whether the request/tool call succeeded.
 * @property {number} durationMs Wall-clock duration in milliseconds (>= 0).
 */

/**
 * @typedef {object} RecordUsageEventDeps
 * @property {typeof fetch} [fetch] Injectable fetch (tests).
 * @property {string} [distinctId] Override distinct_id (tests).
 */

/**
 * True when this deployment has a non-empty PostHog project token configured.
 * @param {object | null | undefined} env
 * @returns {boolean}
 */
export function isUsageTelemetryConfigured(env) {
  const token = env?.[POSTHOG_PROJECT_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * Build the allowlisted PostHog properties object, or null when the event is
 * too malformed to record (missing ok / non-finite duration).
 * @param {UsageEvent | null | undefined} event
 * @returns {Record<string, string | number | boolean> | null}
 */
export function usageEventProperties(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.ok !== "boolean") return null;
  if (
    typeof event.durationMs !== "number" ||
    !Number.isFinite(event.durationMs) ||
    event.durationMs < 0
  ) {
    return null;
  }

  /** @type {Record<string, string | number | boolean>} */
  const properties = {
    ok: event.ok,
    // Coarse integer ms — drop sub-ms noise; clamp absurd values at 24h.
    duration_ms: Math.min(Math.round(event.durationMs), 86_400_000),
    // Server-side anonymous product event — do not create/merge a person profile.
    $process_person_profile: false,
  };

  const route = sanitizeLabel(event.route);
  if (route !== undefined) properties.route = route;

  const mcpTool = sanitizeLabel(event.mcpTool);
  if (mcpTool !== undefined) properties.mcp_tool = mcpTool;

  return properties;
}

/**
 * @param {object | null | undefined} env
 * @returns {string}
 */
export function resolvePostHogHost(env) {
  return typeof env?.[POSTHOG_HOST_ENV] === "string" &&
    env[POSTHOG_HOST_ENV].trim()
    ? env[POSTHOG_HOST_ENV].trim()
    : DEFAULT_POSTHOG_HOST;
}

/**
 * Capture URL for a PostHog host (trailing slash normalized).
 * @param {string} host
 * @returns {string}
 */
export function postHogCaptureUrl(host) {
  return `${String(host).replace(/\/+$/, "")}/i/v0/e/`;
}

/**
 * Record one product-usage event. Resolves without throwing; returns whether
 * an event was handed to PostHog. Callers that need Workers flush semantics
 * should schedule the returned promise via `ctx.waitUntil(...)`.
 *
 * @param {object | null | undefined} env Worker env (reads POSTHOG_* vars).
 * @param {UsageEvent} event Allowlisted usage fields only.
 * @param {RecordUsageEventDeps} [deps]
 * @returns {Promise<boolean>}
 */
export async function recordUsageEvent(env, event, deps = {}) {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties = usageEventProperties(event);
    if (!properties) return false;

    const token = String(env[POSTHOG_PROJECT_TOKEN_ENV]).trim();
    const host = resolvePostHogHost(env);
    // Prefer an injected fetch when the key is present — including an
    // explicit `null` (tests: "fetch unavailable") — over falling through
    // to globalThis.fetch via `??` (which treats null as missing).
    const doFetch = Object.hasOwn(deps, "fetch")
      ? deps.fetch
      : globalThis.fetch;
    if (typeof doFetch !== "function") return false;

    const response = await doFetch(postHogCaptureUrl(host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        event: USAGE_EVENT_NAME,
        distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
        properties,
      }),
    });

    // Consume/cancel the body so Cloudflare Workers don't warn about an
    // unconsumed fetch response leaking across isolate requests.
    try {
      await response.body?.cancel?.();
    } catch {
      // ignore
    }

    return Boolean(response.ok);
  } catch {
    // Telemetry must never surface into the request/tool path.
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeLabel(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS
    ? trimmed.slice(0, MAX_LABEL_CHARS)
    : trimmed;
}
