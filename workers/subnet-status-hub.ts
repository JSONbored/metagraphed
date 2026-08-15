import {
  recordExceptionEvent,
  recordUsageEvent,
} from "../src/usage-telemetry.ts";

// SubnetStatusHub -- singleton Durable Object (idFromName("global")) that
// owns the inverted netuid → MCP-session index for
// `metagraph://subnet/{netuid}/status` subscriptions (#6034).
//
// Parallel to ChainFirehoseHub's mcpSubscribedSessions Set for the chain
// stream, but keyed by netuid so a health-probe change fans out only to
// sessions that subscribed to that subnet — never sessions × all subnets.
// Change detection itself lives in the health prober write path
// (src/subnet-status-subscribe.ts + src/health-prober.ts); this class only
// stores membership and delivers pointer-only
// notifications/resources/updated via each session's McpSessionHub /notify
// route (same shape as ChainFirehoseHub.broadcast()'s MCP loop).
//
// Deliberately a SEPARATE DO from ChainFirehoseHub: that class is the hot
// path for every chain ingest fan-out (SSE/WS/GraphQL/MCP/alerter). Health
// status changes arrive on the 15-minute cron path, not the firehose, and
// must not add work to broadcast().

import {
  buildSubnetStatusResourceUri,
  parseSubnetStatusResourceUri,
} from "../src/subnet-status-subscribe.ts";
import { badRequest, parseRequestBody } from "../src/hub-request.ts";
import {
  HubNetuidSchema,
  HubNotifyChangedBodySchema,
  HubRequiredSessionIdBodySchema,
  HubSubnetSessionBodySchema,
} from "../schemas-src/internal-wire.ts";

type NetuidIndex = Map<number, Set<string>>;
type SessionIndex = Map<string, Set<number>>;

// Pure helpers — unit-tested without spinning up the class. sessionId/netuid
// are `unknown`: every caller feeds this parsed, untrusted request-body JSON,
// so the runtime typeof/Number.isInteger guards below are load-bearing, not
// redundant with the type system.
export function addSessionSubscription(
  byNetuid: NetuidIndex,
  sessionByNetuid: SessionIndex,
  sessionId: unknown,
  netuid: unknown,
): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0)
    return;
  let sessions = byNetuid.get(netuid);
  if (!sessions) {
    sessions = new Set();
    byNetuid.set(netuid, sessions);
  }
  sessions.add(sessionId);
  let netuids = sessionByNetuid.get(sessionId);
  if (!netuids) {
    netuids = new Set();
    sessionByNetuid.set(sessionId, netuids);
  }
  netuids.add(netuid);
}

export function removeSessionSubscription(
  byNetuid: NetuidIndex,
  sessionByNetuid: SessionIndex,
  sessionId: unknown,
  netuid: unknown,
): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0)
    return;
  const sessions = byNetuid.get(netuid);
  if (sessions) {
    sessions.delete(sessionId);
    if (sessions.size === 0) byNetuid.delete(netuid);
  }
  const netuids = sessionByNetuid.get(sessionId);
  if (netuids) {
    netuids.delete(netuid);
    if (netuids.size === 0) sessionByNetuid.delete(sessionId);
  }
}

export function removeSessionEverywhere(
  byNetuid: NetuidIndex,
  sessionByNetuid: SessionIndex,
  sessionId: string,
): void {
  const netuids = sessionByNetuid.get(sessionId);
  if (!netuids) return;
  for (const netuid of [...netuids]) {
    removeSessionSubscription(byNetuid, sessionByNetuid, sessionId, netuid);
  }
}

export function serializeSubscriptionIndex(
  byNetuid: NetuidIndex,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [netuid, sessions] of byNetuid) {
    out[String(netuid)] = [...sessions].sort();
  }
  return out;
}

export function hydrateSubscriptionIndex(stored: unknown): {
  byNetuid: NetuidIndex;
  sessionByNetuid: SessionIndex;
} {
  const byNetuid: NetuidIndex = new Map();
  const sessionByNetuid: SessionIndex = new Map();
  if (!stored || typeof stored !== "object") {
    return { byNetuid, sessionByNetuid };
  }
  for (const [key, sessions] of Object.entries(stored)) {
    const netuid = Number(key);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    if (!Array.isArray(sessions)) continue;
    for (const sessionId of sessions) {
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      addSessionSubscription(byNetuid, sessionByNetuid, sessionId, netuid);
    }
  }
  return { byNetuid, sessionByNetuid };
}

