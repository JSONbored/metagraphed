import { registerModuleStateReset } from "../src/module-state-registry.ts";
import {
  withRequestTiming,
  serverTimingHeader,
} from "../src/request-timing.ts";
import { degradedSnapshot, labelDegradedResponse } from "./edge-cache.ts";
// Request telemetry and response auditing, shared with the small directory entry.
import {
  isUsageTelemetryConfigured,
  recordExceptionEvent,
  recordUsageEvent,
  parseUserAgentClient,
  statusClassOf,
  anonymousUsageDistinctId,
  sanitizeUsageLabel,
  USAGE_ACCOUNT_NAMESPACE,
  USAGE_WORKER_NAMESPACE,
  type UsageEvent,
} from "../src/usage-telemetry.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldRecordTraceSpan,
} from "../src/tracing.ts";
import { errorResponse } from "./http.ts";
import {
  ResponseSchemaDriftError,
  validateResponseTripwire,
} from "../src/response-validation-tripwire.ts";
import { urlProjects } from "../src/projection-signal.ts";
import { ANONYMOUS_CLIENT_KEY, resolveClientIp } from "./config.ts";
type Ctx = { waitUntil?: (promise: Promise<unknown>) => void };
export interface AuditRoute {
  id: string;
  artifactTemplate?: string;
  artifactPath?: string;
}
// #9446: the caller's tier, for the usage_event `auth_tier` dimension.
//
// `authTier` has been declared on UsageEvent since #8993 and populated ONLY on
// the MCP path, so on REST -- the surface with 99% of the traffic -- the
// question the tier system exists to answer ("what share of usage is
// authenticated, and on which tier") had no data behind it at all.
//
// A WeakMap keyed on the Request, rather than a new parameter threaded from
// four gate sites up through handleRequest to this wrapper. The gate already
// resolves the tier (applyTieredRateLimit returns it and every caller
// discarded it); this carries that answer back out without reshaping the
// signature of every function in between, which is the same reasoning the MCP
// side used when it put authTier on its ctx rather than passing it down.
//
// WeakMap and not a Map: the key is the request object itself, so an entry
// becomes collectable the moment the request is done. There is nothing to
// evict, nothing to size, and no way for one request's tier to be read by
// another -- the failure mode a keyed cache would have.
let requestAuthTier = new WeakMap<Request, string>();

/**
 * The account a request authenticated as, for its usage-event distinct_id.
 *
 * A SECOND WeakMap rather than widening the one above to an object: the tier
 * is set by every gate and the account only by a key-verified one, so a single
 * entry would have to encode "tier known, account not" as a partial object at
 * every call site. Two maps say that by which one has an entry, and both stay
 * collectable with the request for the reasons the tier map already documents.
 */
let requestAccountId = new WeakMap<Request, string>();

/**
 * An error code resolved somewhere the RESPONSE cannot carry it.
 *
 * `withUsageTelemetry` reads `error_code` off the response header, which works
 * for every route that answers through `errorResponse`. It cannot work for a
 * refusal whose whole design is that the response says nothing distinguishing
 * -- the chain-firehose caps (#10606), where telling the caller which limit it
 * hit tells a scraper whether to rotate addresses. Same WeakMap-on-the-Request
 * shape as the tier above, and the same collectability argument.
 */
let requestErrorCode = new WeakMap<Request, string>();

/** Record an error code the response is deliberately not allowed to carry. */
export function markRequestErrorCode(request: Request, code: unknown): void {
  if (typeof code === "string" && code) requestErrorCode.set(request, code);
}

/**
 * Record the tier a request authenticated on, for its usage event.
 *
 * Called from the tiered-rate-limit gates, which are the only places that
 * verify a key. Exported for tests.
 *
 * `accountId` is optional so the pre-#10606 two-argument form still compiles
 * and still means what it did -- a gate that resolves no account passes
 * nothing, and the caller stays anonymous rather than being attributed to an
 * account it never presented.
 */
