// ChainFirehoseHub -- the realtime chain-event fanout (#4982, ADR 0015,
// docs/realtime-firehose.md). The first Durable Object in this codebase.
//
// One global instance (idFromName("global")) receives #4980's NOTIFY
// payloads from the #4981 box-side relay on an authenticated internal
// endpoint and fans each one out to connected clients over SSE and
// WebSocket. Reached only through workers/api.mjs's CHAIN_FIREHOSE_HUB
// binding -- a Durable Object is never internet-addressable on its own, so
// every auth check lives in workers/api.mjs (handleChainFirehoseIngest),
// not here.
//
// This module is split in two for testability: the functions below make
// every actual decision (topic filtering, payload validation, SSE framing)
// and are plain, pure, unit-tested code. The ChainFirehoseHub class at the
// bottom is thin runtime glue over the Durable Object / WebSocket
// hibernation APIs (state.acceptWebSocket, ReadableStream controllers,
// WebSocketPair) -- none of which this repo's plain-vitest harness can drive
// (no @cloudflare/vitest-pool-workers / Miniflare here). Per #4982's own
// issue body ("note any coverage gap explicitly rather than skipping
// silently"), that glue is marked with an explicit /* v8 ignore */ block
// rather than pretending it's covered.
//
// GraphQL subscriptions (#4983) are a second WS "mode" on this SAME class --
// negotiated via Sec-WebSocket-Protocol: graphql-transport-ws on the SAME
// /subscribe path the plain firehose WS uses, not a separate DO or a second
// event pipeline (matches #4983's own issue body: "a thin protocol adapter
// on top of the existing hub"). See handleSubscribe/webSocketMessage/
// webSocketClose's graphql-ws branches, and src/graphql.mjs's
// GRAPHQL_SUBSCRIPTION_CONTEXT_KEY for the other half of the wiring.

import {
  GraphQLError,
  execute,
  getOperationAST,
  parse,
  specifiedRules,
  subscribe,
  validate,
} from "graphql";
import { GRAPHQL_TRANSPORT_WS_PROTOCOL, makeServer } from "graphql-ws";
import {
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_QUERY_BYTES,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_SUBSCRIPTION_CONTEXT_KEY,
  maxComplexityRule,
  maxDepthRule,
  schema as chainEventsGraphqlSchema,
} from "../src/graphql.mjs";
import { MCP_CHAIN_STREAM_RESOURCE_URI } from "./mcp-session-hub.mjs";

export const CHAIN_FIREHOSE_INGEST_TOKEN_HEADER = "x-chain-firehose-sync-token";

// Matches deploy/postgres/schema.sql's notify_chain_firehose() trigger --
// the only three tables it ever fires `table:` for.
export const CHAIN_FIREHOSE_TABLES = new Set([
  "blocks",
  "extrinsics",
  "chain_events",
]);

// Headroom over Postgres's 8000-byte NOTIFY payload cap (the trigger's own
// payload is already far smaller than this -- see the trigger's comment).
export const CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES = 16_000;

// Per-field string length bound -- generous over every string field the
// trigger actually emits (call_module/call_function/pallet/method/signer/
// block_hash), catching a malformed or hostile ingest payload as a clean 400
// rather than an oversized SSE frame reaching every connected client.
export const CHAIN_FIREHOSE_MAX_FIELD_STRING_BYTES = 256;

// SSE: how many queued-but-unflushed frames a client may accumulate (via the
// stream's CountQueuingStrategy) before it's treated as stalled and dropped.
// Hard caps on concurrent clients this hub instance accepts bound the DO's
// worst-case fanout set. Cloudflare's WebSocket object exposes no confirmed,
// documented backpressure signal (no verified `bufferedAmount` equivalent for
// hibernatable sockets), so a per-message byte watermark isn't a reliable WS
// primitive here; the connection cap plus per-send try/catch are the bounds.
export const CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK = 64;
export const CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS = 1000;
export const CHAIN_FIREHOSE_MAX_WS_CONNECTIONS = 1000;