export class SubnetStatusHub implements DurableObject {
  state: DurableObjectState;
  env: Env;
  byNetuid: NetuidIndex;
  sessionByNetuid: SessionIndex;
  hydrated: boolean;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.byNetuid = new Map();
    this.sessionByNetuid = new Map();
    this.hydrated = false;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const stored = await this.state.storage.get(["byNetuid"]);
    const { byNetuid, sessionByNetuid } = hydrateSubscriptionIndex(
      stored.get("byNetuid"),
    );
    this.byNetuid = byNetuid;
    this.sessionByNetuid = sessionByNetuid;
    this.hydrated = true;
  }

  async persist(): Promise<void> {
    await this.state.storage.put({
      byNetuid: serializeSubscriptionIndex(this.byNetuid),
    });
  }

  /**
   * Fire-and-forget telemetry. A Durable Object has no ExecutionContext, so
   * this uses DurableObjectState.waitUntil where the runtime provides it and
   * otherwise runs detached -- never awaited, never able to fail a
   * subscription operation.
   */
  private emitTelemetry(route: string, ok: boolean, startedAt: number): void {
    try {
      const pending = Promise.resolve(
        recordUsageEvent(this.env, {
          route: `subnet-status-hub:${route}`,
          ok,
          durationMs: Date.now() - startedAt,
        }),
      ).catch(() => false);
      this.state.waitUntil(pending);
    } catch {
      // Telemetry must never surface into the subscription path.
    }
  }

  async fetch(request: Request): Promise<Response> {
    // #9446: this class had no exception capture at all -- it imported only
    // recordUsageEvent, and that event is emitted AFTER a handler returns, so
    // a handler that threw produced neither a usage event nor an $exception.
    // A subscription hub that has started rejecting every subscribe looks,
    // from telemetry, exactly like one nobody is subscribing to.
    //
    // Rethrown unchanged: the DO's caller decides what a failure means, and
    // this only makes the failure visible.
    try {
      return await this.dispatch(request);
    } catch (error) {
      // Awaited bare: recordExceptionEvent is contractually
      // no-throw (it swallows transport failures and returns
      // false), so a `.catch` here would be an unreachable
      // handler -- a branch no test can cover, which is worse
      // than no branch. Same call shape as src/graphql.ts.
      await recordExceptionEvent(this.env, {
        error,
        route: "subnet-status-hub:fetch",
        errorCode: "internal_error",
      });
      throw error;
    }
  }

  private async dispatch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    const startedAt = Date.now();

    // #8997: subscription lifecycle only. `/notify-changed` is excluded
    // DELIBERATELY -- it fires on every subnet-status change, so its volume
    // scales with chain activity rather than with user actions, and this
    // project is ~30x over its PostHog free tier (#9004). Same call the
    // McpSessionHub instrumentation made about its own /notify route.
    //
    // Closed table, not the pathname: a label built from a URL is the
    // unbounded-cardinality shape #9001 removed elsewhere, and "internal
    // today" is not a property that stays true by itself.
    if (url.pathname === "/notify-changed" && request.method === "POST") {
      return this.handleNotifyChanged(request);
    }

    const lifecycle: Record<string, () => Promise<Response>> = {
      "/mcp-subscribe": () => this.handleSubscribe(request),
      "/mcp-unsubscribe": () => this.handleUnsubscribe(request),
      "/mcp-unsubscribe-session": () => this.handleUnsubscribeSession(request),
    };
    const handler =
      request.method === "POST" ? lifecycle[url.pathname] : undefined;
    if (handler) {
      const response = await handler();
      this.emitTelemetry(
        url.pathname.replace("/mcp-", ""),
        response.status < 400,
        startedAt,
      );
      return response;
    }
    return new Response("not found", { status: 404 });
  }

  async handleSubscribe(request: Request): Promise<Response> {
    // PARSED, NOT CAST AND RE-NARROWED (#11194). The `{ sessionId?: unknown }`
    // cast was safe -- every field was checked before use -- but it restated
    // "a session id is a non-empty string" and "a netuid is an int in range"
    // in each of the four handlers below, which is where this hub and
    // ChainFirehoseHub drifted: the same `/mcp-subscribe` path refused an
    // absent id here and accepted it there. One declared vocabulary now, in
    // schemas-src/internal-wire.ts.
    const body = await parseRequestBody(request, HubSubnetSessionBodySchema);
    if (!body) return badRequest("sessionId and netuid are required");
    // The URI spelling stays accepted: `handleSubscribe` has always resolved
    // `metagraph://subnet/{netuid}/status` here, and the schema's union is
    // what keeps that an alternate spelling rather than an unchecked cast.
    const n =
      typeof body.netuid === "number"
        ? body.netuid
        : parseSubnetStatusResourceUri(body.netuid);
    if (n === null) return badRequest("netuid required");
    addSessionSubscription(
      this.byNetuid,
      this.sessionByNetuid,
      body.sessionId,
      n,
    );
    await this.persist();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleUnsubscribe(request: Request): Promise<Response> {
    const body = await parseRequestBody(request, HubSubnetSessionBodySchema);
    // UNCHANGED SEMANTICS: an unsubscribe this hub cannot read still answers
    // ok. Unsubscribing something never subscribed is a no-op by design (the
    // Set semantics the module header describes), and a client tearing a
    // session down should not have to handle a 400 from a call whose only
    // effect is removal.
    if (body) {
      const n =
        typeof body.netuid === "number"
          ? body.netuid
          : parseSubnetStatusResourceUri(body.netuid);
      if (n !== null) {
        removeSessionSubscription(
          this.byNetuid,
          this.sessionByNetuid,
          body.sessionId,
          n,
        );
        await this.persist();
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleUnsubscribeSession(request: Request): Promise<Response> {
    const body = await parseRequestBody(
      request,
      HubRequiredSessionIdBodySchema,
    );
    if (body) {
      removeSessionEverywhere(
        this.byNetuid,
        this.sessionByNetuid,
        body.sessionId,
      );
      await this.persist();
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Called by the health prober after a real status/surface diff. Pointer-
  // only notify per (session, uri); coalescing lives in McpSessionHub.
  async handleNotifyChanged(request: Request): Promise<Response> {
    const body = await parseRequestBody(request, HubNotifyChangedBodySchema);
    // Element filtering stays HERE rather than in the schema: a prober that
    // sends one bad netuid among fifty should still deliver the other
    // forty-nine, so a bad element drops and a bad envelope declines.
    //
    // Each element is parsed against the SAME netuid bound the subscribe path
    // uses, not a hand-rolled `Number.isInteger(n) && n >= 0`. Those two
    // disagreed: the old test admitted 999999, a netuid no subscription can
    // exist for, so the fan-out looked up an index key nothing can ever write.
    const list = body
      ? [
          ...new Set(
            body.netuids
              .map((n) => HubNetuidSchema.safeParse(n))
              .flatMap((parsed) => (parsed.success ? [parsed.data] : [])),
          ),
        ]
      : [];
    if (list.length === 0 || !this.env.MCP_SESSION_HUB) {
      return new Response(JSON.stringify({ ok: true, delivered: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const tasks = [];
    for (const netuid of list) {
      const sessions = this.byNetuid.get(netuid);
      if (!sessions || sessions.size === 0) continue;
      const uri = buildSubnetStatusResourceUri(netuid);
      for (const sessionId of sessions) {
        tasks.push(
          (async () => {
            try {
              const stub = this.env.MCP_SESSION_HUB.get(
                this.env.MCP_SESSION_HUB.idFromName(sessionId),
              );
              await stub.fetch("https://mcp-session-hub.internal/notify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ uri }),
              });
              return true;
            } catch {
              return false;
            }
          })(),
        );
      }
    }
    const results = await Promise.all(tasks);
    const delivered = results.filter(Boolean).length;
    return new Response(JSON.stringify({ ok: true, delivered }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