export function markRequestAuthTier(
  request: Request,
  tier: unknown,
  accountId?: unknown,
): void {
  if (typeof tier === "string" && tier) requestAuthTier.set(request, tier);
  if (typeof accountId === "string" && accountId) {
    requestAccountId.set(request, accountId);
  }
}

/**
 * Who to count this request under, for the usage event's distinct_id.
 *
 * ## WHY REST HAD NO ANSWER TO THIS
 *
 * Every REST usage event carried the same literal id, so `uniq(distinct_id)`
 * was 1 across 142 routes and the surface with ~99% of this project's traffic
 * could not say how many callers it had. See USAGE_EVENT_DISTINCT_ID's own
 * header for the measurement and for how it surfaced.
 *
 * ## THE TWO NAMESPACES, AND WHY THEY ARE DIFFERENT KINDS OF THING
 *
 * An `account:` id is an identity the caller PRESENTED -- it authenticated
 * with a key belonging to that account. An `ip:` id is an observation we made
 * about the connection. Naming them apart keeps that distinction queryable,
 * and it is what `assignUsagePersonProcessing` reads to decide which callers
 * become person profiles (only the first: see its header for why that is a
 * cost gate and not a label).
 *
 * ## THE HASH IS SALTED, AND UNSALTED IS NOT AN OPTION
 *
 * IPv4 is 2^32 addresses -- small enough that an unsalted digest is a
 * reversible encoding of the address rather than a pseudonym, and it would put
 * a recoverable client IP in a third party's event store. So a missing salt
 * degrades to the old shared id instead of hashing without one: no salt, no
 * anonymous identity, and the count stays as uninformative as it was rather
 * than becoming informative and leaky.
 *
 * Resolved through `resolveClientIp` -- the same cf-connecting-ip-only path
 * the rate limiters use, not a second IP-extraction scheme that could disagree
 * with the thing enforcing the per-IP quotas this was written to diagnose.
 */
async function resolveUsageDistinctId(
  request: Request,
  env: Env,
): Promise<string | undefined> {
  const accountId = requestAccountId.get(request);
  if (accountId) return `${USAGE_ACCOUNT_NAMESPACE}${accountId}`;
  // Read off the declared field rather than by index, so the access is typed
  // against Env. The name is documented once as USAGE_DISTINCT_ID_SALT_ENV in
  // src/usage-telemetry.ts, for the ops side that has to set it.
  const salt: string | undefined = env.USAGE_DISTINCT_ID_SALT;
  if (!salt) return undefined;
  const ip = resolveClientIp(request);
  // `resolveClientIp` NEVER returns falsy -- absent `cf-connecting-ip` collapses
  // to ANONYMOUS_CLIENT_KEY, one fixed bucket, which is the right failure mode
  // for a rate limiter and the wrong one here. Hashing it would mint a single
  // confident-looking `ip:` id shared by every caller we could not resolve, and
  // a count built on that reads as "one caller" exactly the way the shared
  // fallback already did -- except now it looks specific. So an unresolved
  // address falls back to the shared id, which at least says so.
  if (ip !== ANONYMOUS_CLIENT_KEY) {
    return anonymousUsageDistinctId(salt, ip);
  }
  // #10606: a Worker-to-Worker subrequest has no client address and IS a
  // caller. `cf-worker` is set by Cloudflare, not by the sender, so it is
  // trustworthy and low-cardinality -- one value per calling Worker -- and
  // `resolveUsageClient` above already trusts it for the `client` dimension
  // for exactly that reason.
  //
  // RANKED BELOW THE ADDRESS, matching `resolveUsageClient`'s own precedence:
  // a Worker proxying a browser forwards the end user's `cf-connecting-ip`,
  // and the person behind the proxy is the more interesting caller than the
  // proxy. Only when there is no address at all does the calling Worker
  // become the best available answer.
  //
  // Worth having rather than collapsing to the shared id: #9004 found ONE
  // Worker (`zeronode.workers.dev`) was 82% of `block-detail`, which was in
  // turn the largest route in the project -- a caller that dominated the
  // traffic and could not be counted.
  // Guarded on the SANITISED value, not the raw header: the id is what has to
  // be non-empty, and checking the input instead would let a header that
  // sanitises away become the bare namespace -- `worker:`, a caller whose name
  // is the empty string, which reads as an identity and is not one.
  const callingWorker = sanitizeUsageLabel(request.headers.get("cf-worker"));
  if (callingWorker) {
    return `${USAGE_WORKER_NAMESPACE}${callingWorker}`;
  }
  return undefined;
}