// graphql-ws multiplexes many independent `subscribe` operations over ONE
// WebSocket connection (the library only rejects a *duplicate* operation id
// on the same socket, never a total count -- confirmed against its own
// source, no size limit exists there). Without this, the WS connection cap
// above bounds sockets but not subscriptions: a single raw client speaking
// the wire protocol directly (no compliant library required) could open
// unboundedly many `chainEvents` subscriptions on one socket, each one
// costing a real execute()+send() on every future broadcast(). This is a
// GLOBAL cap (matching CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS/_WS_CONNECTIONS'
// own global-not-per-IP shape) checked in subscribeChainEvents below.
export const CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS = 1000;

// Hibernation tag distinguishing a graphql-ws socket from a plain firehose
// one -- webSocketMessage/webSocketClose/webSocketError route on
// graphqlWsSockets.has(ws) directly rather than this tag (a WeakMap lookup
// is simpler than filtering state.getWebSockets(tag) per callback), but the
// tag is still passed to state.acceptWebSocket so a future admin/debug tool
// can enumerate the two populations separately via state.getWebSockets(tag).
export const GRAPHQL_WS_SOCKET_TAG = "graphql-ws";

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

// null => no filter (every table). An empty Set means every requested topic
// was unrecognized -- the caller matches nothing, rather than silently
// falling back to "everything" for a typo'd topic name.
export function parseChainFirehoseTopics(searchParams) {
  const raw = searchParams.get("topics");
  if (!raw) return null;
  const requested = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const matched = requested.filter((entry) => CHAIN_FIREHOSE_TABLES.has(entry));
  return new Set(matched);
}

export function chainFirehoseMatchesTopics(payload, topics) {
  if (topics === null || topics === undefined) return true;
  return topics.has(payload?.table);
}

// Validates a raw ingest body against the shape notify_chain_firehose()
// actually emits. Deliberately loose on which optional fields are present
// (the three tables carry different columns) but strict on: valid JSON, a
// known `table`, a well-formed `block_number`, and every field being a
// bounded scalar (never nested JSON) -- an oversized or malformed payload is
// rejected here as a clean 400 rather than reaching SSE/WS fanout.
export function validateChainFirehoseIngestPayload(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "request body must be a non-empty JSON string" };
  }
  if (utf8ByteLength(raw) > CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES) {
    return {
      ok: false,
      error: `request body exceeds ${CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES} bytes`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "request body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  if (!CHAIN_FIREHOSE_TABLES.has(parsed.table)) {
    return {
      ok: false,
      error: `table must be one of ${[...CHAIN_FIREHOSE_TABLES].join(", ")}`,
    };
  }
  if (!Number.isInteger(parsed.block_number) || parsed.block_number < 0) {
    return { ok: false, error: "block_number must be a non-negative integer" };
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) continue;
    if (typeof value === "string") {
      if (utf8ByteLength(value) > CHAIN_FIREHOSE_MAX_FIELD_STRING_BYTES) {
        return { ok: false, error: `${key} exceeds the field size limit` };
      }
      continue;
    }
    if (typeof value === "number") {
      /* v8 ignore next 3 -- defensive: JSON.parse can never produce a
         non-finite number (Infinity/NaN aren't valid JSON syntax; malformed
         text fails at the JSON.parse call above instead) */
      if (!Number.isFinite(value)) {
        return { ok: false, error: `${key} must be a finite number` };
      }
      continue;
    }
    if (typeof value === "boolean") continue;
    return { ok: false, error: `${key} has an unsupported value type` };
  }
  return { ok: true, payload: parsed };
}

export function formatChainFirehoseSseFrame(payload) {
  return `event: chain\ndata: ${JSON.stringify(payload)}\n\n`;
}

