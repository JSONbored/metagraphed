// McpSessionHub -- per-session state for MCP resource subscriptions (#4983
// MCP half, ADR 0015, docs/realtime-firehose.md). One instance per
// Mcp-Session-Id (idFromName(sessionId)), minted at `initialize` by
// src/mcp-server.ts and reached only from there -- never internet-
// addressable on its own, same invariant as ChainFirehoseHub.
//
// Deliberately a SEPARATE Durable Object from ChainFirehoseHub, not a fourth
// connection population on that class. ChainFirehoseHub's existing
// populations (sseClients, plain WS, graphql-ws sockets) are each keyed by a
// live connection object the class already holds a handle to, and self-clean
// off that object's own close/error callback. MCP's resources/subscribe
// arrives on a POST that dispatches and returns in one shot, while the push
// channel is a SEPARATE, string-correlated (Mcp-Session-Id), reconnect-
// tolerant GET that can open before, after, or independently of the
// subscribe call, and resumes via Last-Event-ID after a full disconnect --
// a different lifecycle primitive than "fan out to whoever's holding a
// socket right now". ChainFirehoseHub stays the single source of truth for
// "an event happened" (see its mcpSubscribeSession/mcpUnsubscribeSession/
// the broadcast() loop that pings this class's /notify route) -- this class
// only owns session lifecycle and the one open SSE stream a session may have.
//
// #6034 extends the same session DO to also accept
// `metagraph://subnet/{netuid}/status` subscriptions. Membership for those
// URIs is registered with SubnetStatusHub (a separate singleton), mirroring
// how the chain URI registers with ChainFirehoseHub — this class still only
// owns the SSE stream + pending coalescing.
//
// SSE, not WebSocket: MCP's ratified transport (2025-06-18 spec) is
// Streamable HTTP (POST + optional SSE-over-GET); there is no ratified
// WebSocket transport (as of this writing an in-review SEP, not shipped in
// any client library this server needs to serve). Reusing this repo's own
// WS pattern here -- unlike the GraphQL half of #4983, where graphql-ws IS
// the first-class ratified transport -- would silently break every real MCP
// client. The underlying DO-hosted-connection mechanics are the same either
// way; only spec conformance decided this.
//
// Bounded stream duration, not indefinite hold: unlike WebSocket, an
// SSE-holding Durable Object has no hibernation exemption (hibernation is a
// WebSocket-only billing mechanism) -- it stays fully resident for the life
// of the stream. The MCP spec's 2025-11-25 revision (this server's declared
// latest-supported version, see MCP_PROTOCOL_VERSIONS in src/mcp-server.ts)
// explicitly added "support polling SSE streams by allowing servers to
// disconnect at will", so this class closes its stream after
// MCP_SESSION_MAX_STREAM_DURATION_MS and relies on the client reconnecting
// (with Last-Event-ID for replay) rather than holding a DO resident/billable
// indefinitely for a long-lived agent session.
//
// Split in two for testability, matching chain-firehose-hub.ts's own
// convention: the functions below are pure/unit-tested. The McpSessionHub
// class is almost ENTIRELY Node-testable too (state.storage is a plain async
// get/put KV API, ReadableStream is a real Web Streams API in Node) --
// unlike ChainFirehoseHub, nothing here needs WebSocketPair, so there is no
// v8-ignored branch in this file.

import {
  recordExceptionEvent,
  recordUsageEvent,
} from "../src/usage-telemetry.ts";

import { parseSubnetStatusResourceUri } from "../src/subnet-status-subscribe.ts";

export const MCP_CHAIN_STREAM_RESOURCE_URI = "metagraph://chain/stream";

// Spec: "MUST be globally unique and cryptographically secure... visible
// ASCII characters (0x21 to 0x7E)". Length bound is this server's own choice
// (crypto.randomUUID(), the only minting path, always produces 36 chars) --
// caps a client-supplied header at a sane bound before it's used as a
// Durable Object name, so a client can't multiply DO-name cardinality with
// an arbitrarily large string.
export const MCP_SESSION_ID_MAX_LENGTH = 128;