/**
 * Who made this request, for the usage_event `client` dimension.
 *
 * #9004: a Cloudflare Worker subrequest sends NO User-Agent, so all of it
 * landed in the "no client" bucket. That is not a rounding error here -- it was
 * ~93% of `block-detail`, the single largest route in the project at 758,995
 * events/day, and identifying it required a live `wrangler tail` because the
 * telemetry could not answer it. One Worker (`zeronode.workers.dev`) turned out
 * to be 82% of that route: ~380K requests/day, each one a Worker invocation, a
 * Hyperdrive round-trip AND a PostHog event.
 *
 * Cloudflare sets `cf-worker` on Worker-to-Worker subrequests, so it is
 * trustworthy (not caller-supplied) and low-cardinality (one value per calling
 * Worker). Prefixed `worker:` so provenance rides with the value and a
 * UA-derived name can never be confused with a subrequest origin -- the same
 * discipline $mcp_client_name_source applies on the MCP side.
 *
 * User-Agent wins when both are present: a real client behind a Worker proxy is
 * more interesting than the proxy.
 */
function resolveUsageClient(request: Request): string | undefined {
  const fromUserAgent = parseUserAgentClient(
    request.headers.get("user-agent"),
  ).clientName;
  if (fromUserAgent) return fromUserAgent;
  const cfWorker = request.headers.get("cf-worker");
  return cfWorker ? `worker:${cfWorker}` : undefined;
}

/**
 * Run the request pipeline and record exactly one usage event for it. Returns
 * the handler's response untouched, and never converts a telemetry failure into
 * a request failure: an unconfigured deployment skips the work entirely, and a
 * recorder that rejects, throws, or a waitUntil that throws is swallowed.
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} ctx ExecutionContext (may be a bare object in tests).
 * @param {() => Promise<Response>} handle
 * @param {{recordUsageEvent?: typeof recordUsageEvent}} [deps]
 * @returns {Promise<Response>}
 */