// graphql-ws's wire protocol accepts ANY operation type over the same
// `subscribe` message -- query and mutation included, not just subscription
// (a real client can send `subscription { __typename }`-shaped envelopes
// carrying a query/mutation document just as easily). Left unchecked, that
// would let a client execute the full read API over this WS transport,
// bypassing BOTH /api/v1/graphql POST's rate limiter (graphqlRateLimited,
// workers/api.mjs -- never consulted for an upgraded connection) and its
// complexity/depth guards (this function reuses the SAME maxDepthRule/
// maxComplexityRule graphql.mjs's POST handler applies, rather than
// defaulting to graphql-ws's bare specifiedRules). Restricting this
// transport to subscription operations only is the actual fix for both --
// wired into makeServer's onSubscribe below. Pure and unit-tested directly
// (no WS connection needed): returns null when the payload is valid, or a
// non-empty GraphQLError[] describing why it was rejected.
export function validateChainEventsSubscribePayload(payload) {
  const query = payload?.query;
  if (typeof query !== "string" || !query.trim()) {
    return [new GraphQLError("Missing required field: query.")];
  }
  if (new TextEncoder().encode(query).length > GRAPHQL_MAX_QUERY_BYTES) {
    return [new GraphQLError("GraphQL query is too large.")];
  }
  let document;
  try {
    document = parse(query);
  } catch (err) {
    return [new GraphQLError(err.message)];
  }
  const operation = getOperationAST(document, payload.operationName);
  if (!operation || operation.operation !== "subscription") {
    return [
      new GraphQLError(
        "Only subscription operations are supported over this WebSocket transport; use POST /api/v1/graphql for queries and mutations.",
      ),
    ];
  }
  const validationErrors = validate(chainEventsGraphqlSchema, document, [
    ...specifiedRules,
    maxDepthRule(GRAPHQL_MAX_DEPTH),
    maxComplexityRule(GRAPHQL_MAX_COMPLEXITY),
  ]);
  return validationErrors.length > 0 ? validationErrors : null;
}

