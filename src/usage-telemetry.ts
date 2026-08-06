// Typed PostHog usage-event wrapper for the Worker backend (#6030 / #366).
//
// Single chokepoint for product-usage capture: callers pass an allowlisted
// UsageEvent; this module owns the PostHog event name/properties and posts
// them straight to PostHog's public capture API with fetch.
// Nothing outside this file should construct a raw PostHog event.
//
// This module does not import `posthog-node`, and the reason is NARROWER than
// it used to claim. The old rationale was that the SDK's ~40 KiB "pushes the
// deployable bundle past the limit outright", because the Worker entry was
// "already within a few KiB of Cloudflare's 1 MiB script limit". Both halves
// were wrong (#9059): Cloudflare's gzipped limit is 10 MB on Workers Paid,
// not 1 MiB, and this entry measures ~531 KiB — about 5% of budget. The SDK
// was always affordable, and that false constraint is what justified hand-
// writing a PostHog client here for as long as it stood.
//
// What remains true is only the runtime-shape argument: posthog-node is built
// for a long-lived Node process (background batching, flush intervals,
// shutdown draining), none of which survives a Workers isolate that may be
// evicted between requests — a batched event is a dropped event here. The
// usage/AI-event capture below is therefore one fetch per event to the
// documented capture endpoint, which is the platform-native transport.
//
// That argument does NOT extend to EXCEPTION capture, where the SDK's value
// is the frame/stack shaping rather than its transport (see #9048: months of
// unsymbolicated stacks from a hand-maintained wire shape). Bundle size is no
// longer a reason to hand-roll anything.
//
// Safe no-op when POSTHOG_PROJECT_TOKEN is unset — self-hosters / local / CI
// see zero behavior change. Never throws.

import { ErrorTracking } from "@posthog/core";
import { z } from "zod";

import { registerModuleStateReset } from "./module-state-registry.ts";

/** Env var holding the PostHog project API token (wrangler secret). */
export const POSTHOG_PROJECT_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN";

/** Optional PostHog host override (defaults to PostHog US cloud). */
export const POSTHOG_HOST_ENV = "POSTHOG_HOST";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Stable distinct_id for anonymous Worker-side product events. */
export const USAGE_EVENT_DISTINCT_ID = "metagraphed-worker";

/** PostHog event name owned by this wrapper — do not emit it elsewhere. */
export const USAGE_EVENT_NAME = "usage_event";

// --- usage_event sampling (free-tier budget) ---------------------------------
//
// WHY SAMPLE AT ALL. `usage_event` is one capture per request and ~99.7% of
// this project's PostHog volume: measured 2026-08-02, ~545K/day (16.4M/month)
// against a 1M/MONTH free tier. Exceeding the tier does not bill -- it DROPS
// events, and it drops them indiscriminately, which means an unsampled
// usage_event firehose would silently take `$exception` down with it. Sampling
// the firehose is what protects the error inbox.
//
// WHY NOT ONE FLAT RATE. The traffic shape is extreme: `block-detail` alone is
// 85.5% of all usage events (116,362 of 136,088 in a 6-hour window). A single
// rate low enough to fit the budget would leave the entire long tail
// statistically empty while that one route still dominated the sample. So the
// default rate governs the tail and a per-route map governs the head.
//
// WHY A MAP RATHER THAN A NAMED VAR PER ROUTE (the shape tracing.ts uses for
// its two surfaces): the hot route MOVES. It was
// /api/v1/internal/chain-firehose-ingest (#9005 excluded it), then
// `block-detail` (#9004). A JSON map keeps re-tuning a config change instead
// of a code change.
//
// WHAT IS NEVER SAMPLED, on purpose:
//   - FAILURES (`ok: false`). They are a rounding error by volume and the
//     entire point of the dataset when something breaks; dropping 80% of a
//     rare failure is how an incident becomes invisible.
//   - MCP tool calls (`mcpTool` set). Low-volume (~2K/day across every MCP
//     event) and the product's core signal -- ADR 0027's "does anyone actually
//     authenticate/call tools?" question cannot be answered from a sample.
//
// HOW TO COUNT SAMPLED DATA. Every capture that was subject to a rate below 1
// carries `sample_rate`, so the honest aggregate is a WEIGHTED one:
//     SELECT sum(1 / coalesce(toFloat(properties.sample_rate), 1)) ...
// rather than count(). Unsampled captures omit the property entirely (so the
// coalesce is what makes one query correct across both), which also keeps the
// payload and every pre-existing dashboard query unchanged when sampling is
// off.

