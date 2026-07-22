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

  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    if (url.pathname === "/mcp-subscribe" && request.method === "POST") {
      return this.handleSubscribe(request);
    }
    if (url.pathname === "/mcp-unsubscribe" && request.method === "POST") {
      return this.handleUnsubscribe(request);
    }
    if (
      url.pathname === "/mcp-unsubscribe-session" &&
      request.method === "POST"
    ) {
      return this.handleUnsubscribeSession(request);
    }
    if (url.pathname === "/notify-changed" && request.method === "POST") {
      return this.handleNotifyChanged(request);
    }
    return new Response("not found", { status: 404 });
  }

  async handleSubscribe(request: Request): Promise<Response> {
    const { sessionId, netuid } = (await request.json()) as {
      sessionId?: unknown;
      netuid?: unknown;
    };
    const n =
      typeof netuid === "number"
        ? netuid
        : parseSubnetStatusResourceUri(
            typeof netuid === "string" ? netuid : "",
          );
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return new Response(JSON.stringify({ error: "sessionId required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (n === null || !Number.isInteger(n) || n < 0) {
      return new Response(JSON.stringify({ error: "netuid required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    addSessionSubscription(this.byNetuid, this.sessionByNetuid, sessionId, n);
    await this.persist();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleUnsubscribe(request: Request): Promise<Response> {
    const { sessionId, netuid } = (await request.json()) as {
      sessionId?: unknown;
      netuid?: unknown;
    };
    if (typeof sessionId === "string" && Number.isInteger(netuid)) {
      removeSessionSubscription(
        this.byNetuid,
        this.sessionByNetuid,
        sessionId,
        netuid,
      );
      await this.persist();
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleUnsubscribeSession(request: Request): Promise<Response> {
    const { sessionId } = (await request.json()) as { sessionId?: unknown };
    if (typeof sessionId === "string") {
      removeSessionEverywhere(this.byNetuid, this.sessionByNetuid, sessionId);
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
    const { netuids } = (await request.json()) as { netuids?: unknown };
    const list = Array.isArray(netuids)
      ? [
          ...new Set(
            netuids.filter((n): n is number => Number.isInteger(n) && n >= 0),
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