// A minimal push-based async iterator: push() delivers a value to whichever
// `next()` call is currently pending (or buffers it if none is), end()
// terminates the sequence. Backs the GraphQL `chainEvents` subscription field
// (#4983, src/graphql.mjs's chainEventsSubscribe) -- graphql-js's subscribe()
// consumes this the same way it would any other AsyncIterable subscription
// source. No dependency on graphql/graphql-ws/the DO runtime, so it's fully
// unit-tested on its own.
export function createAsyncRepeater() {
  const pending = [];
  let waitingResolve = null;
  let finished = false;
  return {
    push(value) {
      if (finished) return;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve({ value, done: false });
      } else {
        pending.push(value);
      }
    },
    end() {
      if (finished) return;
      finished = true;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift(), done: false });
          }
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waitingResolve = resolve;
          });
        },
        return() {
          finished = true;
          waitingResolve = null;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// Only the WebSocket-upgrade branch of handleSubscribe below needs a real
// Durable Object runtime (WebSocketPair/state.acceptWebSocket have no Node
// equivalent -- no @cloudflare/vitest-pool-workers/Miniflare in this repo,
// see this module's header comment). Everything else on this class --
// fetch's routing, handleIngest, the SSE branch of handleSubscribe,
// webSocketMessage/Close/Error, and broadcast's fanout to both SSE clients
// and a stubbed state.getWebSockets() -- runs and is unit-tested under plain
// Node/vitest (ReadableStream/CountQueuingStrategy/TextEncoder are real Web
// Streams APIs there), so only that one branch is /* v8 ignore */-marked
// below, not the whole class -- see #4982's issue body ("note any coverage
// gap explicitly rather than skipping silently").
export class ChainFirehoseHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sseClients = new Set();
    // #4983: GraphQL subscriptions over WS, negotiated via
    // Sec-WebSocket-Protocol on the SAME /subscribe path -- see the class
    // header comment. chainEventSubscribers holds active createAsyncRepeater()
    // instances (one per live `chainEvents` subscription, keyed indirectly
    // via topics); graphqlWsSockets maps a hibernated WebSocket -> the
    // graphql-ws callbacks registered for it (onMessage from the adapter's
    // own onMessage() registration, closed from Server.opened()'s return
    // value) since hibernation delivers messages/close events through this
    // class's own webSocketMessage/webSocketClose, not socket-level listeners.
    this.chainEventSubscribers = new Set();
    this.graphqlWsSockets = new WeakMap();
    // #4983 MCP half: the most recent broadcast payload, for the
    // metagraph://chain/stream MCP resource's resources/read (a pointer/
    // notification-only protocol -- the client always re-reads current state
    // rather than the notification carrying it, see notifyMcpSessions).
    // mcpSubscribedSessions holds the STRING session ids interested in that
    // one resource (not connection objects -- MCP sessions are
    // McpSessionHub, a SEPARATE Durable Object per session id, reached by
    // name, not a live handle this class holds onto).
    this.latestPayload = null;
    this.mcpSubscribedSessions = new Set();
    this.graphqlWsServer = makeServer({
      schema: chainEventsGraphqlSchema,
      execute,
      subscribe,
      // graphql-ws only invokes these once a real connection_init/subscribe
      // message lands over an actual WebSocketPair upgrade; same
      // reachability class as handleSubscribe's own v8-ignored branch.
      // validateChainEventsSubscribePayload (the actual decision logic
      // onSubscribe delegates to) is unit-tested directly.
      /* v8 ignore start */
      onSubscribe: (_ctx, _id, payload) =>
        validateChainEventsSubscribePayload(payload) || undefined,
      context: () => ({ [GRAPHQL_SUBSCRIPTION_CONTEXT_KEY]: this }),
      /* v8 ignore stop */
    });
  }

  // Registered as context.chainFirehose by graphqlWsServer above; called from
  // src/graphql.mjs's chainEventsSubscribe field resolver. Mirrors the SSE/WS
  // firehose's own topic-filter semantics (chainFirehoseMatchesTopics).
  // Returns null (not a repeater) at CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS
  // -- the resolver must throw a GraphQLError for that case, never treat
  // null as "no filter"/an empty stream.
  subscribeChainEvents(topics) {
    if (
      this.chainEventSubscribers.size >=
      CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS
    ) {
      return null;
    }
    const repeater = createAsyncRepeater();
    this.chainEventSubscribers.add({ repeater, topics });
    return repeater;
  }

  unsubscribeChainEvents(repeater) {
    for (const entry of this.chainEventSubscribers) {
      if (entry.repeater === repeater) {
        entry.repeater.end();
        this.chainEventSubscribers.delete(entry);
        return;
      }
    }
  }

  // Called by McpSessionHub (via its own /subscribe route) when a session
  // subscribes to metagraph://chain/stream, and on unsubscribe/termination.
  // Idempotent either way (Set semantics) -- a session double-subscribing or
  // unsubscribing something it never subscribed to is a harmless no-op.
  mcpSubscribeSession(sessionId) {
    this.mcpSubscribedSessions.add(sessionId);
  }

  mcpUnsubscribeSession(sessionId) {
    this.mcpSubscribedSessions.delete(sessionId);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ingest" && request.method === "POST") {
      return this.handleIngest(request);
    }
    if (url.pathname === "/subscribe") {
      return this.handleSubscribe(request, url);
    }
    if (url.pathname === "/latest") {
      return new Response(JSON.stringify({ payload: this.latestPayload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/mcp-subscribe" && request.method === "POST") {
      const { sessionId } = await request.json();
      this.mcpSubscribeSession(sessionId);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/mcp-unsubscribe" && request.method === "POST") {
      const { sessionId } = await request.json();
      this.mcpUnsubscribeSession(sessionId);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  async handleIngest(request) {
    const raw = await request.text();
    const result = validateChainFirehoseIngestPayload(raw);
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    await this.broadcast(result.payload);
    return new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }

  handleSubscribe(request, url) {
    const topics = parseChainFirehoseTopics(url.searchParams);

    /* v8 ignore start -- WebSocketPair/state.acceptWebSocket have no Node
       equivalent; see this class's header comment. */
    if (request.headers.get("upgrade") === "websocket") {
      if (
        this.state.getWebSockets().length >= CHAIN_FIREHOSE_MAX_WS_CONNECTIONS
      ) {
        return new Response("too many connections", { status: 503 });
      }
      const requestedProtocols = (
        request.headers.get("sec-websocket-protocol") || ""
      )
        .split(",")
        .map((protocol) => protocol.trim());
      const isGraphqlWs = requestedProtocols.includes(
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      if (isGraphqlWs) {
        this.state.acceptWebSocket(server, [GRAPHQL_WS_SOCKET_TAG]);
        const adapterSocket = {
          protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
          send: (data) => server.send(data),
          close: (code, reason) => server.close(code, reason),
          onMessage: (cb) => {
            const entry = this.graphqlWsSockets.get(server) || {};
            entry.onMessageCb = cb;
            this.graphqlWsSockets.set(server, entry);
          },
        };
        const closedCb = this.graphqlWsServer.opened(adapterSocket, {});
        const entry = this.graphqlWsSockets.get(server) || {};
        entry.closedCb = closedCb;
        this.graphqlWsSockets.set(server, entry);
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { "sec-websocket-protocol": GRAPHQL_TRANSPORT_WS_PROTOCOL },
        });
      }

      this.state.acceptWebSocket(server);
      server.serializeAttachment({
        topics: topics === null ? null : [...topics],
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    /* v8 ignore stop */

    if (this.sseClients.size >= CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS) {
      return new Response("too many connections", { status: 503 });
    }

    const encoder = new TextEncoder();
    const clients = this.sseClients;
    let entry;
    const stream = new ReadableStream(
      {
        start(controller) {
          entry = { controller, topics };
          clients.add(entry);
          controller.enqueue(encoder.encode(": connected\n\n"));
        },
        cancel() {
          clients.delete(entry);
        },
      },
      new CountQueuingStrategy({
        highWaterMark: CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK,
      }),
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        connection: "keep-alive",
      },
    });
  }

  // Bounds-check helper for the hibernation-survival bug described in
  // closeStaleGraphqlWsSocket's comment: is `ws` tagged graphql-ws
  // (survives hibernation/reconstruction via state.getWebSockets(tag)),
  // regardless of whether THIS DO instance's in-memory graphqlWsSockets
  // WeakMap still has a live entry for it?
  isGraphqlWsTaggedSocket(ws) {
    return this.state.getWebSockets(GRAPHQL_WS_SOCKET_TAG).includes(ws);
  }

  // A Durable Object is reconstructed from scratch (constructor runs again)
  // on every hibernation wake, idle eviction, AND on every Worker code
  // deploy -- graphqlWsSockets/chainEventSubscribers/graphqlWsServer are all
  // fresh, in-memory-only state that does NOT survive that cycle. The
  // WebSocket objects themselves DO survive (state.getWebSockets() still
  // returns them, tag included), but graphql-ws's own protocol state for
  // them (has connection_init been acked, which subscriptions are active)
  // lived only in the now-replaced graphqlWsServer and has no resumption
  // mechanism. Rather than let such a socket silently fall through to the
  // plain-firehose send path (raw JSON onto what the client expects to be a
  // framed graphql-transport-ws stream -- exactly the wire-protocol
  // corruption this class's other comments warn about) or silently drop its
  // incoming messages, close it cleanly (1012 "Service Restart" is the
  // semantically correct RFC 6455 code) so the client's own reconnect logic
  // re-establishes a fresh handshake against the current graphqlWsServer.
  closeStaleGraphqlWsSocket(ws) {
    try {
      ws.close(1012, "durable object restarted; reconnect");
    } catch {
      // already closed
    }
  }

  async webSocketMessage(ws, message) {
    // graphql-ws sockets: every incoming protocol message (connection_init,
    // subscribe, complete, ping/pong) is handled entirely by graphql-ws
    // itself via the onMessage callback its own opened() registered -- see
    // handleSubscribe's graphql-ws branch. Plain firehose sockets never send
    // meaningful messages (the topic filter is fixed at subscribe time via
    // the query string); webSocketMessage still has to exist to satisfy the
    // hibernation API contract even though that population is send-only.
    const entry = this.graphqlWsSockets.get(ws);
    if (entry?.onMessageCb) {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      await entry.onMessageCb(text);
      return;
    }
    if (this.isGraphqlWsTaggedSocket(ws)) {
      this.closeStaleGraphqlWsSocket(ws);
    }
  }

  webSocketClose(ws, code, reason) {
    const entry = this.graphqlWsSockets.get(ws);
    if (entry?.closedCb) {
      entry.closedCb(code, reason);
      this.graphqlWsSockets.delete(ws);
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws, error) {
    // Mirrors webSocketClose's graphql-ws cleanup -- Server.opened()'s
    // returned closed() callback must run on an error close too, not only a
    // clean one, or that connection's subscriptions leak. The hibernation
    // runtime prunes the socket from state.getWebSockets() itself either
    // way; there is no in-memory firehose connection list here to reconcile.
    const entry = this.graphqlWsSockets.get(ws);
    if (entry?.closedCb) {
      entry.closedCb(1011, error?.message || "internal error");
      this.graphqlWsSockets.delete(ws);
    }
  }

  async broadcast(payload) {
    this.latestPayload = payload;
    const encoder = new TextEncoder();
    for (const entry of this.sseClients) {
      if (!chainFirehoseMatchesTopics(payload, entry.topics)) continue;
      if (
        entry.controller.desiredSize !== null &&
        entry.controller.desiredSize < 0
      ) {
        // Stalled client: its queue is already over the high-water mark --
        // drop it instead of enqueueing further and growing memory.
        try {
          entry.controller.close();
        } catch {
          // already closed
        }
        this.sseClients.delete(entry);
        continue;
      }
      try {
        entry.controller.enqueue(
          encoder.encode(formatChainFirehoseSseFrame(payload)),
        );
      } catch {
        this.sseClients.delete(entry);
      }
    }

    // Computed once per broadcast (not per-socket .includes() -- O(n) not
    // O(n^2)): every socket tagged graphql-ws at accept time, regardless of
    // whether this DO instance's in-memory graphqlWsSockets still recognizes
    // it (see closeStaleGraphqlWsSocket's comment for why the two can
    // diverge after a hibernation/reconstruction cycle).
    const graphqlWsTagged = new Set(
      this.state.getWebSockets(GRAPHQL_WS_SOCKET_TAG),
    );
    for (const ws of this.state.getWebSockets()) {
      if (graphqlWsTagged.has(ws)) {
        // graphql-ws sockets are NOT plain firehose sockets -- sending a bare
        // JSON payload onto one here would corrupt the graphql-transport-ws
        // wire protocol (a real client only ever expects framed {type: "next",
        // ...} messages). A REGISTERED one's delivery goes through
        // chainEventSubscribers below instead, via graphql-js's own
        // subscribe() calling this adapter's send() with a properly framed
        // message. An UNREGISTERED-but-tagged one is stale (survived
        // hibernation, but this instance never re-opened it) -- close it
        // rather than silently misrouting or ignoring it.
        if (!this.graphqlWsSockets.has(ws)) {
          this.closeStaleGraphqlWsSocket(ws);
        }
        continue;
      }
      let topics = null;
      try {
        const attachment = ws.deserializeAttachment();
        topics = attachment?.topics ? new Set(attachment.topics) : null;
      } catch {
        // deserializeAttachment threw -- treat as unfiltered rather than
        // dropping the client outright; topics is already null above.
      }
      if (!chainFirehoseMatchesTopics(payload, topics)) continue;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // a dead socket throws here; the hibernation runtime reconciles
        // state.getWebSockets() on its own, nothing further to clean up
      }
    }

    // #4983: GraphQL `chainEvents` subscriptions -- push into every matching
    // repeater; src/graphql.mjs's chainEventsSubscribe is consuming these via
    // `for await`, and graphql-js's subscribe() takes it from there (executes
    // the rest of the selection set, frames the result, and calls the
    // graphql-ws adapter socket's send()).
    for (const entry of this.chainEventSubscribers) {
      if (!chainFirehoseMatchesTopics(payload, entry.topics)) continue;
      entry.repeater.push(payload);
    }

    // #4983 MCP half: every MCP session subscribed to metagraph://chain/stream
    // gets a pointer notification (not the payload itself -- the MCP spec's
    // notifications/resources/updated carries only a uri; the client is
    // expected to follow up with resources/read, which reads this.latestPayload
    // above). One fetch per subscribed session, awaited inline like the three
    // loops above -- handleIngest returns 202 regardless, so this is a bounded
    // latency cost, not a correctness dependency. A session DO that's
    // unreachable/erroring here doesn't fail the ingest; see the try/catch.
    if (this.mcpSubscribedSessions.size > 0 && this.env.MCP_SESSION_HUB) {
      await Promise.all(
        [...this.mcpSubscribedSessions].map(async (sessionId) => {
          try {
            const stub = this.env.MCP_SESSION_HUB.get(
              this.env.MCP_SESSION_HUB.idFromName(sessionId),
            );
            await stub.fetch("https://mcp-session-hub.internal/notify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ uri: MCP_CHAIN_STREAM_RESOURCE_URI }),
            });
          } catch {
            // best-effort -- a dead/unreachable session DO never blocks
            // ingest or the other broadcast populations above
          }
        }),
      );
    }
  }
}