/** Fallback sample rate for usage_event, as a wrangler var (e.g. "0.2"). */
export const POSTHOG_USAGE_SAMPLE_RATE_ENV = "POSTHOG_USAGE_SAMPLE_RATE";

/** Per-route overrides, a JSON object of route label -> rate (e.g.
 * `{"block-detail":0.01}`). Routes absent from the map use the default. */
export const POSTHOG_USAGE_SAMPLE_RATES_ENV = "POSTHOG_USAGE_SAMPLE_RATES";

// Unsampled by default, and deliberately so: a Math.random() gate cannot be
// no-op'd by isUsageTelemetryConfigured the way every other capture here can
// (that only checks for a token), so an on-by-default rate would make every
// existing test that mocks fetch with a real token and asserts an exact call
// count randomly flaky. Requiring an explicit rate keeps test call-count
// assertions deterministic by construction (no test sets these vars) while a
// real deployment sets them once, in wrangler.jsonc. Same reasoning, and the
// same default, as POSTHOG_TRACES_SAMPLE_RATE in src/tracing.ts.
const DEFAULT_USAGE_SAMPLE_RATE = 1;

// Single-entry memo of the parsed override map, keyed on the raw var text so
// it re-parses if the value ever differs -- a per-request JSON.parse at this
// module's call volume is pure waste.
//
// Registered with the module-state registry because this IS observable across
// test files under `isolate: false`, even though the memo returns the same
// answer for the same input: the malformed-map console.error below fires once
// per distinct raw value, so without a reset a second file's identical
// malformed map would stay silent and its assertion would fail depending on
// file order.
let usageSampleRatesRaw: string | undefined;
let usageSampleRatesParsed: Record<string, number> = {};

registerModuleStateReset("src/usage-telemetry.ts", () => {
  usageSampleRatesRaw = undefined;
  usageSampleRatesParsed = {};
  // The $exception storm guard's per-fingerprint window (declared below).
  // Without this a burst in one test file would throttle the first capture of
  // the next file, which is precisely the cross-file channel this registry
  // exists to close.
  exceptionThrottle.clear();
  // Same hazard, same reason, for the MCP refusal guard (#9639).
  mcpRefusalThrottle.clear();
});

function parseRate(value: unknown): number | undefined {
  // An empty or whitespace-only var is UNSET, not zero. Number("") is 0,
  // which is a perfectly valid rate meaning "sample nothing" -- so without
  // this guard, a var set to "" (a stray wrangler edit, a CI secret that
  // resolved to nothing) would silently take usage telemetry entirely dark
  // while every other signal looked healthy.
  if (typeof value === "string" && !value.trim()) return undefined;
  const rate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return undefined;
  return rate;
}

function usageSampleRatesByRoute(
  env: Env | null | undefined,
): Record<string, number> {
  const raw = env?.[POSTHOG_USAGE_SAMPLE_RATES_ENV];
  if (typeof raw !== "string" || !raw.trim()) return {};
  if (raw === usageSampleRatesRaw) return usageSampleRatesParsed;
  const parsed: Record<string, number> = {};
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [route, value] of Object.entries(map)) {
        const rate = parseRate(value);
        if (rate !== undefined) parsed[route] = rate;
      }
    }
  } catch {
    // A malformed map must never take telemetry (or the request) down: fall
    // back to the default rate for every route, and say so once per isolate.
    console.error(
      `[usage-telemetry] ${POSTHOG_USAGE_SAMPLE_RATES_ENV} is not valid JSON; using the default rate for every route`,
    );
  }
  usageSampleRatesRaw = raw;
  usageSampleRatesParsed = parsed;
  return parsed;
}

/**
 * Route-label namespace for the MCP protocol methods (`mcp:initialize`,
 * `mcp:ping`, `mcp:resources/read`, ...).
 *
 * Declared HERE and imported by the minting site
 * (scheduleMcpProtocolUsageEvent, src/mcp-server.ts) rather than written as a
 * literal in both: the sampling exemption below and the label that has to
 * match it are one decision, and a copy of the string in each file is a
 * silent divergence waiting to happen -- exactly the failure this exemption
 * is fixing, where the intent lived in one file and the implementation in
 * another.
 */
export const MCP_PROTOCOL_ROUTE_PREFIX = "mcp:";

