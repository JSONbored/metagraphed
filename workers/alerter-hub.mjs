// AlerterHub -- the #4984 Part 2 evaluator: a singleton Durable Object
// (idFromName("global")) that ChainFirehoseHub pings on every broadcast()
// (see that class's own ALERTER_HUB ping, mirroring the #4983 MCP-notify
// loop's exact shape -- but unconditional/global rather than per-session,
// since there is exactly one evaluator, not one per subscriber).
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
// Delivery itself (#4984 Part 3: webhook/email/telegram/discord) is
// deliberately NOT this file's concern -- deliverAlertMatch below is the
// integration point Part 3 replaces; this class only decides WHICH
// triggers matched a given event. Matches "one focused change per PR",
// the same scoping every other piece of this epic (#4981/#4982/#4983
// GraphQL/#4983 MCP) already used.
import { triggerMatchesEvent } from "../src/alert-triggers.mjs";

export const ALERTER_HUB_TRIGGER_CACHE_TTL_MS = 5 * 60 * 1000;

// Default delivery hook, called once per (trigger, matching payload) pair
// -- a no-op until #4984 Part 3 replaces its body with real channel
// dispatch. Constructor-injectable (see AlerterHub below) rather than a
// hardcoded call inside evaluate(), both so Part 3 can wire a real
// implementation without touching evaluate() itself and so tests can
// substitute a spy/failing stub to exercise the catch-wrapping resilience
// below without needing real delivery logic to exist yet.
export async function deliverAlertMatch(_trigger, _payload, _env) {
  // #4984 Part 3: webhook/email/telegram/discord dispatch + rate-limit/
  // dedup + match_count/last_matched_at bookkeeping land here.
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
    await Promise.all(
      matched.map((trigger) =>
        this.deliver(trigger, payload, this.env).catch(() => {
          // A single misbehaving delivery integration must never fail the
          // evaluation response ChainFirehoseHub's broadcast() awaits.
        }),
      ),
    );
    return { matched: matched.length, trigger_ids: matched.map((t) => t.id) };
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
