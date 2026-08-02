// AlerterHub -- the #4984 evaluator + delivery dispatcher: a singleton
// Durable Object (idFromName("global")) that ChainFirehoseHub pings on
// every broadcast() (see that class's own ALERTER_HUB ping, mirroring the
// #4983 MCP-notify loop's shape -- but unconditional/global rather than
// per-session, since there is exactly one evaluator, not one per
// subscriber).
//
// Caches active trigger definitions (refreshed from Postgres via the
// DATA_API service binding's internal-only active-list route, #4984 Part 1)
// rather than querying Postgres per chain event -- evaluation must stay
// fast enough to never become the bottleneck in ChainFirehoseHub's
// broadcast() fan-out, which every OTHER consumer (SSE/WS/GraphQL/MCP)
// shares the same request with. A stale cache degrades gracefully (a
// brand-new trigger takes up to ALERTER_HUB_TRIGGER_CACHE_TTL_MS to start
// matching; a deleted one keeps matching for the same window) rather than
// adding a synchronous Postgres round-trip to every single chain event.
//
// Delivery (#4984 Part 3) is deliberately factored into src/alert-delivery.ts
// (pure request-building, no I/O) + deliverAlertMatch below (the thin I/O
// shell that actually calls fetch) -- this class only decides WHICH
// triggers matched AND whether a match should actually be delivered right
// now (burst rate-limiting), never how each channel's request is shaped.
import {
  ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES,
  triggerMatchesEvent,
  type EvaluatorAlertTrigger,
} from "../src/alert-triggers.ts";
import { recordUsageEvent } from "../src/usage-telemetry.ts";
import { buildDeregRiskSnapshot } from "../src/dereg-risk.ts";
import {
  mapBounded,
  resolvedWebhookUrlStatus,
  resolveWebhookHostnamesWithDoh,
} from "../src/webhooks.ts";
import {
  buildPushRequest,
  isExpiredSubscriptionStatus,
  type PushSubscriptionKeys,
} from "../src/web-push.ts";
import { buildPushNotificationPayload } from "../src/web-push-payload.ts";
import {
  buildDiscordDeliveryRequest,
  buildEmailDeliveryRequest,
  buildTelegramDeliveryRequest,
  buildWebhookDeliveryRequest,
  isDeliveryRateLimited,
  type AlertTrigger,
} from "../src/alert-delivery.ts";

// #6746/#6747: the empty snapshot every AlerterHub starts with and falls
// back to whenever a metric refresh is skipped/fails -- both of
// triggerMatchesEvent's own metric lookups already treat a missing map
// entry as "does not match" (fails closed), so an empty snapshot is a
// genuinely safe default, not a placeholder that needs special-casing.
export interface Trigger {
  id: string;
  channel: string;
  condition?: unknown;
  [key: string]: unknown;
}

export interface MetricSnapshot {
  subnetAlphaPriceRank: Map<unknown, unknown>;
  neuronImmunityCountdownBlocks: Map<unknown, unknown>;
}

function emptyMetricSnapshot(): MetricSnapshot {
  return {
    subnetAlphaPriceRank: new Map(),
    neuronImmunityCountdownBlocks: new Map(),
  };
}

export const ALERTER_HUB_TRIGGER_CACHE_TTL_MS = 5 * 60 * 1000;

// Found by adversarial review: this Worker-to-Worker call is on the SAME
// synchronous path every single firehose event blocks on (via
// ChainFirehoseHub.broadcast()'s ALERTER_HUB ping) -- an internal
// Cloudflare-to-Cloudflare Hyperdrive round trip, so a much tighter bound
// than the per-channel delivery timeout below is appropriate; a Postgres
// query that's still running after this long is not going to finish in
// time to matter anyway.
const ALERT_TRIGGER_REFRESH_TIMEOUT_MS = 4000;

// Found by adversarial review: a single chain event can match many DISTINCT
// triggers (the per-trigger burst rate-limiter only throttles repeats of
// the SAME trigger, not how many different triggers fire on one event) --
// an unbounded Promise.all could open one outbound fetch per match,
// exhausting this Durable Object invocation's concurrent-subrequest budget
// under a large, broad-condition trigger set. Matches src/webhooks.ts's
// own dispatchChangeEvent concurrency default.
const ALERT_DELIVERY_CONCURRENCY = 8;