/** The sample rate that applies to one usage event: 1 for anything never
 * sampled (failures, every MCP surface), otherwise the route override,
 * otherwise the deployment default. */
export function resolveUsageSampleRate(
  env: Env | null | undefined,
  event: UsageEvent,
): number {
  if (event.ok === false) return 1;
  if (sanitizeLabel(event.mcpTool) !== undefined) return 1;
  const route = sanitizeLabel(event.route);
  // The `mcpTool` check above exempts tools/call and nothing else, because
  // that is the only MCP event that carries a tool name. Every OTHER MCP
  // protocol method -- ping, resources/read, prompts/get, the notifications --
  // arrives here with `route: "mcp:<method>"` and no `mcpTool`, so it fell
  // through to the REST default and was sampled at 5%: 95% of the MCP
  // protocol surface dropped, by accident, while this module's own header
  // says MCP is "the product's core signal" and must not be sampled.
  //
  // The whole MCP surface is ~2K events/day against a REST firehose three
  // orders of magnitude larger, so exempting it costs nothing the sampling
  // was introduced to save.
  if (route !== undefined && route.startsWith(MCP_PROTOCOL_ROUTE_PREFIX)) {
    return 1;
  }
  if (route !== undefined) {
    const override = usageSampleRatesByRoute(env)[route];
    if (override !== undefined) return override;
  }
  return (
    parseRate(env?.[POSTHOG_USAGE_SAMPLE_RATE_ENV]) ?? DEFAULT_USAGE_SAMPLE_RATE
  );
}

// Cap free-form string fields so a buggy caller can't ship unbounded payloads.
const MAX_LABEL_CHARS = 256;

// Agent intent is prose, not an identifier, so it needs a ceiling of its own
// (#9642). MAX_LABEL_CHARS is sized for a tool or route name and would cut a
// real sentence mid-clause; this is long enough for the one-or-two-sentence
// answer the argument's description asks for, and short enough that an agent
// pasting an entire system prompt into it cannot ship that on every call.
const MAX_MCP_INTENT_CHARS = 1024;

/**
 * A trimmed string capped at `max`, or undefined when there is nothing to say.
 *
 * Separate from sanitizeLabel purely because the LIMIT differs -- the
 * empty/non-string/trim rules are identical, and duplicating them was the
 * alternative.
 */
