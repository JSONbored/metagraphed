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
// Delivery (#4984 Part 3) is deliberately factored into src/alert-delivery.mjs
// (pure request-building, no I/O) + deliverAlertMatch below (the thin I/O
// shell that actually calls fetch) -- this class only decides WHICH
// triggers matched AND whether a match should actually be delivered right
// now (burst rate-limiting), never how each channel's request is shaped.
import {
  triggerMatchesEvent,
  type EvaluatorAlertTrigger,
} from "../src/alert-triggers.ts";
import { buildDeregRiskSnapshot } from "../src/dereg-risk.ts";
import {
  mapBounded,
  resolvedWebhookUrlStatus,
  resolveWebhookHostnamesWithDoh,
} from "../src/webhooks.ts";
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
// workers/data-api.mjs can persist chain_alert_triggers.match_count/
// last_matched_at. Deliberately much tighter than ALERT_DELIVERY_TIMEOUT_MS:
// this is a same-Cloudflare-network Worker-to-Worker call (like
// ALERT_TRIGGER_REFRESH_TIMEOUT_MS above), not a fetch to an arbitrary
// user-supplied endpoint, AND it runs CONCURRENTLY with the delivery
// fan-out (see evaluate() below) rather than adding to its latency, so a
// generous bound here would only cost something on the failure path.
export const ALERT_TRIGGER_MATCH_WRITEBACK_TIMEOUT_MS = 3000;

// The I/O shell around src/alert-delivery.mjs's pure request builders --
// constructor-injectable (see AlerterHub below) rather than a hardcoded
// call inside evaluate(), so tests can substitute a spy/failing stub
// without needing a real network, and so a future channel doesn't require
// restructuring evaluate() itself. Telegram/email degrade to a silent
// no-op when their secret isn't provisioned, matching every other optional
// integration's convention in this codebase (never throw for a
// deployment-config gap the caller can't do anything about).
//
// #5023 contract: resolves `true` on a CONFIRMED 2xx delivery, `false` in
// every other resolved case (non-2xx response, a builder returning null,
// an unrecognized channel, or a telegram/email no-op from an unset
// secret). A thrown/rejected fetch (network error, the AbortSignal timeout
// below) is NOT swallowed here -- it propagates as a rejection so
// evaluate()'s own wrapping can distinguish "delivery definitely did not
// succeed" (this function's `false`) from "delivery attempt itself
// failed" (a rejection), though both are treated identically for the
// rate-limit rollback decision.
export async function deliverAlertMatch(
  trigger: Trigger,
  payload: unknown,
  env: Env,
  fetchFn: typeof fetch = fetch,
  {
    resolveHostnames,
  }: { resolveHostnames?: (host: string) => Promise<string[]> } = {},
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
      if (!env.TELEGRAM_BOT_TOKEN) return false;
      request = buildTelegramDeliveryRequest(
        alertTrigger,
        alertPayload,
        env.TELEGRAM_BOT_TOKEN,
      );
      break;
    case "email":
      if (!env.RESEND_API_KEY || !env.RESEND_FROM_ADDRESS) return false;
      request = buildEmailDeliveryRequest(alertTrigger, alertPayload, {
        resendKey: env.RESEND_API_KEY,
        fromAddress: env.RESEND_FROM_ADDRESS,
      });
      break;
    default:
      return false;
  }
  // A null request means the builder itself refused (e.g.
  // buildWebhookDeliveryRequest's defense-in-depth URL re-check) --
  // nothing to send.
  if (!request) return false;
  if (trigger.channel === "webhook") {
    const urlStatus = await resolvedWebhookUrlStatus(
      request.url,
      resolveHostnames ||
        ((host: string) =>
          resolveWebhookHostnamesWithDoh(host, { fetchImpl: fetchFn })),
    );
    if (urlStatus !== "ok") return false;
  }

  // The timeout signal is applied HERE, not baked into the pure builders in
  // src/alert-delivery.mjs -- AbortSignal.timeout() starts a real wall-clock
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
    return false;
  }
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
  // triggerMatchesEvent (src/alert-triggers.mjs, already unit-tested);
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
  // to workers/data-api.mjs's internal match-count route, so
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
          succeeded = (await this.deliver(trigger, payload, this.env)) === true;
        } catch {
          succeeded = false;
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
    await Promise.allSettled([deliveryPromise, writebackPromise]);

    return {
      matched: matched.length,
      trigger_ids: matched.map((t) => t.id),
      delivered: toDeliver.length,
      rate_limited: rateLimited,
    };
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
