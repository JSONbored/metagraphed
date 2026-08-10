// Minimal OTLP/HTTP JSON distributed-tracing emission for PostHog (#7768).
// PostHog's distributed tracing (alpha as of 2026-07, posthog.com/docs/
// distributed-tracing) is "a generic OTLP receiver ... standard OpenTelemetry
// SDKs, no PostHog packages required" -- so this hand-builds the OTLP/HTTP
// JSON encoding (a stable, documented OpenTelemetry wire format, not a
// PostHog-specific one) instead of importing @opentelemetry/sdk-node, which
// was never designed for a stateless per-request Workers isolate and costs
// real bundle weight for batching/queueing machinery a fire-and-forget model
// doesn't need -- same "no SDK bloat in Workers" reasoning as
// usage-telemetry.ts's own header comment.
//
// Deliberately alpha, adopted anyway: PostHog's stated roadmap was
// Logs -> Tracing -> APM, and #7768 originally deferred this pending GA. The
// explicit call (metagraphed#7757 epic) is that a working alpha beats the
// zero span visibility this repo would otherwise have after Sentry's
// removal -- revisit the design (real W3C traceparent propagation, nested
// spans) once PostHog's tracing matures, but ship real signal now.
//
// Scope: replaces @sentry/cloudflare's automatic withSentry() HTTP
// instrumentation (one transaction per request, tracesSampleRate: 0.05) and
// the per-tool Sentry.startSpan in src/mcp-server.ts (#7152). Each traced
// operation here is an INDEPENDENT single-span trace (its own traceId, no
// parent) rather than a nested tree under one request-wide trace -- Sentry's
// nesting was free (its SDK propagates an active span via AsyncLocalStorage
// automatically); reproducing that here would mean threading a trace
// context by hand through every layer between a Worker's fetch entry and
// src/mcp-server.ts's tool dispatch. Every span still carries the same
// route/mcp_tool/ok attributes usage_event/$exception already use, so
// PostHog's trace list is fully filterable/groupable by those dimensions
// even without parent/child nesting.

import {
  admitExceptionCapture,
  admitExceptionCaptureShared,
  isUsageTelemetryConfigured,
  resolvePostHogHost,
} from "./usage-telemetry.ts";

export const POSTHOG_TRACES_PATH = "/i/v1/traces";

/** Explicit per-deployment opt-in (wrangler var, e.g. "0.05" to match
 * Sentry's old tracesSampleRate) -- defaults to 0 (off), NOT Sentry's prior
 * rate. A random Math.random()-based sample gate can't be no-op'd by
 * isUsageTelemetryConfigured the way every other capture in this module can
 * (that only checks for a token), so an on-by-default rate would make any
 * existing test that mocks globalThis.fetch with a real POSTHOG_PROJECT_TOKEN
 * and asserts an exact call count randomly flaky (~5% of runs) the moment
 * tracing gets wired into that Worker's fetch entry -- confirmed the hard
 * way against tests/registry-sync-api.test.ts. Requiring an explicit rate
 * keeps every test call-count assertion deterministic by construction (no
 * test sets this var), while a real deployment sets it once, deliberately. */
export const POSTHOG_TRACES_SAMPLE_RATE_ENV = "POSTHOG_TRACES_SAMPLE_RATE";

/**
 * #9000: a PER-SURFACE override, because one global rate cannot fit this
 * project's traffic shape.
 *
 * Tracing has been wired into four Workers since #7768 and has emitted ZERO
 * spans in 30 days -- the rate defaults to 0 and was set in no wrangler
 * config. The obvious fix (set a global rate) is wrong here, and the
 * arithmetic is why:
 *
 *   REST  ~1.1M requests/day  -> even 1% is 11K spans/day, 330K/month
 *   MCP   ~1.9K tool calls/day -> 100% is ~1.9K spans/day, ~56K/month
 *
 * against a PostHog FREE tier of 1M events/month, which the project is
 * already ~33x over on events alone (#9004). A global rate high enough to be
 * useful on MCP would be ruinous on REST; a global rate safe on REST rounds
 * to no MCP spans at all.
 *
 * So the surfaces are separated. MCP -- the priority surface, and the cheap
 * one -- can run at a rate that actually answers questions, while REST stays
 * dark until its volume is dealt with. Turning REST on later is a config
 * change, not a code change.
 *
 * #9466: two of those four Workers now do set the general rate, in their own
 * configs -- data-api at 0.01 and registry-sync-api at 1. The "set in no
 * wrangler config" state above was per-config all along: wrangler.jsonc
 * configures only the main Worker, so a rate omitted there is omitted for
 * api.ts, not globally. api.ts REST remains at 0 on its own volume.
 */
export const POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV =
  "POSTHOG_TRACES_SAMPLE_RATE_MCP";

const DEFAULT_TRACES_SAMPLE_RATE = 0;