function trimToLength(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// ─── deployment dimensions (environment / release) ──────────────────────────
//
// Every event this module emits was, until now, indistinguishable from every
// other deployment's: there was no environment and no version on the wire. Two
// concrete consequences, both observed in the live project:
//
//   1. A `wrangler dev` session on a developer's machine captures into the
//      SAME PostHog project as production. Error Tracking showed issues whose
//      stack frames resolve to `.wrangler/tmp/dev-*` paths inside a local
//      worktree, interleaved with real production faults and counted in the
//      same Issue. Nothing in the payload could separate them.
//   2. A regression could not be pinned to the deploy that introduced it,
//      which is exactly what $mcp_server_version already buys on the MCP
//      events -- the other surfaces simply never got the equivalent.
//
// CF_VERSION_METADATA is Cloudflare's own `version_metadata` binding (declared
// in wrangler.jsonc since the Worker was set up, and until now never read by
// anything). A real deployment always carries a version id; a local
// `wrangler dev` isolate has no deployed version to report. That asymmetry is
// the environment signal, so this needs no new var to configure and no
// per-deployment step someone can forget -- which a plain `vars` entry could
// not achieve anyway, since `wrangler dev` reads the same wrangler.jsonc and
// would inherit whatever it said.
//
// The failure mode if that asymmetry ever stops holding is deliberately
// benign: an event is labelled `production` when it wasn't, which is exactly
// the status quo this replaces -- never the reverse (a real production fault
// hidden under a `development` label).

/** PostHog property carrying which deployment emitted an event. */
export type DeploymentEnvironment = "production" | "development";

/**
 * Resolve the environment/release pair for this isolate. Never throws: an
 * absent or malformed binding degrades to `development` with no release,
 * because a telemetry dimension must never be the thing that breaks a request.
 *
 * Typed `Partial<WorkerVersionMetadata>` against Cloudflare's own generated
 * binding type (workers/worker-configuration.d.ts) rather than a hand-written
 * shape -- but PARTIAL, because the generated type describes the binding as it
 * exists on a real deployment, and the case this function exists to detect is
 * precisely the one where it does not.
 */
export function resolveDeployment(env: Env | null | undefined): {
  environment: DeploymentEnvironment;
  release?: string;
} {
  const metadata = (env as Record<string, unknown> | null | undefined)
    ?.CF_VERSION_METADATA as Partial<WorkerVersionMetadata> | undefined;
  const id = sanitizeLabel(metadata?.id);
  if (id === undefined) return { environment: "development" };
  // Prefer the human-meaningful tag when the deployment set one; the id is a
  // UUID and is always present, so it is the dependable fallback.
  const tag = sanitizeLabel(metadata?.tag);
  return { environment: "production", release: tag ?? id };
}

/** Stamp environment/release onto any outgoing property bag. Shared by every
 * recorder here so a breakdown behaves identically whichever event it starts
 * from -- the same discipline assignMcpAttribution already applies. */
function assignDeployment(
  properties: Record<string, unknown>,
  env: Env | null | undefined,
): void {
  const { environment, release } = resolveDeployment(env);
  properties.environment = environment;
  if (release !== undefined) {
    properties.release = release;
    // PostHog Error Tracking reads `$exception_releases` for its own
    // release-filtering UI; carrying both means the generic `release`
    // dimension works on usage/AI events too, from one resolution.
    properties.$exception_releases = [release];
  }
}

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
  /**
   * #8993: "anonymous", or the tier of a verified mg_ key, on the MCP protocol
   * paths (ADR 0027). Declared HERE and not only on McpToolCallEvent because
   * scheduleToolUsageEvent takes a loose Row -- an undeclared field typechecks
   * at every call site and is then silently dropped by the property assembly
   * below, which is the exact class of miss the repo has hit before.
   */
  authTier?: string;
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
  /** Injectable [0,1) source for the sampling gate (tests) -- keeps a
   * sampled deployment's behavior deterministic under assertion. */
  random?: () => number;
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

  const authTier = sanitizeLabel(event.authTier);
  if (authTier !== undefined) properties.auth_tier = authTier;

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

    // Sampling gate. Applied AFTER the shape validation above so a malformed
    // event is still reported as not-recorded for the same reason it always
    // was, never as "sampled out".
    const sampleRate = resolveUsageSampleRate(env, event);
    if (sampleRate < 1) {
      const random = deps.random ?? Math.random;
      if (random() >= sampleRate) return false;
      // The weight rides with the event so a count can be scaled back up --
      // see this module's sampling header for the weighted-aggregate query.
      properties.sample_rate = sampleRate;
    }

    // Applied after the sampling gate so a dropped event costs no work, and
    // outside usageEventProperties so that function stays a pure projection of
    // its UsageEvent argument (it is exported and asserted as one).
    assignDeployment(properties, env);

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
  return trimToLength(value, MAX_LABEL_CHARS);
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
  /**
   * The agent's own statement of WHY it made this call, taken from the
   * `context` argument (#9642). Emitted as $mcp_intent, which is what
   * PostHog's MCP Analytics intent view and clustering read.
   *
   * Free-form model output, so it is trimmed and hard-capped by the recorder
   * rather than trusted: this rides on an event that is never sampled, and an
   * agent that pastes a whole prompt into it would otherwise ship that
   * verbatim on every call.
   */
  intent?: string;
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
  /**
   * #8994: where clientName came from. Optional and usually omitted -- the
   * handshake's own clientInfo is the normal case and the recorder defaults to
   * `client_info`. Supplied explicitly when initialize falls back to the
   * User-Agent for a client that sent no clientInfo, so a transport-level
   * guess is never recorded as an MCP-declared identity.
   */
  clientNameSource?: McpClientNameSource;
  /**
   * The session id this initialize is CREATING (#8994), not the one it arrived
   * with -- a canonical initialize arrives with none, which is why this was
   * null on every one of them before.
   */
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

    // Agent intent (#9642). NOT sanitizeLabel: that caps at MAX_LABEL_CHARS,
    // which is sized for identifiers like a tool or route name, and would
    // truncate a real sentence into uselessness. This is meant to be prose,
    // so it gets its own, longer ceiling -- but a ceiling all the same,
    // because it is model output on an unsampled event.
    //
    // $mcp_intent_source is part of the wire contract rather than decoration:
    // PostHog distinguishes an intent the agent actually stated
    // ("context_parameter") from one a server inferred on its behalf
    // ("inferred"). We only ever emit the former, and saying so explicitly is
    // what stops a future inference fallback from being read as agent speech.
    const intent = trimToLength(event.intent, MAX_MCP_INTENT_CHARS);
    if (intent !== undefined) {
      properties["$mcp_intent"] = intent;
      properties["$mcp_intent_source"] = "context_parameter";
    }

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

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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

    // clientInfo from the handshake itself is authoritative when the client
    // sent one -- but #8994 lets initialize fall back to the User-Agent-derived
    // name for a client that omits clientInfo, and that name must NOT be
    // labelled client_info. An explicit source wins; the client_info default
    // applies only when the caller did not say.
    assignMcpAttribution(properties, {
      ...event,
      clientNameSource:
        event.clientNameSource ??
        (event.clientName ? "client_info" : undefined),
    });

    if (typeof event.sessionId === "string" && event.sessionId.trim()) {
      properties["$session_id"] = event.sessionId.trim();
    }

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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

// Error tracking via PostHog's `$exception` capture (#7758).
//
// The exception SHAPE is built by @posthog/core's own ErrorPropertiesBuilder
// (#9068) rather than by hand. It was hand-written for as long as the bundle
// budget claimed a 1 MiB ceiling; #9060 established the real ceiling is 10 MB
// on Workers Paid, and with that gone there is no reason to keep a private
// copy of a shaper the ecosystem maintains. What the library does that the
// hand-written version did not:
//
//   - attaches chunk_id PER FILENAME via getFilenameToChunkIdMap; ours only
//     worked when exactly one distinct chunk registered itself and gave up
//     entirely under code splitting,
//   - emits `platform: "node:javascript"` from the parser, so the field that
//     took months to get right (#9045) can no longer drift,
//   - walks `{ cause }` chains, which we dropped on the floor entirely,
//   - coerces non-Error throws (string, object, DOMException, ErrorEvent)
//     instead of collapsing them through String(),
//   - carries Sentry's hardened frame parsing/reversal/limits upstream.
//
// The TRANSPORT deliberately stays ours: one fetch per event. posthog-node's
// client batches on a flush interval for a long-lived Node process, and a
// Workers isolate can be evicted between requests, so a batched event is a
// dropped event. We adopt the library's shaping, not its client lifecycle.

// Immutable: coercer set and parser never vary per call, so build once per
// isolate rather than per exception.
const EXCEPTION_STACK_PARSER = ErrorTracking.createStackParser(
  "node:javascript",
  ErrorTracking.nodeStackLineParser,
);
const EXCEPTION_PROPERTIES_BUILDER = new ErrorTracking.ErrorPropertiesBuilder(
  [
    new ErrorTracking.ErrorCoercer(),
    new ErrorTracking.StringCoercer(),
    new ErrorTracking.ObjectCoercer(),
    new ErrorTracking.PrimitiveCoercer(),
  ],
  EXCEPTION_STACK_PARSER,
);

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
  /**
   * Which query a query-engine capture site was running when it failed.
   *
   * `queryKind` is the coarse, bounded bucket you filter an inbox by (a
   * lakehouse table, e.g. `chain.account_events`); `queryShape` is the
   * statement itself with its literals collapsed, which names the exact call
   * site. Both are OPTIONAL and omitted-not-defaulted, so no existing capture
   * site's payload changes.
   *
   * Both are deliberately kept OUT of the fingerprint — see the note in
   * recordExceptionEvent for why that is a cost decision, not a style one.
   */
  queryKind?: string;
  queryShape?: string;
}