export function isValidMcpSessionId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MCP_SESSION_ID_MAX_LENGTH) return false;
  return /^[\x21-\x7E]+$/.test(id);
}

// How long a single GET-opened SSE stream stays open before this class
// closes it and expects the client to reconnect (see the module header's
// SSE-billing-residency note). 5 minutes: long enough that a well-behaved
// client isn't reconnecting constantly, short enough to bound worst-case DO
// residency for an abandoned/misbehaving one.
export const MCP_SESSION_MAX_STREAM_DURATION_MS = 5 * 60 * 1000;

// How long a session may sit with no subscribe/stream/touch activity before
// this class self-terminates it (via a Durable Object alarm). Bounds a
// session's total lifetime independent of whether any client ever reconnects
// its SSE stream, per the "dropped connection ≠ implicit unsubscribe, but a
// server MAY terminate at any time" spec allowance.
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

export interface ResourceUpdatedNotification {
  jsonrpc: "2.0";
  method: "notifications/resources/updated";
  params: { uri: string };
}

export function buildResourceUpdatedNotification(
  uri: string,
): ResourceUpdatedNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri },
  };
}

export function formatMcpSseEvent(
  sequence: number,
  notification: unknown,
): string {
  return `id: ${sequence}\ndata: ${JSON.stringify(notification)}\n\n`;
}

// #8997: this class was entirely uninstrumented -- no telemetry import, zero
// capture calls -- along with the other three Durable Objects. That made MCP
// session lifecycle a black box: SSE stream open/close, subscription
// lifecycle, and idle expiry were all invisible, on the one class that owns
// the streaming half of an advertised capability (MCP_CAPABILITIES declares
// resources.subscribe: true).
//
// WHAT IS DELIBERATELY NOT INSTRUMENTED: /notify. It fires once per resource
// update per subscribed session, so it is the one route here whose volume
// scales with chain activity rather than with user actions -- and this project
// is already ~30x over its PostHog free-tier allowance (#9004). Every other
// route is at most a few events per session. Lifecycle is the signal worth
// paying for; a per-event counter is not.
const SESSION_HUB_ROUTES: Record<string, string> = {
  "/register": "register",
  "/subscribe": "subscribe",
  "/unsubscribe": "unsubscribe",
  "/stream": "stream",
  "/terminate": "terminate",
};