function readRate(env: Env | null | undefined, key: string): number | null {
  const value = env?.[key as keyof Env];
  // Absent is different from invalid: absent falls through to the general
  // rate, invalid falls back to the default. Coercing an unset key with
  // Number() gives NaN, which is indistinguishable from a typo'd value.
  if (value === undefined || value === null || value === "") return null;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/**
 * The sample rate for a surface. `surface` "mcp" consults the MCP-specific
 * rate first and falls back to the general one, so a deployment that sets only
 * the general rate keeps its previous behaviour exactly.
 */
export function tracesSampleRate(
  env: Env | null | undefined,
  surface?: "mcp",
): number {
  if (surface === "mcp") {
    const mcp = readRate(env, POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV);
    if (mcp !== null) return mcp;
  }
  return (
    readRate(env, POSTHOG_TRACES_SAMPLE_RATE_ENV) ?? DEFAULT_TRACES_SAMPLE_RATE
  );
}

/** Sampling decision only -- callers still gate on isUsageTelemetryConfigured
 * separately (no point rolling dice on a deployment with no PostHog token). */
export function shouldSampleTrace(
  env: Env | null | undefined,
  surface?: "mcp",
): boolean {
  return Math.random() < tracesSampleRate(env, surface);
}

/**
 * Internal machine-to-machine plumbing, excluded from SUCCESS spans exactly
 * as workers/api.ts's usageRouteLabel excludes it from usage events (#9005).
 *
 * Measured 2026-08-10: `/api/v1/internal/usage-rollup` was 2,657 of the
 * data-api Worker's ~2,900 spans over 2.6 days -- 92% of that Worker's entire
 * trace volume, and ~32K spans/month, for a route no customer calls and
 * nobody reads a latency percentile for. #9005 drew this exact line for the
 * usage lane ("internal machine-to-machine plumbing is not API usage by
 * anyone") and the trace lane simply never got it.
 *
 * FAILURES ARE UNAFFECTED, deliberately, and for #9005's own stated reason:
 * "a failing internal ingest must stay visible". This suppresses the
 * successful-timing span, not the error span -- shouldRecordTraceSpan only
 * consults it on the `ok` branch.
 */
export function isUntracedInternalRoute(name: string): boolean {
  return name.startsWith("/api/v1/internal/");
}

/** Namespaces the trace lane's storm keys away from $exception's, so a route
 * that both throws and emits a failed span cannot silence one via the other.
 */
export const TRACE_STORM_FINGERPRINT_PREFIX = "trace:";

/**
 * Outcome-aware span admission: a FAILURE is never sampled away, a success
 * rolls the surface's dice.
 *
 * WHY THE FLAT DICE WAS WRONG. shouldSampleTrace is a bare
 * `Math.random() < rate` gate with no notion of how the operation ENDED, so a
 * 1% rate discards 99% of failures as surely as it discards 99% of successes.
 * That is the opposite of the same decision one module over:
 * usage-telemetry.ts's resolveUsageSampleRate returns 1 for `ok: false`
 * because failures "are a rounding error by volume and the entire point of
 * the dataset when something breaks; dropping 80% of a rare failure is how an
 * incident becomes invisible". Tracing never got that rule, so the two lanes
 * disagreed about the same request.
 *
 * WHY THIS IS ALSO THE CHEAPER GATE. Measured 2026-08-10, spans bill against
 * PostHog's AI Observability allocation (100K events/month free), NOT the 1M
 * product-analytics one that wrangler.data.jsonc's rate arithmetic was sized
 * against -- a 10x budgeting error that put the project at ~112K spans/month
 * against a 100K tier. Successes are the entire overage; failures are a
 * rounding error. Biasing the sample toward the failures buys back the tier
 * AND raises error fidelity to 1.0 at the same time.
 *
 * WHY "NEVER SAMPLED" STILL NEEDS A CEILING. An unsampled failure stream is
 * precisely the shape admitMcpRefusalCapture exists to contain: "a client
 * hammering the rate limiter produces one refusal per request; that is the
 * shape that spent a month's event budget in two days". So `ok: false` is
 * admitted here and then BOUNDED in recordTraceSpan by the same two-tier
 * storm guard $exception uses -- this function returning true is permission
 * to try, not a promise to emit.
 */
export function shouldRecordTraceSpan(
  env: Env | null | undefined,
  span: { name: string; ok: boolean; surface?: "mcp" },
): boolean {
  if (!span.ok) return true;
  if (isUntracedInternalRoute(span.name)) return false;
  return shouldSampleTrace(env, span.surface);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 16-byte (32 hex char) OTLP trace ID. */
export function newTraceId(): string {
  return randomHex(16);
}

/** 8-byte (16 hex char) OTLP span ID. */
export function newSpanId(): string {
  return randomHex(8);
}

type SpanAttributeValue = string | number | boolean;

export interface TraceSpanInput {
  traceId: string;
  spanId: string;
  /** Human-readable operation name (mirrors Sentry's span `name`, e.g.
   * "mcp.tool/get_subnet" or "GET /api/v1/subnets"). */
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  ok: boolean;
  /** OTLP resource attribute identifying which Worker emitted this span. */
  serviceName: string;
  attributes?: Record<string, SpanAttributeValue | undefined>;
}

function otlpAttributeValue(value: SpanAttributeValue) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

function otlpAttributes(
  attrs: Record<string, SpanAttributeValue | undefined> | undefined,
): Array<{ key: string; value: unknown }> {
  if (!attrs) return [];
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out.push({ key, value: otlpAttributeValue(value) });
  }
  return out;
}

// OTLP timestamps are unix nanoseconds, transported as a decimal string
// (protobuf uint64 has no safe native JS number representation). Workers'
// Date.now()-based millisecond timestamps only need *1e6 zero-padding, not
// real sub-ms precision -- nothing in this pipeline measures finer than ms.
function unixNanosFromMs(ms: number): string {
  return `${BigInt(Math.max(0, Math.round(ms)))}000000`;
}

const OTLP_SPAN_KIND_SERVER = 2;
const OTLP_STATUS_CODE_OK = 1;
const OTLP_STATUS_CODE_ERROR = 2;

export function otlpTraceExportRequest(span: TraceSpanInput) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttributes({ "service.name": span.serviceName }),
        },
        scopeSpans: [
          {
            scope: { name: "metagraphed" },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                kind: OTLP_SPAN_KIND_SERVER,
                startTimeUnixNano: unixNanosFromMs(span.startTimeMs),
                endTimeUnixNano: unixNanosFromMs(span.endTimeMs),
                attributes: otlpAttributes(span.attributes),
                status: {
                  code: span.ok ? OTLP_STATUS_CODE_OK : OTLP_STATUS_CODE_ERROR,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface RecordTraceSpanDeps {
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  /** Injectable cross-isolate storm gate, mirroring RecordUsageEventDeps --
   * "was it held by the FLEET-wide gate" is otherwise indistinguishable from
   * "was it held locally", and that distinction is the whole point. */
  admitShared?: typeof admitExceptionCaptureShared;
}

/**
 * Emit one already-completed span to PostHog's OTLP/HTTP traces endpoint.
 * Same no-throw, no-op-when-unconfigured contract as usage-telemetry.ts's
 * recordUsageEvent -- callers schedule the returned promise via
 * ctx.waitUntil(...), never await it on the response path.
 */
export async function recordTraceSpan(
  env: Env | null | undefined,
  span: TraceSpanInput,
  deps: RecordTraceSpanDeps = {},
): Promise<boolean> {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    // The ceiling shouldRecordTraceSpan defers to. Only failures reach it:
    // successes were already thinned by the sample rate, and throttling them
    // on top would bias the latency percentiles toward whichever route
    // happened to win a window.
    //
    // TWO GATES, IN THIS ORDER, copied from recordExceptionEvent (#9900). The
    // local map is a no-I/O fast path; the shared gate is the one that
    // actually bounds a fleet-wide storm, because the local map is
    // per-isolate and a recycled isolate always looks like a first sighting.
    // Local first so a burst inside one isolate never reaches KV at all.
    if (!span.ok) {
      const fingerprint = `${TRACE_STORM_FINGERPRINT_PREFIX}${span.name}`;
      if (admitExceptionCapture(env, fingerprint) === null) return false;
      const admitShared = deps.admitShared ?? admitExceptionCaptureShared;
      if ((await admitShared(env, fingerprint)) === null) return false;
    }

    const token = String(
      (env as Record<string, unknown> | null | undefined)
        ?.POSTHOG_PROJECT_TOKEN,
    ).trim();
    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_TRACES_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(otlpTraceExportRequest(span)),
      },
    );
    return response?.ok === true;
  } catch {
    // Telemetry must never surface into the request/tool path.
    return false;
  }
}

export interface SpanTimingResult<T> {
  value: T;
  startedAt: number;
  endedAt: number;
  ok: boolean;
}

/**
 * Time an async operation, capturing success/failure without swallowing a
 * thrown error -- callers get the same control flow as calling `fn()`
 * directly (the promise rejects exactly when `fn()` would), plus the timing
 * needed to build a TraceSpanInput. Mirrors Sentry.startSpan's ergonomics
 * (wrap-a-callback) without needing an active-span context stack.
 */
export async function timedSpan<T>(
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T; startedAt: number; endedAt: number }
  | { ok: false; error: unknown; startedAt: number; endedAt: number }
> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, startedAt, endedAt: Date.now() };
  } catch (error) {
    return { ok: false, error, startedAt, endedAt: Date.now() };
  }
}