// ─── $exception storm guard ────────────────────────────────────────────────
//
// One fault in a hot path can spend a MONTH of quota in a day, and this
// project has already had it happen: a single Issue
// (`wallet-auth-keys:PostgresError`, "relation api_key_usage_daily does not
// exist") captured 871,649 events over four days -- one per request against a
// dropped table -- while the free tier is 1M events/MONTH. Because PostHog
// drops events indiscriminately once quota is exhausted, an $exception storm
// does not merely cost money: it takes down the error inbox and the alerts
// that exist to report the very outage causing it. Sampling protects
// `usage_event` (see this module's sampling header) and deliberately never
// touches failures -- so nothing at all stood in front of this.
//
// A recurring fault needs to be REPORTED, not COUNTED. One occurrence per
// fingerprint per window carries the same diagnosis (same type, same message,
// same stack) as a hundred thousand, so this throttles per fingerprint and
// carries the suppressed count on the next event that gets through. That
// preserves the volume signal -- which is what a storm guard that merely
// dropped would destroy -- while capping the cost at one event per
// fingerprint per window.
//
// Deliberately a TIME window rather than data-api's permanent per-isolate set
// (shouldSkipDriftCapture, workers/data-api.ts): schema drift is a fixed
// condition where the second occurrence genuinely adds nothing for the life of
// the isolate, whereas a general fault can stop and restart, and a permanent
// suppression would hide the restart forever. Same shape and reasoning as
// shouldEmitCondition in workers/wss-lb.ts, which throttles its availability
// events on exactly this model.
//
// OFF UNLESS EXPLICITLY CONFIGURED, for exactly the reason
// POSTHOG_USAGE_SAMPLE_RATE and POSTHOG_TRACES_SAMPLE_RATE are (see their own
// comments above and in src/tracing.ts): a guard that silently drops the
// second capture of a fingerprint cannot be no-op'd by
// isUsageTelemetryConfigured the way every other behavior here can, so an
// on-by-default window would change the observed call count of any test that
// captures the same route+type twice with a real token -- 13 of them in the
// existing suite the moment this was tried on-by-default. Requiring an
// explicit window keeps every call-count assertion deterministic by
// construction (no test sets this var) while the deployed Worker sets it once,
// in wrangler.jsonc, where the storm this exists to stop actually happens.

