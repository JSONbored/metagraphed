// McpSessionHub -- per-session state for MCP resource subscriptions (#4983
// MCP half, ADR 0015, docs/realtime-firehose.md). One instance per
// Mcp-Session-Id (idFromName(sessionId)), minted at `initialize` by
// src/mcp-server.mjs and reached only from there -- never internet-
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
// latest-supported version, see MCP_PROTOCOL_VERSIONS in src/mcp-server.mjs)
// explicitly added "support polling SSE streams by allowing servers to
// disconnect at will", so this class closes its stream after
// MCP_SESSION_MAX_STREAM_DURATION_MS and relies on the client reconnecting
// (with Last-Event-ID for replay) rather than holding a DO resident/billable
// indefinitely for a long-lived agent session.
//
// Split in two for testability, matching chain-firehose-hub.mjs's own
// convention: the functions below are pure/unit-tested. The McpSessionHub
// class is almost ENTIRELY Node-testable too (state.storage is a plain async
// get/put KV API, ReadableStream is a real Web Streams API in Node) --
// unlike ChainFirehoseHub, nothing here needs WebSocketPair, so there is no
// v8-ignored branch in this file.

import { parseSubnetStatusResourceUri } from "../src/subnet-status-subscribe.mjs";

export const MCP_CHAIN_STREAM_RESOURCE_URI = "metagraph://chain/stream";

// Spec: "MUST be globally unique and cryptographically secure... visible
// ASCII characters (0x21 to 0x7E)". Length bound is this server's own choice
// (crypto.randomUUID(), the only minting path, always produces 36 chars) --
// caps a client-supplied header at a sane bound before it's used as a
// Durable Object name, so a client can't multiply DO-name cardinality with
// an arbitrarily large string.
export const MCP_SESSION_ID_MAX_LENGTH = 128;

export function isValidMcpSessionId(id) {
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

export function buildResourceUpdatedNotification(uri) {
  return {
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri },
  };
}

export function formatMcpSseEvent(sequence, notification) {
  return `id: ${sequence}\ndata: ${JSON.stringify(notification)}\n\n`;
}

export class McpSessionHub {
  constructor(state, env) {
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

  async hydrate() {
    if (this.hydrated) return;
    const stored = await this.state.storage.get([
      "sessionId",
      "subscribedUris",
      "sequence",
      "terminated",
    ]);
    this.sessionId = stored.get("sessionId") || null;
    this.subscribedUris = new Set(stored.get("subscribedUris") || []);
    this.sequence = stored.get("sequence") || 0;
    this.terminated = stored.get("terminated") || false;
    this.hydrated = true;
  }

  async persist() {
    await this.state.storage.put({
      sessionId: this.sessionId,
      subscribedUris: [...this.subscribedUris],
      sequence: this.sequence,
      terminated: this.terminated,
    });
  }

  async touch() {
    await this.state.storage.setAlarm(Date.now() + MCP_SESSION_IDLE_TTL_MS);
  }

  async fetch(request) {
    await this.hydrate();
    const url = new URL(request.url);

    if (this.terminated && url.pathname !== "/notify") {
      // A notification for an already-terminated session is a harmless,
      // silently-dropped race (ChainFirehoseHub's mcpSubscribedSessions
      // hadn't yet been told to forget this session) -- every OTHER route
      // (subscribe/unsubscribe/stream/terminate) is a real client action
      // against a session that no longer exists.
      return new Response(JSON.stringify({ error: "session terminated" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
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
    if (url.pathname === "/notify" && request.method === "POST") {
      return this.handleNotify(request);
    }
    if (url.pathname === "/terminate" && request.method === "POST") {
      return this.handleTerminate(request);
    }
    return new Response("not found", { status: 404 });
  }

  async handleSubscribe(request) {
    const { sessionId, uri } = await request.json();
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

  async handleUnsubscribe(request) {
    const { sessionId, uri } = await request.json();
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
  async handleNotify(request) {
    const { uri } = await request.json();
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
    }
    return new Response(JSON.stringify({ ok: true, delivered: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  deliverNow(uri) {
    this.sequence += 1;
    const frame = formatMcpSseEvent(
      this.sequence,
      buildResourceUpdatedNotification(uri),
    );
    try {
      this.streamController.enqueue(new TextEncoder().encode(frame));
      this.pendingUris.delete(uri);
    } catch {
      // stream already closed/errored -- leave it pending for the next open
      this.streamController = null;
    }
  }

  async handleTerminate(request) {
    // Prefer the request body's sessionId (an explicit client DELETE always
    // has one); fall back to the persisted value for alarm()'s self-
    // termination call, which has no caller to hand it one -- see the
    // constructor's comment on why this class can't recover it any other
    // way. A client-supplied id is authority only after this object already
    // knows the session from resources/subscribe; otherwise DELETE must not
    // create/persist a tombstone for an arbitrary Durable Object name.
    const { sessionId } = await request.json();
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

  async handleStream(url) {
    const sessionId = url.searchParams.get("sessionId");
    if (
      !this.sessionId ||
      (sessionId && sessionId !== this.sessionId) ||
      this.subscribedUris.size === 0
    ) {
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
    const hub = this;
    const stream = new ReadableStream({
      start(controller) {
        hub.streamController = controller;
        // Flush anything that arrived while no stream was open, coalesced
        // to one frame per uri (matches handleNotify's coalescing).
        for (const uri of hub.pendingUris) {
          hub.deliverNow(uri);
        }
        hub.streamCloseTimer = setTimeout(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
          hub.streamController = null;
          hub.streamCloseTimer = null;
        }, MCP_SESSION_MAX_STREAM_DURATION_MS);
      },
      cancel() {
        // clearTimeout(null) is a safe no-op, and this callback can only
        // ever run while the stream is still "readable" -- which by
        // construction means streamCloseTimer is already set (start() sets
        // it synchronously before returning control to any caller) -- so an
        // unconditional clear is simpler than a defensive guard that can
        // never see a falsy value.
        hub.streamController = null;
        clearTimeout(hub.streamCloseTimer);
        hub.streamCloseTimer = null;
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
  async alarm() {
    await this.hydrate();
    await this.handleTerminate(
      new Request("https://mcp-session-hub.internal/terminate", {
        method: "POST",
        body: JSON.stringify({ sessionId: null }),
      }),
    );
  }
}