// AlerterHub.evaluate() is awaited by ChainFirehoseHub.broadcast() (see that
// class's ALERTER_HUB ping), which every OTHER consumer (SSE/WS/GraphQL/MCP)
// shares the same broadcast() call with -- unlike those consumers'
// same-Cloudflare-network DO-to-DO calls, a delivery fetch here can hit an
// arbitrary user-supplied webhook or a slow third-party API. Without a
// bound, ONE slow/hanging delivery target would add its own latency to
// EVERY firehose consumer's next event, not just this trigger's owner.
// Matches src/webhooks.ts's own deliverChangeEvent timeout convention
// (same 8s default).
const ALERT_DELIVERY_TIMEOUT_MS = 8000;

// #5022: the internal write-back that reports EVERY matched trigger id (not
// just the ones that clear the burst rate-limit -- match_count means "this
// trigger's conditions were satisfied", independent of delivery) so
// workers/data-api.ts can persist chain_alert_triggers.match_count/
// last_matched_at. Deliberately much tighter than ALERT_DELIVERY_TIMEOUT_MS:
// this is a same-Cloudflare-network Worker-to-Worker call (like
// ALERT_TRIGGER_REFRESH_TIMEOUT_MS above), not a fetch to an arbitrary
// user-supplied endpoint, AND it runs CONCURRENTLY with the delivery
// fan-out (see evaluate() below) rather than adding to its latency, so a
// generous bound here would only cost something on the failure path.
export const ALERT_TRIGGER_MATCH_WRITEBACK_TIMEOUT_MS = 3000;

// The I/O shell around src/alert-delivery.ts's pure request builders --
// constructor-injectable (see AlerterHub below) rather than a hardcoded
// call inside evaluate(), so tests can substitute a spy/failing stub
// without needing a real network, and so a future channel doesn't require
// restructuring evaluate() itself. Telegram/email degrade to a silent
// no-op when their secret isn't provisioned, matching every other optional
// integration's convention in this codebase (never throw for a
// deployment-config gap the caller can't do anything about).
//
// #8375: the Alert Center's per-delivery history record -- what
// writeBackDeliveryLog persists to chain_alert_deliveries. `statusCode` is
// null for every path that never reached a real HTTP response (an
// unrecognized channel, a builder refusing the request, a failed SSRF
// re-check, an unconfigured telegram/email secret); `responseSnippet` is
// only ever populated on a non-2xx response, truncated to
// ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES.
export interface AlertDeliveryOutcome {
  success: boolean;
  statusCode: number | null;
  responseSnippet: string | null;
}

// #5023 contract: resolves `true` on a CONFIRMED 2xx delivery, `false` in
// every other resolved case (non-2xx response, a builder returning null,
// an unrecognized channel, or a telegram/email no-op from an unset
// secret). A thrown/rejected fetch (network error, the AbortSignal timeout
// below) is NOT swallowed here -- it propagates as a rejection so
// evaluate()'s own wrapping can distinguish "delivery definitely did not
// succeed" (this function's `false`) from "delivery attempt itself
// failed" (a rejection), though both are treated identically for the
// rate-limit rollback decision.
//
// `onOutcome` (#8375) is an ADDITIVE, optional side channel -- the return
// type stays a plain boolean so every pre-existing caller/test (the #5023
// contract above, evaluate()'s `=== true` rollback check) is byte-for-byte
// unaffected; only evaluate()'s new delivery-log write-back passes it, to
// capture the richer AlertDeliveryOutcome without a second fetch. Never
// called on the rejected-fetch path -- that path never resolves this
// function at all, so evaluate()'s own catch block records that outcome
// instead (see below).
// #8385: resolve a webpush trigger's destination (a push-service endpoint)
// to the crypto material needed to encrypt for that device. Reads through
// the SAME internal service-binding + token pattern refreshTriggers() uses,
// rather than giving this Worker its own database handle.
//
// Returns null on any failure (unprovisioned, network, pruned device, bad
// shape) so the caller records a delivery failure instead of throwing into
// ChainFirehoseHub's ingest path.
async function loadPushSubscription(
  env: Env,
  endpoint: string,
): Promise<PushSubscriptionKeys | null> {
  if (!env.DATA_API || !env.ALERT_TRIGGERS_INTERNAL_TOKEN) return null;
  try {
    const upstream = await env.DATA_API.fetch(
      `https://data-api.internal/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(endpoint)}`,
      {
        headers: {
          "x-alert-triggers-internal-token": env.ALERT_TRIGGERS_INTERNAL_TOKEN,
        },
        signal: AbortSignal.timeout(ALERT_TRIGGER_REFRESH_TIMEOUT_MS),
      },
    );
    if (!upstream.ok) return null;
    const body = (await upstream.json()) as {
      subscription?: PushSubscriptionKeys | null;
    };
    const sub = body?.subscription;
    if (!sub?.endpoint || !sub.p256dh || !sub.auth) return null;
    return sub;
  } catch {
    return null;
  }
}