/** Per-fingerprint $exception throttle window in ms, as a wrangler var (e.g.
 * "60000"). Unset or 0 disables the guard entirely. */
export const POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV =
  "POSTHOG_EXCEPTION_STORM_WINDOW_MS";

// The var's contract as a schema rather than a typeof/Number/isFinite ladder:
// wrangler vars arrive as strings, every invalid shape means the same thing
// (guard off), and `.catch` states that once instead of at each branch. 0 is
// the disabled sentinel, so an absent, blank, malformed, zero or negative
// value all converge on it by construction.
const ExceptionStormWindowSchema = z.coerce
  .number()
  .finite()
  .positive()
  .catch(0);

function exceptionStormWindowMs(env: Env | null | undefined): number {
  const raw = env?.[POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV as keyof Env];
  // z.coerce.number() maps "" and null to 0, which .positive() then rejects
  // into the same disabled sentinel -- but undefined coerces to NaN, so the
  // schema covers every case without a pre-check.
  return ExceptionStormWindowSchema.parse(raw);
}

interface ExceptionThrottleState {
  windowStartedAtMs: number;
  suppressed: number;
}

// Reset alongside the sample-rate memo below, under this module's single
// registry key -- the validator keys on the module path, so one module
// registers one reset covering all of its state.
const exceptionThrottle = new Map<string, ExceptionThrottleState>();

/**
 * Decide whether this fingerprint may emit now. Returns the number of
 * occurrences suppressed since the last emission when it may (0 when this is
 * the first sighting), or null when it must be throttled.
 *
 * Exported for tests: the branch that suppresses a storm is the entire point
 * of this code, and recordExceptionEvent is a no-op without a token, so
 * "was it throttled" is otherwise indistinguishable from "was it a no-op".
 * Same reasoning as captureDataApiError's boolean return.
 */
export function admitExceptionCapture(
  env: Env | null | undefined,
  fingerprint: string,
  nowMs: number = Date.now(),
): number | null {
  const windowMs = exceptionStormWindowMs(env);
  if (windowMs === 0) return 0;
  const state = exceptionThrottle.get(fingerprint);
  if (state === undefined || nowMs - state.windowStartedAtMs >= windowMs) {
    exceptionThrottle.set(fingerprint, {
      windowStartedAtMs: nowMs,
      suppressed: 0,
    });
    return state?.suppressed ?? 0;
  }
  state.suppressed += 1;
  return null;
}

// The MCP pre-dispatch refusal guard (#9639). Its own map, not a shared
// namespace on exceptionThrottle: these are analytics `usage_event`s, not
// $exception captures, and a burst of one must never consume the other's
// window. It reuses exceptionStormWindowMs deliberately -- the question
// ("how often may one repeating signal speak") is identical, and a second
// knob would be one more thing to set correctly on four wrangler configs.
const mcpRefusalThrottle = new Map<string, ExceptionThrottleState>();

