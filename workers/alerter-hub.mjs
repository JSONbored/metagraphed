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
import { triggerMatchesEvent } from "../src/alert-triggers.mjs";
import {
  buildDiscordDeliveryRequest,
  buildEmailDeliveryRequest,
  buildTelegramDeliveryRequest,
  buildWebhookDeliveryRequest,
  isDeliveryRateLimited,
} from "../src/alert-delivery.mjs";

export const ALERTER_HUB_TRIGGER_CACHE_TTL_MS = 5 * 60 * 1000;

// AlerterHub.evaluate() is awaited by ChainFirehoseHub.broadcast() (see that
// class's ALERTER_HUB ping), which every OTHER consumer (SSE/WS/GraphQL/MCP)
// shares the same broadcast() call with -- unlike those consumers'
// same-Cloudflare-network DO-to-DO calls, a delivery fetch here can hit an
// arbitrary user-supplied webhook or a slow third-party API. Without a
// bound, ONE slow/hanging delivery target would add its own latency to
// EVERY firehose consumer's next event, not just this trigger's owner.
// Matches src/webhooks.mjs's own deliverChangeEvent timeout convention
// (same 8s default).
const ALERT_DELIVERY_TIMEOUT_MS = 8000;

// The I/O shell around src/alert-delivery.mjs's pure request builders --
// constructor-injectable (see AlerterHub below) rather than a hardcoded
// call inside evaluate(), so tests can substitute a spy/failing stub
// without needing a real network, and so a future channel doesn't require
// restructuring evaluate() itself. Telegram/email degrade to a silent
// no-op when their secret isn't provisioned, matching every other optional
// integration's convention in this codebase (never throw for a
// deployment-config gap the caller can't do anything about).
export async function deliverAlertMatch(
  trigger,
  payload,
  env,
  fetchFn = fetch,
) {
  let request;
  switch (trigger.channel) {
    case "webhook":
      request = buildWebhookDeliveryRequest(trigger, payload, Date.now());
      break;
    case "discord":
      request = buildDiscordDeliveryRequest(trigger, payload);
      break;
    case "telegram":
      if (!env.TELEGRAM_BOT_TOKEN) return;
      request = buildTelegramDeliveryRequest(
        trigger,
        payload,
        env.TELEGRAM_BOT_TOKEN,
      );
      break;
    case "email":
      if (!env.RESEND_API_KEY || !env.RESEND_FROM_ADDRESS) return;
      request = buildEmailDeliveryRequest(trigger, payload, {
        resendKey: env.RESEND_API_KEY,
        fromAddress: env.RESEND_FROM_ADDRESS,
      });
      break;
    default:
      return;
  }
  // A null request means the builder itself refused (e.g.
  // buildWebhookDeliveryRequest's defense-in-depth URL re-check) --
  // nothing to send.
  if (!request) return;
  // The timeout signal is applied HERE, not baked into the pure builders in
  // src/alert-delivery.mjs -- AbortSignal.timeout() starts a real wall-clock
  // timer the moment it's constructed, which that module's own header
  // comment promises never happens (no I/O, no timers, fully deterministic
  // for tests).
  const response = await fetchFn(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(ALERT_DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Never throw for a non-2xx response -- evaluate()'s .catch() only
    // guards against a REJECTED fetch (network/timeout); an HTTP-level
    // failure resolves normally, so it's logged here instead, server-side
    // only, matching this codebase's "log internals, never leak them"
    // convention.
    console.error(
      `alert delivery failed (channel=${trigger.channel}, trigger=${trigger.id}): HTTP ${response.status}`,
    );
  }
}

export class AlerterHub {
  constructor(state, env, { deliver = deliverAlertMatch } = {}) {
    this.state = state;
    this.env = env;
    this.deliver = deliver;
    this.triggers = [];
    this.triggersLoadedAt = 0;
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

  isTriggerCacheStale() {
    return (
      Date.now() - this.triggersLoadedAt > ALERTER_HUB_TRIGGER_CACHE_TTL_MS
    );
  }

  async ensureTriggersLoaded() {
    if (!this.isTriggerCacheStale()) return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.refreshTriggers().finally(() => {
        this.loadingPromise = null;
      });
    }
    return this.loadingPromise;
  }

  async refreshTriggers() {
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
        },
      );
      if (!upstream.ok) return;
      const body = await upstream.json();
      if (Array.isArray(body?.triggers)) {
        this.triggers = body.triggers;
        this.triggersLoadedAt = Date.now();
      }
    } catch {
      // Best-effort refresh -- keep serving the stale cache rather than
      // throwing out of evaluate().
    }
  }

  // Pure decision given the CURRENT cache -- exported behavior is really
  // triggerMatchesEvent (src/alert-triggers.mjs, already unit-tested);
  // this just applies it across every cached trigger.
  matchingTriggers(payload) {
    return this.triggers.filter((trigger) =>
      triggerMatchesEvent(trigger, payload),
    );
  }

  async evaluate(payload) {
    await this.ensureTriggersLoaded();
    const matched = this.matchingTriggers(payload);
    if (matched.length === 0) return { matched: 0 };

    // Every match counts toward the response (an owner querying "did this
    // fire?" wants the true answer), but only NOT-rate-limited matches
    // actually attempt delivery -- coalescing a burst into one delivery
    // per window rather than dropping the burst's own visibility.
    const now = Date.now();
    const toDeliver = [];
    let rateLimited = 0;
    for (const trigger of matched) {
      if (isDeliveryRateLimited(this.lastDeliveredAt.get(trigger.id), now)) {
        rateLimited += 1;
        continue;
      }
      this.lastDeliveredAt.set(trigger.id, now);
      toDeliver.push(trigger);
    }

    await Promise.all(
      toDeliver.map((trigger) =>
        this.deliver(trigger, payload, this.env).catch(() => {
          // A single misbehaving delivery integration must never fail the
          // evaluation response ChainFirehoseHub's broadcast() awaits.
        }),
      ),
    );

    return {
      matched: matched.length,
      trigger_ids: matched.map((t) => t.id),
      delivered: toDeliver.length,
      rate_limited: rateLimited,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/evaluate" && request.method === "POST") {
      let payload;
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