export async function withRequestUsageTelemetry(
  request: Request,
  env: Env,
  ctx: Ctx,
  handle: () => Promise<Response>,
  resolveRoute: (url: URL) => string | null,
  deps: {
    recordUsageEvent?: typeof recordUsageEvent;
    recordExceptionEvent?: typeof recordExceptionEvent;
  } = {},
) {
  const record = deps.recordUsageEvent ?? recordUsageEvent;
  const recordException = deps.recordExceptionEvent ?? recordExceptionEvent;
  if (!isUsageTelemetryConfigured(env)) {
    return handle();
  }

  // A subscription upgrade (GraphQL subscriptions reuse the /api/v1/graphql
  // path over a WebSocket) opens a long-lived socket rather than serving a
  // request/response pair, so its latency would be meaningless. Recognized the
  // same way handleRequest itself dispatches it.
  if (request.headers.get("upgrade") === "websocket") {
    return handle();
  }

  const route = resolveRoute(new URL(request.url));
  if (route === null) {
    return handle();
  }

  const startedAt = Date.now();
  // #8963: request dimensions resolved once, up front, so they are recorded
  // even when the handler throws (the finally block below still fires).
  const method = request.method;
  const client = resolveUsageClient(request);
  let statusClass;
  let ok = false;
  // metagraphed#7733: errorResponse() (workers/http.ts) already sets this on
  // every REST error -- the same established code (invalid_query,
  // method_not_allowed, ai_error, ...) every route handler already uses, not
  // a new taxonomy. Undefined for a success response or one that predates
  // this convention, same "omitted, not just falsy" contract as MCP's
  // errorCode (#7726).
  let errorCode;
  try {
    const response = await handle();
    // 4xx is a route correctly rejecting a bad request, not a broken route;
    // only 5xx (and a thrown handler, which leaves ok false) is a failure.
    ok = response.status < 500;
    // Recorded alongside `ok`, not instead of it: `ok` folds every 4xx in with
    // the successes (a route correctly rejecting a bad request is not a
    // failure), which makes "are callers sending us garbage" unanswerable.
    statusClass = statusClassOf(response.status);
    errorCode =
      response.headers.get("x-metagraph-error-code") ??
      // #10606: a refusal whose response is deliberately uniform records its
      // code out of band. Second, never first -- a real header is the response
      // this request actually served, and must win.
      requestErrorCode.get(request) ??
      undefined;
    // metagraphed#7734: GraphQL execution errors are a spec-mandated 200
    // with a populated `errors` array (src/graphql.ts) -- status alone
    // can't distinguish that from a real success, so this one code (set
    // only when execute() surfaced a genuine resolver fault, never a
    // deliberate/expected GraphQLError -- see graphql.ts's own
    // genuineFaults comment) is a narrow, explicit exception to the
    // status-based rule above. Every other route/code keeps the existing
    // status<500 semantics untouched.
    if (errorCode === "graphql_execution_error") {
      ok = false;
    }
    return response;
  } catch (error) {
    // #9430: until now this wrapper was try/finally with NO catch, and
    // workers/api.entry.ts dropped Sentry's withSentry() wrap without
    // replacing it (#7766) -- so an uncaught throw anywhere in the REST
    // pipeline produced a usage_event with ok:false and NOTHING ELSE. No
    // stack, no PostHog Issue, no message: the single most severe class of
    // failure this Worker can have was also the least diagnosable, and
    // src/usage-telemetry.ts's own header documented the hole rather than
    // closing it ("a truly uncaught throw has no dedicated $exception capture
    // of its own ... just without a stack trace").
    //
    // Rethrown unchanged: this observes the failure, it does not handle it.
    // The runtime still produces its own 1101/500 exactly as before, and the
    // finally block below still records the same ok:false usage event -- so
    // the only behavioral difference is that the stack now reaches PostHog.
    //
    // `route` is already resolved and low-cardinality, giving the capture the
    // same fingerprint grouping (`<route>:<type>`) every hand-placed REST
    // capture site already gets.
    scheduleExceptionEvent(env, ctx, recordException, {
      error,
      route,
      errorCode: "internal_error",
    });
    throw error;
  } finally {
    const endedAt = Date.now();
    // Read AFTER the handler, since the gate that resolves it runs inside.
    // Absent for a route with no tiered gate, which is the honest answer --
    // those routes did not check a key, so "anonymous" would be a claim the
    // request never actually made. Same omitted-not-defaulted contract every
    // other optional dimension here follows.
    const authTier = requestAuthTier.get(request);
    scheduleUsageEvent(
      env,
      ctx,
      record,
      {
        route,
        ok,
        durationMs: endedAt - startedAt,
        method,
        ...(statusClass ? { statusClass } : {}),
        ...(client ? { client } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(authTier ? { authTier } : {}),
      },
      () => resolveUsageDistinctId(request, env),
    );
    // metagraphed#7768: PostHog distributed tracing (alpha), one root span
    // per request -- replaces @sentry/cloudflare's automatic withSentry() HTTP
    // instrumentation. Off by default (POSTHOG_TRACES_SAMPLE_RATE unset --
    // see src/tracing.ts's own header for why); set it as a deployed var to
    // match Sentry's old 0.05. Reuses this chokepoint's own route/ok/duration
    // -- see src/tracing.ts's header for why this is an independent span (no
    // parent) rather than nested under anything.
    // Outcome-aware since the AI-Observability tier measurement: this Worker's
    // REST rate is 0 (see src/tracing.ts's header for why its ~1.1M req/day
    // stays dark), which previously meant a 5xx here produced no span EVER.
    // Failures now always reach the recorder, bounded there by the storm
    // guard, so "REST is dark" costs throughput visibility without also
    // costing incident visibility.
    if (shouldRecordTraceSpan(env, { name: route, ok })) {
      scheduleTraceSpan(env, ctx, {
        traceId: newTraceId(),
        spanId: newSpanId(),
        name: route,
        startTimeMs: startedAt,
        endTimeMs: endedAt,
        ok,
        serviceName: "metagraphed-api",
        attributes: { route, error_code: errorCode },
      });
    }
  }
}

/**
 * Hand an exception to the recorder without ever blocking or failing the
 * response. Mirrors scheduleUsageEvent/scheduleTraceSpan exactly -- telemetry
 * must never surface into the request path, least of all on a path that is
 * already failing.
 */
export function scheduleExceptionEvent(
  env: Env,
  ctx: Ctx,
  record: typeof recordExceptionEvent,
  event: Parameters<typeof recordExceptionEvent>[1],
) {
  try {
    const pending = Promise.resolve(record(env, event)).catch(() => false);
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

function scheduleTraceSpan(
  env: Env,
  ctx: Ctx,
  span: Parameters<typeof recordTraceSpan>[1],
) {
  try {
    const pending = Promise.resolve(recordTraceSpan(env, span)).catch(
      () => false,
    );
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

/**
 * Hand the event to the recorder without ever blocking or failing the response.
 *
 * @param {object} env
 * @param {object} ctx
 * @param {typeof recordUsageEvent} record
 * @param {object} event
 */
function scheduleUsageEvent(
  env: Env,
  ctx: Ctx,
  record: typeof recordUsageEvent,
  event: UsageEvent,
  /**
   * Resolves the caller's distinct_id, INSIDE the scheduled work.
   *
   * A thunk rather than a resolved string because resolving it hashes, and
   * `withUsageTelemetry` awaits its telemetry in a `finally` -- an await there
   * happens before the function returns, so computing this eagerly would put a
   * SubtleCrypto digest in front of every response on a Worker serving ~1.1M
   * requests a day. Deferring it into the waitUntil keeps the request path
   * exactly as long as it was.
   */
  resolveDistinctId?: () => Promise<string | undefined>,
) {
  try {
    const pending = Promise.resolve(
      resolveDistinctId
        ? resolveDistinctId().then((distinctId) =>
            record(env, event, distinctId ? { distinctId } : {}),
          )
        : record(env, event),
    ).catch(() => false);
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

/**
 * Staged response audit for the routes the in-path tripwire cannot reach
 * (#10984). The entity handlers (per-UID metagraph, accounts, blocks,
 * extrinsics, chain-*) assemble their envelopes outside handleApiRequest's
 * generic seam, so METAGRAPH_VALIDATE_RESPONSES never sees them -- and
 * turning enforcement on for bodies never validated anywhere is how #10897
 * spent 26 hours serving 500s. This is the warn-first path the issue
 * prescribes:
 *
 *   METAGRAPH_AUDIT_RESPONSES unset  -- off (the flag check is the only cost)
 *   "warn"                           -- validate a CLONE under waitUntil and
 *                                       log each drift fingerprint; the body
 *                                       the caller gets is untouched
 *   "enforce"                        -- validate in-path and substitute the
 *                                       same refusal the generic seam serves
 *
 * Promotion is a flag flip, not a deploy of new logic: enforce reuses exactly
 * the code warn exercised. The route's TEMPLATE comes from matchRoute (the
 * #10985 lookup), so the resolver never sees a concrete path. A response the
 * generic seam already validated gets re-parsed here only while the audit
 * flag is set -- the staging cost, paid on purpose and only during staging.
 *
 * `projected` is passed when the request carried a fields/sections parameter:
 * the handler-level projections (metagraph-neurons, emission-pipeline) never
 * set meta.projection, so the URL is the only honest signal at this seam.
 */
// EXPORTED for its own tests: the drift arm needs a body no local route
// serves (the entity stores are empty locally, and empty arrays validate), so
// the suite hands it crafted responses directly.
export async function auditRouteResponse(
  request: Request,
  env: Env,
  ctx: Ctx,
  response: Response,
  resolveRoute: (pathname: string) => AuditRoute | null,
): Promise<Response> {
  const mode = env.METAGRAPH_AUDIT_RESPONSES as string | undefined;
  if (mode !== "warn" && mode !== "enforce") return response;
  if (response.status !== 200) return response;
  if (!response.headers.get("content-type")?.includes("json")) return response;
  const url = new URL(request.url);
  const matched = resolveRoute(url.pathname);
  if (!matched?.artifactTemplate) return response;
  // The three levers are declared once, in src/projection-signal.ts, because
  // the MCP dispatch answers the same question about the same contract and was
  // answering it differently -- which is to say not at all (#11142).
  const projected = urlProjects(url.searchParams);
  const run = async (body: unknown) => {
    await validateResponseTripwire(
      matched.id,
      body,
      matched.artifactTemplate,
      projected,
    );
  };
  if (mode === "warn") {
    const clone = response.clone();
    ctx.waitUntil?.(
      (async () => {
        try {
          await run(await clone.json());
        } catch (err) {
          if (err instanceof ResponseSchemaDriftError) {
            console.warn(
              `[METAGRAPH_AUDIT_RESPONSES] ${matched.id} DRIFTED (warn):`,
              JSON.stringify(err.detail).slice(0, 2000),
            );
          }
        }
      })(),
    );
    return response;
  }
  try {
    await run(await response.clone().json());
    return response;
  } catch (err) {
    if (err instanceof ResponseSchemaDriftError) {
      console.error(
        `[METAGRAPH_AUDIT_RESPONSES] ${matched.id} refused:`,
        err.detail,
      );
      return errorResponse(
        "response_schema_drift",
        `The ${matched.id} response did not match its published schema and was refused rather than served.`,
        500,
        { artifact_path: matched.artifactPath },
      );
    }
    return response;
  }
}

export async function withResponseTiming<T extends Response>(
  handle: () => Promise<T>,
): Promise<T> {
  return withRequestTiming(async () => {
    const before = degradedSnapshot();
    const response = await handle();
    labelDegradedResponse(response, before);
    // WHERE THE MILLISECONDS WENT, as the standard header a browser's devtools
    // panel already renders. Set here for the same reason the degraded label is
    // -- one point every route passes -- and built from marks collected at the
    // three storage boundaries rather than by instrumenting handlers, so a
    // route written next year is covered without its author doing anything.
    //
    // IN PLACE, swallowing an immutable-headers throw, exactly as
    // `labelDegradedResponse` documents. The one response class with immutable
    // headers is a body read back out of the edge cache, whose timings belong
    // to the request that STORED it -- losing the header there is correct,
    // because this request spent none of that time.
    const timing = serverTimingHeader();
    if (timing !== null) {
      try {
        response.headers.set("server-timing", timing);
      } catch {
        // A cached body; see above.
      }
    }
    return response;
  });
}

registerModuleStateReset("workers/request-lifecycle.ts", () => {
  requestAuthTier = new WeakMap();
  requestAccountId = new WeakMap();
  requestErrorCode = new WeakMap();
});