/**
 * Decide whether this MCP refusal reason may emit now. Same contract as
 * admitExceptionCapture: the number of occurrences suppressed since the last
 * emission when it may (0 on first sighting), or null when it must be held.
 *
 * WHY A REFUSAL NEEDS A GUARD AT ALL. resolveUsageSampleRate returns 1 for
 * `ok: false` AND for the `mcp:` route prefix, so a refusal event is
 * unsampled twice over -- correct for a signal that should never be lost, and
 * a quota hazard for one a single caller can generate without bound. A client
 * hammering the rate limiter produces one refusal per request; that is the
 * shape that spent a month's event budget in two days. One event per reason
 * per window, carrying the suppressed count, keeps the signal and drops the
 * storm.
 */
export function admitMcpRefusalCapture(
  env: Env | null | undefined,
  reason: string,
  nowMs: number = Date.now(),
): number | null {
  const windowMs = exceptionStormWindowMs(env);
  if (windowMs === 0) return 0;
  const state = mcpRefusalThrottle.get(reason);
  if (state === undefined || nowMs - state.windowStartedAtMs >= windowMs) {
    mcpRefusalThrottle.set(reason, {
      windowStartedAtMs: nowMs,
      suppressed: 0,
    });
    return state?.suppressed ?? 0;
  }
  state.suppressed += 1;
  return null;
}

/**
 * Collapse volatile identifiers in an exception message so PostHog's Error
 * Tracking groups occurrences of the SAME fault into one Issue.
 *
 * #9019: PostHog groups Issues by the message, not by our
 * $exception_fingerprint (which is already correctly bucketed -- one
 * fingerprint, many payloads). Hyperdrive names each pooled connection in its
 * error text:
 *
 *   write CONNECTION_CLOSED 1f462de30803897f4c87cfe341e93970.hyperdrive.local:5432
 *   write CONNECTION_CLOSED 5c01896f5cccb129888261dcc240daee.hyperdrive.local:5432
 *
 * so every dropped connection minted a new Issue, most with one occurrence,
 * burying the ones that matter. Same "one issue per occurrence" pathology
 * #9001 removed from our own route labels, arriving through a different door.
 *
 * NARROW, NAMED PATTERNS ONLY -- deliberately not a blanket hex-strip. A
 * message like `relation "api_usage_rollup" does not exist` must survive
 * verbatim: the identifier IS the diagnostic content there, and normalizing it
 * would have merged the five distinct drifted objects of #8960 into one
 * indistinguishable Issue. The test asserts that directly.
 *
 * Lossless in the only sense that matters: a Hyperdrive connection id is a
 * per-connection handle that never recurs, so nothing is diagnosable from it.
 */
export function normalizeExceptionMessage(message: string): string {
  return message.replace(
    /\b[0-9a-f]{16,}\.hyperdrive\.local\b/gi,
    "<connection>.hyperdrive.local",
  );
}

function exceptionListEntry(error: unknown): {
  type: string;
  entry: Record<string, unknown>;
} {
  const built = EXCEPTION_PROPERTIES_BUILDER.buildFromUnknown(error, {
    // Every capture site wraps a genuinely caught (try/catch), non-fatal
    // fault -- never an uncaught/fatal one. Since #7766 removed Sentry's
    // automatic withSentry() wrap, a truly uncaught throw has no dedicated
    // $exception capture of its own; it still surfaces as an ok:false usage
    // event (and trace span, if sampled) via withUsageTelemetry's finally
    // block in workers/api.ts, just without a stack trace.
    mechanism: { handled: true, type: "generic" },
  });
  const entry = (built.$exception_list?.[0] ?? {}) as Record<string, unknown>;
  const type = sanitizeLabel(entry.type) ?? "Error";
  // Two things stay OURS on top of the library's shape, because neither is a
  // reimplementation of anything it provides: the Hyperdrive-host collapse
  // that keeps one logical fault from splitting into an Issue per connection
  // (normalizeExceptionMessage), and the label cap every free-form field in
  // this module gets.
  const rawValue =
    typeof entry.value === "string" ? entry.value : String(entry.value ?? "");
  const value =
    sanitizeLabel(normalizeExceptionMessage(rawValue)) ?? "(no message)";
  return { type, entry: { ...entry, type, value } };
}