// #8385 requirement 4: a 404/410 from the push service means the browser
// unsubscribed or the endpoint was purged -- terminal, so the row is pruned
// rather than retried forever (the classic web-push storage leak). Fire and
// forget: pruning is bookkeeping, and its failure must never turn a
// already-recorded delivery outcome into a thrown error.
async function prunePushSubscription(
  env: Env,
  endpoint: string,
): Promise<void> {
  // Asserted, not guarded. Prune only ever runs after a SUCCESSFUL
  // subscription lookup (loadPushSubscription), which already required both
  // bindings -- so a runtime check here would be an unreachable branch rather
  // than defense. If either were somehow absent, the call below throws and is
  // swallowed by the same catch that already makes this fire-and-forget.
  const internalToken = env.ALERT_TRIGGERS_INTERNAL_TOKEN as string;
  try {
    await env.DATA_API!.fetch(
      "https://data-api.internal/api/v1/internal/push-subscription",
      {
        method: "DELETE",
        headers: {
          "x-alert-triggers-internal-token": internalToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint }),
      },
    );
  } catch {
    /* best effort */
  }
}

export async function deliverAlertMatch(
  trigger: Trigger,
  payload: unknown,
  env: Env,
  fetchFn: typeof fetch = fetch,
  {
    resolveHostnames,
    onOutcome,
  }: {
    resolveHostnames?: (host: string) => Promise<string[]>;
    onOutcome?: (outcome: AlertDeliveryOutcome) => void;
  } = {},
): Promise<boolean> {
  let request: { url: string; init?: RequestInit } | null | undefined;
  // Trigger's `destination` lives behind its index signature (the shape
  // varies by channel), but every delivered trigger carries one — the
  // alert-delivery builders below require it as a concrete string field.
  const alertTrigger = trigger as unknown as AlertTrigger;
  const alertPayload = payload as Record<string, unknown> | null | undefined;
  switch (trigger.channel) {
    case "webhook":
      request = buildWebhookDeliveryRequest(
        alertTrigger,
        alertPayload,
        Date.now(),
      );
      break;
    case "discord":
      request = buildDiscordDeliveryRequest(alertTrigger, alertPayload);
      break;
    case "telegram":
      if (!env.TELEGRAM_BOT_TOKEN) {
        onOutcome?.({
          success: false,
          statusCode: null,
          responseSnippet: null,
        });
        return false;
      }
      request = buildTelegramDeliveryRequest(
        alertTrigger,
        alertPayload,
        env.TELEGRAM_BOT_TOKEN,
      );
      break;
    case "email":
      if (!env.RESEND_API_KEY || !env.RESEND_FROM_ADDRESS) {
        onOutcome?.({
          success: false,
          statusCode: null,
          responseSnippet: null,
        });
        return false;
      }
      request = buildEmailDeliveryRequest(alertTrigger, alertPayload, {
        resendKey: env.RESEND_API_KEY,
        fromAddress: env.RESEND_FROM_ADDRESS,
      });
      break;
    // #8385: the destination is the push-service endpoint; the crypto
    // material lives in watch_push_subscriptions, and the VAPID keypair in
    // Worker secrets. Unprovisioned deploys degrade exactly like telegram/
    // email above (a recorded failure, never a throw).
    case "webpush": {
      if (
        !env.VAPID_PUBLIC_KEY ||
        !env.VAPID_PRIVATE_KEY ||
        !env.VAPID_SUBJECT
      ) {
        onOutcome?.({
          success: false,
          statusCode: null,
          responseSnippet: "webpush is not provisioned on this deployment",
        });
        return false;
      }
      // Goes through the DATA_API service binding, not the injectable
      // fetchFn -- that override exists for the outbound delivery request,
      // which is what tests stub.
      const subscription = await loadPushSubscription(
        env,
        alertTrigger.destination,
      );
      if (!subscription) {
        // The device was pruned (or never existed) -- a terminal state for
        // this trigger, recorded so the Alert Center can show why.
        onOutcome?.({
          success: false,
          statusCode: null,
          responseSnippet: "device expired",
        });
        return false;
      }
      const pushRequest = await buildPushRequest(
        JSON.stringify(
          buildPushNotificationPayload(alertTrigger, alertPayload, Date.now()),
        ),
        subscription,
        {
          publicKey: env.VAPID_PUBLIC_KEY,
          signingKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT,
        },
      );
      request = pushRequest
        ? {
            url: pushRequest.url,
            init: {
              method: "POST",
              headers: pushRequest.headers,
              body: pushRequest.body as unknown as BodyInit,
            },
          }
        : null;
      break;
    }
    default:
      onOutcome?.({ success: false, statusCode: null, responseSnippet: null });
      return false;
  }
  // A null request means the builder itself refused (e.g.
  // buildWebhookDeliveryRequest's defense-in-depth URL re-check) --
  // nothing to send.
  if (!request) {
    onOutcome?.({ success: false, statusCode: null, responseSnippet: null });
    return false;
  }
  if (trigger.channel === "webhook") {
    const urlStatus = await resolvedWebhookUrlStatus(
      request.url,
      resolveHostnames ||
        ((host: string) =>
          resolveWebhookHostnamesWithDoh(host, { fetchImpl: fetchFn })),
    );
    if (urlStatus !== "ok") {
      onOutcome?.({ success: false, statusCode: null, responseSnippet: null });
      return false;
    }
  }

  // The timeout signal is applied HERE, not baked into the pure builders in
  // src/alert-delivery.ts -- AbortSignal.timeout() starts a real wall-clock
  // timer the moment it's constructed, which that module's own header
  // comment promises never happens (no I/O, no timers, fully deterministic
  // for tests).
  const response = await fetchFn(request.url, {
    ...request.init,
    redirect: "manual",
    signal: AbortSignal.timeout(ALERT_DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Never throw for a non-2xx response -- evaluate()'s own wrapping only
    // needs to catch a REJECTED fetch (network/timeout); an HTTP-level
    // failure resolves normally, so it's logged here instead, server-side
    // only, matching this codebase's "log internals, never leak them"
    // convention.
    console.error(
      `alert delivery failed (channel=${trigger.channel}, trigger=${trigger.id}): HTTP ${response.status}`,
    );
    let responseSnippet: string | null = null;
    try {
      responseSnippet = (await response.text()).slice(
        0,
        ALERT_DELIVERY_RESPONSE_SNIPPET_MAX_BYTES,
      );
    } catch {
      // Best-effort -- an unreadable body (already consumed, a stream
      // error) just means no snippet, never a thrown deliverAlertMatch.
    }
    // #8385 requirement 4: 404/410 from a push service is terminal -- the
    // browser unsubscribed or the endpoint was purged. Prune the device and
    // say so in the history, rather than retrying a dead endpoint forever.
    if (
      trigger.channel === "webpush" &&
      isExpiredSubscriptionStatus(response.status)
    ) {
      await prunePushSubscription(env, alertTrigger.destination);
      onOutcome?.({
        success: false,
        statusCode: response.status,
        responseSnippet: "device expired",
      });
      return false;
    }
    onOutcome?.({
      success: false,
      statusCode: response.status,
      responseSnippet,
    });
    return false;
  }
  onOutcome?.({
    success: true,
    statusCode: response.status,
    responseSnippet: null,
  });
  return true;
}

export class AlerterHub implements DurableObject {
  state: DurableObjectState;
  env: Env;
  deliver: typeof deliverAlertMatch;
  triggers: Trigger[];
  triggersLoadedAt: number;
  metricSnapshot: MetricSnapshot;
  loadingPromise: Promise<void> | null;
  lastDeliveredAt: Map<string, number>;

  constructor(
    state: DurableObjectState,
    env: Env,
    {
      deliver = deliverAlertMatch,
    }: { deliver?: typeof deliverAlertMatch } = {},
  ) {
    this.state = state;
    this.env = env;
    this.deliver = deliver;
    this.triggers = [];
    this.triggersLoadedAt = 0;
    // #6746/#6747: the cached snapshot condition-type triggers are matched
    // against -- refreshed ALONGSIDE the trigger list (same TTL/timeout
    // budget), never fetched per-event. Starts empty (fails closed: a
    // condition trigger simply never matches until the first successful
    // refresh populates real data), matching triggersLoadedAt's own
    // cold-start convention.
    this.metricSnapshot = emptyMetricSnapshot();
    // Coalesces concurrent evaluate() calls that all find the cache stale
    // into ONE refresh request rather than one per call -- broadcast()
    // fires one /evaluate POST per chain event, and events can arrive
    // faster than a single refresh round-trip completes.
    this.loadingPromise = null;
    // Per-trigger burst rate-limit state (#4984 Part 3's "a burst of
    // matching events... doesn't spam a single subscriber" deliverable).
    // In-memory, not persisted -- a DO reconstruction (hibernation wake,
    // redeploy) resets it, which just means the next match after a
    // reconstruction is never wrongly rate-limited; the opposite failure
    // (permanently under-limiting) would be the unsafe direction here.
    this.lastDeliveredAt = new Map();
  }

  isTriggerCacheStale(): boolean {
    return (
      Date.now() - this.triggersLoadedAt > ALERTER_HUB_TRIGGER_CACHE_TTL_MS
    );
  }

  async ensureTriggersLoaded(): Promise<void> {
    if (!this.isTriggerCacheStale()) return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.refreshTriggers().finally(() => {
        this.loadingPromise = null;
      });
    }
    return this.loadingPromise;
  }

  async refreshTriggers(): Promise<void> {
    if (!this.env.DATA_API || !this.env.ALERT_TRIGGERS_INTERNAL_TOKEN) {
      // Not provisioned on this deployment -- keep whatever was cached
      // before (possibly still empty). Never throw: a cold/unconfigured
      // evaluator must not block ChainFirehoseHub's ingest path, which
      // awaits this indirectly via evaluate().
      return;
    }
    try {
      const upstream = await this.env.DATA_API.fetch(
        "https://data-api.internal/api/v1/internal/alert-triggers-active",
        {
          headers: {
            "x-alert-triggers-internal-token":
              this.env.ALERT_TRIGGERS_INTERNAL_TOKEN,
          },
          signal: AbortSignal.timeout(ALERT_TRIGGER_REFRESH_TIMEOUT_MS),
        },
      );
      if (!upstream.ok) return;
      const body = (await upstream.json()) as { triggers?: Trigger[] };
      if (Array.isArray(body?.triggers)) {
        this.triggers = body.triggers;
        this.triggersLoadedAt = Date.now();
        // #5024: prune any lastDeliveredAt entry for a trigger id that is
        // no longer present in the fresh active-trigger list (deleted or
        // deactivated since the last refresh) -- otherwise a Durable
        // Object that lives across many refresh cycles accumulates one
        // permanently-stale Map entry per retired trigger. One pass,
        // O(active triggers); only runs after a SUCCESSFUL refresh (never
        // on a failed/skipped one, since a stale-but-still-valid cache
        // must not have its rate-limit state pruned against a fetch that
        // didn't actually happen).
        const activeTriggerIds = new Set(this.triggers.map((t) => t.id));
        for (const triggerId of this.lastDeliveredAt.keys()) {
          if (!activeTriggerIds.has(triggerId)) {
            this.lastDeliveredAt.delete(triggerId);
          }
        }
      }
    } catch {
      // Best-effort refresh -- keep serving the stale cache rather than
      // throwing out of evaluate().
    }
    // #6746/#6747: only fetch the metric snapshot when at least one ACTIVE
    // trigger actually has a condition -- the overwhelming common case
    // today is zero (this is a brand-new capability), so this keeps every
    // existing/fixed-field-only deployment's refresh cycle exactly as cheap
    // as it already was: one Postgres round trip, not two, unless a
    // predicate trigger genuinely exists to justify the second one.
    if (this.triggers.some((trigger) => trigger.condition)) {
      await this.refreshMetricSnapshot();
    }
  }

  async refreshMetricSnapshot(): Promise<void> {
    if (!this.env.DATA_API || !this.env.ALERT_TRIGGERS_INTERNAL_TOKEN) {
      return;
    }
    try {
      const upstream = await this.env.DATA_API.fetch(
        "https://data-api.internal/api/v1/internal/alert-triggers-dereg-risk-snapshot",
        {
          headers: {
            "x-alert-triggers-internal-token":
              this.env.ALERT_TRIGGERS_INTERNAL_TOKEN,
          },
          signal: AbortSignal.timeout(ALERT_TRIGGER_REFRESH_TIMEOUT_MS),
        },
      );
      if (!upstream.ok) return;
      const body = (await upstream.json()) as {
        subnets?: unknown;
        immune_neurons?: unknown;
        current_block?: unknown;
      };
      this.metricSnapshot = buildDeregRiskSnapshot({
        economicsRows: body?.subnets as Array<Record<string, unknown>>,
        neuronRows: body?.immune_neurons as Array<Record<string, unknown>>,
        currentBlock: body?.current_block as number,
      });
    } catch {
      // Best-effort -- keep serving the stale (or empty) snapshot rather
      // than throwing out of evaluate(); a condition trigger just keeps
      // failing closed against stale data until the next successful
      // refresh, never against a thrown error.
    }
  }

  // Pure decision given the CURRENT cache -- exported behavior is really
  // triggerMatchesEvent (src/alert-triggers.ts, already unit-tested);
  // this just applies it across every cached trigger.
  matchingTriggers(payload: unknown): Trigger[] {
    return this.triggers.filter((trigger) =>
      // this.triggers is fetched straight from the active-triggers response
      // (built server-side via evaluatorAlertTriggerView), so it already has
      // EvaluatorAlertTrigger's shape at runtime even though Trigger's own
      // index signature doesn't statically expose it.
      triggerMatchesEvent(
        trigger as unknown as EvaluatorAlertTrigger,
        payload as Record<string, unknown> | null | undefined,
        this.metricSnapshot,
      ),
    );
  }

  // #5022: best-effort write-back reporting EVERY matched trigger id (the
  // FULL matched list, not just the ones that clear the burst rate-limit)
  // to workers/data-api.ts's internal match-count route, so
  // chain_alert_triggers.match_count/last_matched_at reflect real values.
  // No-op when DATA_API/ALERT_TRIGGERS_INTERNAL_TOKEN isn't provisioned,
  // matching refreshTriggers()'s own optional-integration convention.
  // Never throws -- called from evaluate() alongside the delivery fan-out
  // via Promise.allSettled, and a write-back failure must never affect
  // evaluate()'s response or reject out of that call.
  async writeBackMatchCounts(triggerIds: string[]): Promise<void> {
    if (
      !this.env.DATA_API ||
      !this.env.ALERT_TRIGGERS_INTERNAL_TOKEN ||
      triggerIds.length === 0
    ) {
      return;
    }
    try {
      const response = await this.env.DATA_API.fetch(
        "https://data-api.internal/api/v1/internal/alert-triggers/matched",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-alert-triggers-internal-token":
              this.env.ALERT_TRIGGERS_INTERNAL_TOKEN,
          },
          body: JSON.stringify({ trigger_ids: triggerIds }),
          signal: AbortSignal.timeout(ALERT_TRIGGER_MATCH_WRITEBACK_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.error(
          `alert match-count write-back failed: HTTP ${response.status}`,
        );
      }
    } catch {
      // Best-effort -- match_count is an analytics aid, not something
      // delivery or rate-limiting logic depends on; losing an increment
      // here (a slow/unreachable DATA_API, a timeout) is fine, an
      // exception propagating out of evaluate() is not.
    }
  }

  // #8375: one write-back call per delivery ATTEMPT (not per match) --
  // records for triggers that never cleared the burst rate-limit are never
  // pushed, matching writeBackMatchCounts' distinction between "matched" and
  // "delivered" above. Same best-effort/never-throws posture as
  // writeBackMatchCounts: delivery history is an observability aid for the
  // Alert Center, not something delivery or rate-limiting logic depends on.
  async writeBackDeliveryLog(
    records: Array<{
      triggerId: string;
      deliveredAt: number;
      success: boolean;
      statusCode: number | null;
      responseSnippet: string | null;
    }>,
  ): Promise<void> {
    if (
      !this.env.DATA_API ||
      !this.env.ALERT_TRIGGERS_INTERNAL_TOKEN ||
      records.length === 0
    ) {
      return;
    }
    try {
      const response = await this.env.DATA_API.fetch(
        "https://data-api.internal/api/v1/internal/alert-triggers/deliveries",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-alert-triggers-internal-token":
              this.env.ALERT_TRIGGERS_INTERNAL_TOKEN,
          },
          body: JSON.stringify({
            records: records.map((r) => ({
              trigger_id: r.triggerId,
              delivered_at: r.deliveredAt,
              success: r.success,
              status_code: r.statusCode,
              response_snippet: r.responseSnippet,
            })),
          }),
          signal: AbortSignal.timeout(ALERT_TRIGGER_MATCH_WRITEBACK_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.error(
          `alert delivery-log write-back failed: HTTP ${response.status}`,
        );
      }
    } catch {
      // Best-effort -- see header comment above.
    }
  }

  async evaluate(payload: unknown): Promise<{
    matched: number;
    trigger_ids?: string[];
    delivered?: number;
    rate_limited?: number;
  }> {
    await this.ensureTriggersLoaded();
    const matched = this.matchingTriggers(payload);
    if (matched.length === 0) return { matched: 0 };

    // Every match counts toward the response (an owner querying "did this
    // fire?" wants the true answer), but only NOT-rate-limited matches
    // actually attempt delivery -- coalescing a burst into one delivery
    // per window rather than dropping the burst's own visibility.
    const now = Date.now();
    const toDeliver: Trigger[] = [];
    // #5023: the value each rate-limited-clearing trigger's lastDeliveredAt
    // entry held BEFORE this call's optimistic set below (undefined if it
    // had none) -- kept so a failed delivery can be rolled back to exactly
    // that prior state instead of just guessing "delete it".
    const priorLastDeliveredAt = new Map<string, number | undefined>();
    let rateLimited = 0;
    for (const trigger of matched) {
      const prior = this.lastDeliveredAt.get(trigger.id);
      if (isDeliveryRateLimited(prior, now)) {
        rateLimited += 1;
        continue;
      }
      // Optimistic set BEFORE delivery is attempted -- this protects
      // against a burst of near-simultaneous matches for the SAME trigger
      // (within one evaluate() call, or racing across two evaluate() calls)
      // both queueing a duplicate concurrent delivery attempt. Do NOT
      // remove this: it is rolled back below (not left in place) when the
      // delivery attempt does not actually succeed.
      priorLastDeliveredAt.set(trigger.id, prior);
      this.lastDeliveredAt.set(trigger.id, now);
      toDeliver.push(trigger);
    }

    // #8375: one record per delivery ATTEMPT, appended by the onOutcome
    // callback deliverAlertMatch invokes just before it resolves -- pushed
    // here rather than derived from `succeeded` below so a non-2xx response's
    // status code/snippet survive into the Alert Center's delivery history,
    // not just the boolean rollback decision.
    const deliveryRecords: Array<{
      triggerId: string;
      deliveredAt: number;
      success: boolean;
      statusCode: number | null;
      responseSnippet: string | null;
    }> = [];

    // #5022: the delivery fan-out and the match-count write-back run
    // CONCURRENTLY (Promise.allSettled), never sequentially -- sequencing
    // them would ADD the two latencies together, pushing evaluate()'s own
    // worst case toward ChainFirehoseHub.broadcast()'s
    // ALERTER_HUB_EVALUATE_TIMEOUT_MS ceiling (15s) that wraps this whole
    // call. Neither promise here can reject (each swallows its own
    // failures internally), so allSettled is defensive, not load-bearing.
    const deliveryPromise = mapBounded(
      toDeliver,
      ALERT_DELIVERY_CONCURRENCY,
      async (trigger: Trigger) => {
        // #5023: capture success/failure instead of relying on the old
        // implicit "resolved == succeeded" convention -- a REJECTED
        // deliver() (network error, delivery timeout) is treated
        // identically to an explicit `false` return for the rollback
        // decision below; either way, a single misbehaving delivery
        // integration must never fail the evaluation response
        // ChainFirehoseHub's broadcast() awaits.
        let succeeded;
        try {
          succeeded =
            (await this.deliver(trigger, payload, this.env, undefined, {
              onOutcome: (outcome) => {
                deliveryRecords.push({
                  triggerId: trigger.id,
                  deliveredAt: now,
                  success: outcome.success,
                  statusCode: outcome.statusCode,
                  responseSnippet: outcome.responseSnippet,
                });
              },
            })) === true;
        } catch {
          succeeded = false;
          // A rejected deliver() (network error, timeout) never reaches
          // deliverAlertMatch's own onOutcome call -- record the same
          // "attempted, no HTTP response" shape here instead, so a
          // hard-failing endpoint still shows up in delivery history.
          deliveryRecords.push({
            triggerId: trigger.id,
            deliveredAt: now,
            success: false,
            statusCode: null,
            responseSnippet: null,
          });
        }
        // #8997: a delivery hub that silently stops delivering is the classic
        // Durable Object failure -- and this class had no telemetry at all.
        //
        // FAILURES ONLY, deliberately. evaluate() runs once per chain event, so
        // a per-evaluation or even per-delivery event would scale with chain
        // activity on a project already ~33x over its PostHog free tier
        // (#9004). A failed delivery is bounded by how often an endpoint is
        // actually broken, which is the thing worth paying to see.
        //
        // Per-delivery outcomes ARE already recorded -- into
        // chain_alert_deliveries on the self-hosted Postgres. That box is
        // decommissioned 2026-08-03, at which point this becomes the only
        // signal rather than a duplicate one.
        if (!succeeded) {
          this.emitTelemetry({
            route: "alerter-hub:deliver",
            ok: false,
            durationMs: Date.now() - now,
          });
        }
        if (succeeded) return;
        // Roll back the optimistic set above: a delivery that did NOT
        // succeed must not consume the rate-limit window, so the VERY NEXT
        // matching event for this trigger retries immediately rather than
        // waiting out the full window.
        const prior = priorLastDeliveredAt.get(trigger.id);
        if (prior === undefined) {
          this.lastDeliveredAt.delete(trigger.id);
        } else {
          this.lastDeliveredAt.set(trigger.id, prior);
        }
      },
    );
    const writebackPromise = this.writeBackMatchCounts(
      matched.map((t) => t.id),
    );
    // Chained onto deliveryPromise (not started concurrently with it, unlike
    // writebackPromise above) -- deliveryRecords is only fully populated
    // once every delivery attempt in the mapBounded fan-out has resolved.
    const deliveryLogPromise = deliveryPromise.then(() =>
      this.writeBackDeliveryLog(deliveryRecords),
    );
    await Promise.allSettled([
      deliveryPromise,
      writebackPromise,
      deliveryLogPromise,
    ]);

    return {
      matched: matched.length,
      trigger_ids: matched.map((t) => t.id),
      delivered: toDeliver.length,
      rate_limited: rateLimited,
    };
  }

  /**
   * Fire-and-forget telemetry. A Durable Object has no ExecutionContext, so
   * this uses DurableObjectState.waitUntil where the runtime provides it and
   * otherwise lets the promise run detached -- never awaited, and never able
   * to fail the evaluation ChainFirehoseHub's broadcast() is waiting on.
   */
  private emitTelemetry(event: {
    route: string;
    ok: boolean;
    durationMs: number;
  }): void {
    try {
      const pending = Promise.resolve(recordUsageEvent(this.env, event)).catch(
        () => false,
      );
      (
        this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void }
      ).waitUntil?.(pending);
    } catch {
      // Telemetry must never surface into the alerting path.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/evaluate" && request.method === "POST") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await this.evaluate(payload);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}