export class McpSessionHub implements DurableObject {
  state: DurableObjectState;
  env: Env;
  subscribedUris: Set<string>;
  pendingUris: Set<string>;
  sequence: number;
  terminated: boolean;
  streamController: ReadableStreamDefaultController | null;
  streamCloseTimer: ReturnType<typeof setTimeout> | null;
  hydrated: boolean;
  sessionId: string | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.subscribedUris = new Set();
    this.pendingUris = new Set();
    this.sequence = 0;
    this.terminated = false;
    this.streamController = null;
    this.streamCloseTimer = null;
    this.hydrated = false;
    // A Durable Object cannot recover the string it was named with
    // (idFromName is one-way -- there is no idToName) -- every route that
    // learns this session's id persists it here so alarm() (which has no
    // caller to hand it one) can still tell ChainFirehoseHub which session
    // to forget on idle-timeout.
    this.sessionId = null;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const stored = await this.state.storage.get<
      string | string[] | number | boolean
    >(["sessionId", "subscribedUris", "pendingUris", "sequence", "terminated"]);
    this.sessionId = (stored.get("sessionId") as string | undefined) || null;
    this.subscribedUris = new Set(
      (stored.get("subscribedUris") as string[] | undefined) || [],
    );
    // pendingUris was the one session field never persisted or hydrated, so a
    // DO eviction between /notify and the next GET /stream discarded the
    // coalesced notification the flush loop exists to replay -- the client was
    // never told the resource changed and never re-read.
    this.pendingUris = new Set(
      (stored.get("pendingUris") as string[] | undefined) || [],
    );
    this.sequence = (stored.get("sequence") as number | undefined) || 0;
    this.terminated =
      (stored.get("terminated") as boolean | undefined) || false;
    this.hydrated = true;
  }

  async persist(): Promise<void> {
    await this.state.storage.put({
      sessionId: this.sessionId,
      subscribedUris: [...this.subscribedUris],
      pendingUris: [...this.pendingUris],
      sequence: this.sequence,
      terminated: this.terminated,
    });
  }

  async touch(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + MCP_SESSION_IDLE_TTL_MS);
  }

  /**
   * Fire-and-forget telemetry. A Durable Object has no ExecutionContext, so
   * this uses DurableObjectState.waitUntil when the runtime provides it and
   * otherwise lets the promise run detached -- never awaited, and never able
   * to fail the session operation that produced it.
   */
  private emit(record: () => Promise<unknown>): void {
    try {
      const pending = Promise.resolve(record()).catch(() => false);
      (
        this.state as unknown as {
          waitUntil?: (p: Promise<unknown>) => void;
        }
      ).waitUntil?.(pending);
    } catch {
      // Telemetry must never surface into the session path.
    }
  }

  private recordRoute(route: string, ok: boolean, startedAt: number): void {
    this.emit(() =>
      recordUsageEvent(this.env, {
        route: `mcp-session-hub:${route}`,
        ok,
        durationMs: Date.now() - startedAt,
      }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    const startedAt = Date.now();
    // Closed set, from the table above -- the pathname is internal, but a
    // label built from a URL is exactly the unbounded-cardinality shape #9001
    // removed elsewhere, and "internal today" is not a property that stays
    // true by itself.
    const routeLabel = SESSION_HUB_ROUTES[url.pathname];

    if (this.terminated && url.pathname !== "/notify") {
      // A notification for an already-terminated session is a harmless,
      // silently-dropped race (ChainFirehoseHub's mcpSubscribedSessions
      // hadn't yet been told to forget this session) -- every OTHER route
      // (subscribe/unsubscribe/stream/terminate) is a real client action
      // against a session that no longer exists.
      // A real client action against a session that no longer exists -- the
      // one 404 here that means something went wrong for a caller.
      if (routeLabel) this.recordRoute(routeLabel, false, startedAt);
      return new Response(JSON.stringify({ error: "session terminated" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const handled = async (): Promise<Response | null> => {
      if (url.pathname === "/register" && request.method === "POST") {
        return this.handleRegister(request);
      }
      if (url.pathname === "/subscribe" && request.method === "POST") {
        return this.handleSubscribe(request);
      }
      if (url.pathname === "/unsubscribe" && request.method === "POST") {
        return this.handleUnsubscribe(request);
      }
      if (url.pathname === "/stream" && request.method === "GET") {
        return this.handleStream(url);
      }
      if (url.pathname === "/terminate" && request.method === "POST") {
        return this.handleTerminate(request);
      }
      return null;
    };

    // /notify stays outside the instrumented path entirely (see the comment on
    // SESSION_HUB_ROUTES) -- it is not merely unlabelled, it is not timed.
    if (url.pathname === "/notify" && request.method === "POST") {
      return this.handleNotify(request);
    }

    const response = await handled();
    if (!response) return new Response("not found", { status: 404 });
    if (routeLabel) {
      this.recordRoute(routeLabel, response.status < 400, startedAt);
    }
    return response;
  }

  /**
   * Record that a session exists, without subscribing it to anything.
   *
   * Called once by `initialize`. Before this, a session was known to the hub only
   * from `resources/subscribe`, so the canonical initialize-then-GET sequence always
   * missed — and the answer to that GET is 405 ("this endpoint offers no SSE stream"),
   * which a conformant client is entitled to believe permanently. It would then never
   * re-open the stream after subscribing, and every `notifications/resources/updated`
   * would be delivered to nobody. 405 was true of the request and false of the server.
   *
   * DELETE had the same hole: terminating a session that had only ever initialized
   * returned "session not found", so a well-behaved client could not release its hub.
   *
   * Idempotent — a client may re-register a session id it already holds, and a
   * `terminated` session stays terminated rather than being resurrected by a late call.
   */
  async handleRegister(request: Request): Promise<Response> {
    const { sessionId } = (await request.json()) as { sessionId: string };
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "sessionId is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    // A client-supplied id is authority only over the DO it names, which is derived
    // from that same id -- so this can only ever register the session it IS.
    if (this.sessionId && this.sessionId !== sessionId) {
      return new Response(JSON.stringify({ error: "session mismatch" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    this.sessionId = sessionId;
    await this.persist();
    await this.touch();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleSubscribe(request: Request): Promise<Response> {
    const { sessionId, uri } = (await request.json()) as {
      sessionId: string;
      uri: string;
    };
    this.sessionId = sessionId;
    const statusNetuid = parseSubnetStatusResourceUri(uri);
    if (uri !== MCP_CHAIN_STREAM_RESOURCE_URI && statusNetuid == null) {
      return new Response(
        JSON.stringify({ error: "resource is not subscribable" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    this.subscribedUris.add(uri);
    await this.persist();
    await this.touch();
    if (uri === MCP_CHAIN_STREAM_RESOURCE_URI && this.env.CHAIN_FIREHOSE_HUB) {
      const stub = this.env.CHAIN_FIREHOSE_HUB.get(
        this.env.CHAIN_FIREHOSE_HUB.idFromName("global"),
      );
      await stub.fetch("https://chain-firehose-hub.internal/mcp-subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    }
    if (statusNetuid != null && this.env.SUBNET_STATUS_HUB) {
      const stub = this.env.SUBNET_STATUS_HUB.get(
        this.env.SUBNET_STATUS_HUB.idFromName("global"),
      );
      await stub.fetch("https://subnet-status-hub.internal/mcp-subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, netuid: statusNetuid }),
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleUnsubscribe(request: Request): Promise<Response> {
    const { sessionId, uri } = (await request.json()) as {
      sessionId: string;
      uri: string;
    };
    this.sessionId = sessionId;
    const hadChain = this.subscribedUris.has(MCP_CHAIN_STREAM_RESOURCE_URI);
    const statusNetuid = parseSubnetStatusResourceUri(uri);
    this.subscribedUris.delete(uri);
    this.pendingUris.delete(uri);
    await this.persist();
    if (
      hadChain &&
      uri === MCP_CHAIN_STREAM_RESOURCE_URI &&
      !this.subscribedUris.has(MCP_CHAIN_STREAM_RESOURCE_URI) &&
      this.env.CHAIN_FIREHOSE_HUB
    ) {
      const stub = this.env.CHAIN_FIREHOSE_HUB.get(
        this.env.CHAIN_FIREHOSE_HUB.idFromName("global"),
      );
      await stub.fetch("https://chain-firehose-hub.internal/mcp-unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    }
    if (statusNetuid != null && this.env.SUBNET_STATUS_HUB) {
      const stub = this.env.SUBNET_STATUS_HUB.get(
        this.env.SUBNET_STATUS_HUB.idFromName("global"),
      );
      await stub.fetch("https://subnet-status-hub.internal/mcp-unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, netuid: statusNetuid }),
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Called by ChainFirehoseHub.broadcast()'s MCP loop -- a pointer-only
  // notification (spec: notifications/resources/updated carries only `uri`,
  // never content; the client re-reads via resources/read). Coalesced: if no
  // stream is open right now, this only sets a flag -- a burst of chain
  // events between reads collapses to one outstanding unread marker per uri,
  // not a growing queue, since resources/read always returns CURRENT state
  // regardless of how many events fired in between.
  async handleNotify(request: Request): Promise<Response> {
    const { uri } = (await request.json()) as { uri: string };
    if (!this.subscribedUris.has(uri)) {
      return new Response(JSON.stringify({ ok: true, delivered: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (this.streamController) {
      this.deliverNow(uri);
    } else {
      this.pendingUris.add(uri);
      // Durable, because nothing holds this instance resident between /notify
      // and the client's next GET /stream: /notify does not touch() and the
      // idle alarm is 30 minutes out, so an eviction in that window used to
      // lose the marker outright.
      //
      // Only the ADD is persisted, not deliverNow's delete. Losing a delete
      // costs at most ONE duplicate notifications/resources/updated, which is
      // harmless by construction -- the notification is a pointer, and
      // resources/read always returns current state -- whereas losing an add
      // means the client is never told at all. Over-delivery is recoverable,
      // silence is not, so the write goes on the path that cannot afford loss.
      await this.persist();
    }
    return new Response(JSON.stringify({ ok: true, delivered: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  deliverNow(uri: string): void {
    // No stream to write to is a NON-delivery, and must leave the uri pending.
    // `streamController?.enqueue(...)` made it a silent no-op that still fell
    // through to the delete below, so once the flush loop's first enqueue threw
    // and nulled the controller, every REMAINING pending uri was dropped
    // instead of being kept for the next open -- the exact opposite of what the
    // catch block is written to do.
    if (!this.streamController) return;
    this.sequence += 1;
    const frame = formatMcpSseEvent(
      this.sequence,
      buildResourceUpdatedNotification(uri),
    );
    try {
      this.streamController.enqueue(new TextEncoder().encode(frame));
      this.pendingUris.delete(uri);
    } catch (error) {
      // stream already closed/errored -- leave it pending for the next open
      this.streamController = null;
      // #8997: the client silently stops receiving server-initiated messages,
      // and nothing anywhere said so. Bounded, not a storm risk: clearing
      // streamController above means handleNotify takes the pendingUris branch
      // from here on, so this fires at most once per opened stream.
      this.emit(() =>
        recordExceptionEvent(this.env, {
          error,
          route: "mcp-session-hub:deliver",
          errorCode: "upstream_unavailable",
        }),
      );
    }
  }

  async handleTerminate(request: Request): Promise<Response> {
    // Prefer the request body's sessionId (an explicit client DELETE always
    // has one); fall back to the persisted value for alarm()'s self-
    // termination call, which has no caller to hand it one -- see the
    // constructor's comment on why this class can't recover it any other
    // way. A client-supplied id is authority only after this object already
    // knows the session from resources/subscribe; otherwise DELETE must not
    // create/persist a tombstone for an arbitrary Durable Object name.
    const { sessionId } = (await request.json()) as {
      sessionId: string | null;
    };
    if (!this.sessionId || (sessionId && sessionId !== this.sessionId)) {
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const effectiveSessionId = sessionId ?? this.sessionId;
    if (!this.terminated) {
      this.terminated = true;
      if (this.streamController) {
        try {
          this.streamController.close();
        } catch {
          // already closed
        }
        this.streamController = null;
      }
      if (this.streamCloseTimer) {
        clearTimeout(this.streamCloseTimer);
        this.streamCloseTimer = null;
      }
      const hadChain = this.subscribedUris.has(MCP_CHAIN_STREAM_RESOURCE_URI);
      const hadStatus = [...this.subscribedUris].some(
        (u) => parseSubnetStatusResourceUri(u) != null,
      );
      if (hadChain && effectiveSessionId && this.env.CHAIN_FIREHOSE_HUB) {
        const stub = this.env.CHAIN_FIREHOSE_HUB.get(
          this.env.CHAIN_FIREHOSE_HUB.idFromName("global"),
        );
        await stub.fetch(
          "https://chain-firehose-hub.internal/mcp-unsubscribe",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: effectiveSessionId }),
          },
        );
      }
      if (hadStatus && effectiveSessionId && this.env.SUBNET_STATUS_HUB) {
        const stub = this.env.SUBNET_STATUS_HUB.get(
          this.env.SUBNET_STATUS_HUB.idFromName("global"),
        );
        await stub.fetch(
          "https://subnet-status-hub.internal/mcp-unsubscribe-session",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: effectiveSessionId }),
          },
        );
      }
      this.subscribedUris.clear();
      this.pendingUris.clear();
      await this.persist();
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async handleStream(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId");
    // A registered session may hold the stream open with NOTHING subscribed. That is
    // the ordinary shape of the transport: the GET channel is the server's side of the
    // connection, opened once at startup, and what it carries is decided later.
    //
    // Requiring a subscription here made the ordering load-bearing — open the stream
    // before subscribing and you got a 404, which the Worker surfaced as a 405 the
    // client was entitled to treat as final. Since a stream still costs residency, the
    // bound is unchanged: MCP_SESSION_MAX_STREAM_DURATION_MS closes it either way, and
    // the idle alarm reaps a session nobody comes back to.
    if (!this.sessionId || (sessionId && sessionId !== this.sessionId)) {
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (this.streamController) {
      return new Response(
        JSON.stringify({
          error:
            "a stream is already open for this session; only one concurrent " +
            "SSE stream per session is supported",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    void this.touch();
    const stream = new ReadableStream({
      start: (controller) => {
        this.streamController = controller;
        // Flush anything that arrived while no stream was open, coalesced
        // to one frame per uri (matches handleNotify's coalescing).
        for (const uri of this.pendingUris) {
          this.deliverNow(uri);
        }
        this.streamCloseTimer = setTimeout(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
          this.streamController = null;
          this.streamCloseTimer = null;
        }, MCP_SESSION_MAX_STREAM_DURATION_MS);
      },
      cancel: () => {
        // clearTimeout(null) is a safe no-op, and this callback can only
        // ever run while the stream is still "readable" -- which by
        // construction means streamCloseTimer is already set (start() sets
        // it synchronously before returning control to any caller) -- so an
        // unconditional clear is simpler than a defensive guard that can
        // never see a falsy value.
        this.streamController = null;
        // Cast needed because @types/node's global clearTimeout overloads
        // (auto-included repo-wide since scripts/tests run under real Node)
        // don't cleanly accept a `Timeout | null` union even though each
        // half is individually valid -- see the workers/-specifics note in
        // docs/typescript-migration-checklist.md.
        clearTimeout(this.streamCloseTimer as unknown as number);
        this.streamCloseTimer = null;
      },
    });
    void url; // reserved for a future Last-Event-ID replay-from-cursor read
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        connection: "keep-alive",
      },
    });
  }

  // Durable Object alarm handler -- fires MCP_SESSION_IDLE_TTL_MS after the
  // last touch() (subscribe or stream-open). Self-terminates an abandoned
  // session the same way an explicit DELETE would, so
  // ChainFirehoseHub.mcpSubscribedSessions never accumulates dead sessions
  // just because a client never explicitly unsubscribed/terminated.
  async alarm(): Promise<void> {
    // #9446: a DO alarm that throws is retried by the platform and recorded
    // NOWHERE -- no request to fail, no caller to notice, and this file's one
    // capture site covers `deliver` only. An alarm stuck in a retry loop is
    // therefore indistinguishable from a hub with no sessions to expire, which
    // is the state it is supposed to be in almost all the time.
    //
    // Captured and rethrown: the platform's own retry behaviour is what makes
    // a transient failure recoverable, so swallowing here would trade a
    // retried alarm for a silently skipped expiry.
    try {
      await this.hydrate();
      // Idle expiry, distinct from a client DELETE: same terminate path, but
      // the session ended because nobody came back, which is the fact worth
      // counting separately when reasoning about session lifetimes.
      const startedAt = Date.now();
      this.recordRoute("expire", true, startedAt);
      await this.handleTerminate(
        new Request("https://mcp-session-hub.internal/terminate", {
          method: "POST",
          body: JSON.stringify({ sessionId: null }),
        }),
      );
    } catch (error) {
      // Awaited bare: recordExceptionEvent is contractually
      // no-throw (it swallows transport failures and returns
      // false), so a `.catch` here would be an unreachable
      // handler -- a branch no test can cover, which is worse
      // than no branch. Same call shape as src/graphql.ts.
      await recordExceptionEvent(this.env, {
        error,
        route: "mcp-session-hub:alarm",
        errorCode: "internal_error",
      });
      throw error;
    }
  }
}