/**
 * Platform lifecycle messages that are NOT faults, and must never spend
 * error-tracking quota or land in the error inbox.
 *
 * "Durable Object reset because its code was updated" is the runtime telling
 * us a deploy landed while a DO was live. It is expected on EVERY deploy,
 * self-heals (the alarm/request simply re-runs), and there is no action a
 * reader could take. workers/api.ts's firehose-ingest handler already
 * documents it as "expected/occasional, not a real fault" and swallows it at
 * that one call site -- but the DOs' own alarm loops capture it too, and
 * their per-isolate change-detectors (e.g. ChainFirehoseHub's
 * lastCapturedHeadPollerError) are defeated by construction here: the reset
 * WIPES the isolate holding the memo, so the next occurrence always looks
 * new. That is why this needs to be central rather than another local guard
 * -- all four DOs (chain-firehose, mcp-session, subnet-status, alerter) can
 * raise it, and a deploy-heavy day captured 43 of them.
 *
 * Deliberately an exact-prefix list of runtime-owned strings, not a fuzzy
 * "looks benign" heuristic: anything broader would eventually swallow a real
 * fault, which is the failure mode that actually costs debugging time.
 */
const BENIGN_PLATFORM_MESSAGE_PREFIXES = [
  "Durable Object reset because its code was updated",
] as const;

/** Exported for tests: a suppressed capture is otherwise indistinguishable
 * from the unconfigured no-op, the same reasoning as admitExceptionCapture. */
export function isBenignPlatformMessage(message: string): boolean {
  return BENIGN_PLATFORM_MESSAGE_PREFIXES.some((prefix) =>
    message.startsWith(prefix),
  );
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
    // Before the storm guard, not after: a benign platform message must never
    // consume a fingerprint's window either, or a deploy-time reset would
    // suppress the NEXT genuine fault on that same route for a full window.
    if (
      typeof entry.value === "string" &&
      isBenignPlatformMessage(entry.value)
    ) {
      return false;
    }
    const route = sanitizeLabel(event.route);
    const mcpTool = sanitizeLabel(event.mcpTool);
    // A stable string groups every occurrence of "this site threw this
    // error type" into one PostHog issue -- matching the route/mcp_tool
    // tag Sentry already gets at these sites, so the two dashboards read
    // consistently. Falls back to "unknown" only if neither is supplied.
    const fingerprint = `${route ?? mcpTool ?? "unknown"}:${type}`;

    // Throttled on the same key PostHog groups by, so a storm of one fault
    // costs one event per window while a genuinely new fault is never delayed.
    const suppressed = admitExceptionCapture(env, fingerprint);
    if (suppressed === null) return false;

    const properties: Record<string, unknown> = {
      $exception_list: [entry],
      $exception_fingerprint: fingerprint,
    };
    // Only on the events that follow a throttled burst, so the ordinary case
    // keeps its exact existing payload and every pre-existing query is
    // unaffected -- the same "omitted, not defaulted" contract as sample_rate.
    if (suppressed > 0) properties.suppressed_occurrences = suppressed;
    if (route !== undefined) properties.route = route;
    if (mcpTool !== undefined) properties.mcp_tool = mcpTool;
    const errorCode = sanitizeLabel(event.errorCode);
    if (errorCode !== undefined) properties.error_code = errorCode;
    // Query attribution rides along as PROPERTIES, never as fingerprint input.
    //
    // #9459: `route: "r2-sql"` collapses a timeout, a 429, a 422 scan-budget
    // rejection and a 400 into one issue, so the inbox cannot say which query
    // is slow. The obvious fix -- fold the answer into the fingerprint -- is
    // the expensive one, because the storm guard above windows PER
    // FINGERPRINT: one fingerprint at one event per window becomes N
    // fingerprints at one event per window EACH, i.e. N times the billable
    // volume, against the tightest budget this project has (~90K/month of a
    // 100K free tier before the current fixes).
    //
    // A property costs bytes on an event that is already being sent, and
    // PostHog groups Issues on $exception_fingerprint (set explicitly above),
    // so occurrences stay in ONE issue while every sampled event names the
    // query that produced it. Attribution without volume.
    const queryKind = sanitizeLabel(event.queryKind);
    if (queryKind !== undefined) properties.query_kind = queryKind;
    const queryShape = sanitizeLabel(event.queryShape);
    if (queryShape !== undefined) properties.query_shape = queryShape;
    assignDeployment(properties, env);

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

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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

    // The deployment dimensions, stamped exactly where this family already
    // stamps its attribution -- see assignMcpAttribution above.
    assignDeployment(properties, env);
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
