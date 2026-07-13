// Unit tests for workers/chain-firehose-hub.mjs (#4982, ADR 0015).
//
// Every DECISION this module makes (topic parsing/matching, ingest payload
// validation, SSE framing) is a pure function, tested directly below. The
// ChainFirehoseHub class's fetch/handleIngest/broadcast and the SSE branch
// of handleSubscribe are ALSO exercised here against a stubbed `state`
// object -- ReadableStream/CountQueuingStrategy/TextEncoder are real Web
// Streams APIs under plain Node/vitest, so no Durable Object runtime is
// needed for that surface. Only the WebSocket-upgrade branch inside
// handleSubscribe (WebSocketPair/state.acceptWebSocket have no Node
// equivalent) is out of reach here -- see that branch's own /* v8 ignore */
// comment in the source and #4982's issue body.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
  CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES,
  CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS,
  CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK,
  CHAIN_FIREHOSE_TABLES,
  GRAPHQL_WS_SOCKET_TAG,
  ChainFirehoseHub,
  chainFirehoseMatchesTopics,
  createAsyncRepeater,
  formatChainFirehoseSseFrame,
  parseChainFirehoseTopics,
  validateChainEventsSubscribePayload,
  validateChainFirehoseIngestPayload,
} from "../workers/chain-firehose-hub.mjs";

// --- validateChainEventsSubscribePayload (#4983 security fix) -------------------
//
// graphql-ws's wire protocol accepts query/mutation operations over the same
// `subscribe` message as subscriptions -- unchecked, a WS client could
// execute the full read API, bypassing both the POST endpoint's rate
// limiter (never consulted for an upgraded connection) and its complexity/
// depth guards. This function is the actual fix: restrict the WS transport
// to subscription operations only, validated with the SAME rules POST uses.

test("validateChainEventsSubscribePayload: accepts a well-formed subscription operation", () => {
  const errors = validateChainEventsSubscribePayload({
    query: "subscription { chainEvents { table block_number } }",
  });
  assert.equal(errors, null);
});

test("validateChainEventsSubscribePayload: rejects a query operation (the actual security fix)", () => {
  const errors = validateChainEventsSubscribePayload({
    query: "query { subnets { total } }",
  });
  assert.ok(errors?.length);
  assert.match(errors[0].message, /Only subscription operations/);
});

test("validateChainEventsSubscribePayload: rejects a mutation operation", () => {
  const errors = validateChainEventsSubscribePayload({
    query: "mutation { __typename }",
  });
  assert.ok(errors?.length);
  assert.match(errors[0].message, /Only subscription operations/);
});

test("validateChainEventsSubscribePayload: rejects a missing/empty query", () => {
  assert.match(
    validateChainEventsSubscribePayload({})[0].message,
    /Missing required field: query/,
  );
  assert.match(
    validateChainEventsSubscribePayload({ query: "   " })[0].message,
    /Missing required field: query/,
  );
});

test("validateChainEventsSubscribePayload: rejects invalid GraphQL syntax", () => {
  const errors = validateChainEventsSubscribePayload({
    query: "subscription { not valid (",
  });
  assert.ok(errors?.length);
  assert.match(errors[0].message, /Syntax Error/);
});

test("validateChainEventsSubscribePayload: rejects an oversized query", () => {
  const errors = validateChainEventsSubscribePayload({
    query: `subscription { chainEvents { table } } # ${"x".repeat(20_000)}`,
  });
  assert.ok(errors?.length);
  assert.match(errors[0].message, /too large/);
});

test("validateChainEventsSubscribePayload: runs full schema validation (specifiedRules), rejecting an unknown field", () => {
  const errors = validateChainEventsSubscribePayload({
    query: "subscription { chainEvents { doesNotExist } }",
  });
  assert.ok(errors?.length);
  assert.match(errors[0].message, /Cannot query field/);
});

// maxDepthRule/maxComplexityRule are ALSO passed to this validate() call
// (imported from the same src/graphql.mjs as the POST endpoint's
// handleGraphQLRequest, same GRAPHQL_MAX_DEPTH/GRAPHQL_MAX_COMPLEXITY
// thresholds) -- not separately exercised here because ChainEvent is a
// flat, scalar-only type with no relationship fields to nest into, and a
// GraphQL subscription operation is restricted to exactly one root field
// (graphql-js's own SingleFieldSubscriptionsRule, part of specifiedRules),
// so neither rule is organically triggerable against this specific schema
// today. Both rules' own behavior is covered directly in
// tests/graphql.test.mjs; what matters here is that they're wired into the
// SAME validate() call as the field-existence check above, which the
// "rejects a query/mutation operation" tests above already prove runs.

// --- createAsyncRepeater (#4983) -------------------------------------------------

test("createAsyncRepeater: a push before next() is consumed on the following next()", async () => {
  const repeater = createAsyncRepeater();
  repeater.push("a");
  repeater.push("b");
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: "a", done: false });
  assert.deepEqual(await it.next(), { value: "b", done: false });
});

test("createAsyncRepeater: a next() called before any push() resolves once push() happens", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater[Symbol.asyncIterator]();
  const pending = it.next();
  repeater.push("late");
  assert.deepEqual(await pending, { value: "late", done: false });
});

test("createAsyncRepeater: end() completes a pending next() with done:true", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater[Symbol.asyncIterator]();
  const pending = it.next();
  repeater.end();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("createAsyncRepeater: next() after end() resolves done:true immediately", async () => {
  const repeater = createAsyncRepeater();
  repeater.end();
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: push() after end() is silently dropped, not queued", async () => {
  const repeater = createAsyncRepeater();
  repeater.end();
  repeater.push("too late");
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: calling end() twice is idempotent", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater[Symbol.asyncIterator]();
  const pending = it.next();
  repeater.end();
  assert.doesNotThrow(() => repeater.end());
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("createAsyncRepeater: return() ends iteration (for-await early break support)", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.return(), { value: undefined, done: true });
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: a real for-await loop consumes pushed values in order", async () => {
  const repeater = createAsyncRepeater();
  const seen = [];
  const consumer = (async () => {
    for await (const value of repeater) {
      seen.push(value);
      if (seen.length === 3) break;
    }
  })();
  repeater.push(1);
  repeater.push(2);
  repeater.push(3);
  await consumer;
  assert.deepEqual(seen, [1, 2, 3]);
});

// --- parseChainFirehoseTopics --------------------------------------------------

test("parseChainFirehoseTopics: no topics param means no filter (null)", () => {
  assert.equal(parseChainFirehoseTopics(new URLSearchParams()), null);
});

test("parseChainFirehoseTopics: parses a comma-separated known-table list", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics=blocks,extrinsics"),
  );
  assert.deepEqual([...topics].sort(), ["blocks", "extrinsics"]);
});

test("parseChainFirehoseTopics: trims whitespace around entries", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics= blocks , chain_events "),
  );
  assert.deepEqual([...topics].sort(), ["blocks", "chain_events"]);
});

test("parseChainFirehoseTopics: drops unknown table names silently", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics=blocks,not_a_real_table"),
  );
  assert.deepEqual([...topics], ["blocks"]);
});

test("parseChainFirehoseTopics: an all-unrecognized list yields an empty Set (matches nothing), not the everything-filter", () => {
  const topics = parseChainFirehoseTopics(new URLSearchParams("topics=bogus"));
  assert.deepEqual([...topics], []);
});

// --- chainFirehoseMatchesTopics -------------------------------------------------

test("chainFirehoseMatchesTopics: null topics matches every payload", () => {
  assert.equal(chainFirehoseMatchesTopics({ table: "blocks" }, null), true);
});

test("chainFirehoseMatchesTopics: an explicit Set only matches its members", () => {
  const topics = new Set(["blocks"]);
  assert.equal(chainFirehoseMatchesTopics({ table: "blocks" }, topics), true);
  assert.equal(
    chainFirehoseMatchesTopics({ table: "extrinsics" }, topics),
    false,
  );
});

test("chainFirehoseMatchesTopics: an empty Set matches nothing", () => {
  assert.equal(
    chainFirehoseMatchesTopics({ table: "blocks" }, new Set()),
    false,
  );
});

// --- validateChainFirehoseIngestPayload -----------------------------------------

test("validateChainFirehoseIngestPayload: accepts a well-formed blocks payload", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "blocks",
      block_number: 8607915,
      block_hash: "0xabc",
      extrinsic_count: 3,
      event_count: 12,
      observed_at: "2026-07-12T22:00:00.000Z",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.block_number, 8607915);
});

test("validateChainFirehoseIngestPayload: accepts a well-formed chain_events payload", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "chain_events",
      block_number: 100,
      event_index: 0,
      pallet: "SubtensorModule",
      method: "NeuronRegistered",
      observed_at: "2026-07-12T22:00:00.000Z",
    }),
  );
  assert.equal(result.ok, true);
});

test("validateChainFirehoseIngestPayload: accepts a boolean field (e.g. extrinsics.success)", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "extrinsics",
      block_number: 1,
      extrinsic_index: 0,
      success: true,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.success, true);
});

test("validateChainFirehoseIngestPayload: rejects a non-string body", () => {
  assert.equal(validateChainFirehoseIngestPayload(undefined).ok, false);
  assert.equal(validateChainFirehoseIngestPayload("").ok, false);
});

test("validateChainFirehoseIngestPayload: rejects invalid JSON", () => {
  const result = validateChainFirehoseIngestPayload("not json");
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("validateChainFirehoseIngestPayload: rejects a JSON array", () => {
  const result = validateChainFirehoseIngestPayload("[1,2,3]");
  assert.equal(result.ok, false);
  assert.match(result.error, /JSON object/);
});

test("validateChainFirehoseIngestPayload: rejects an unrecognized table", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({ table: "accounts", block_number: 1 }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /table must be one of/);
});

test("validateChainFirehoseIngestPayload: rejects a missing/non-integer block_number", () => {
  assert.equal(
    validateChainFirehoseIngestPayload(JSON.stringify({ table: "blocks" })).ok,
    false,
  );
  assert.equal(
    validateChainFirehoseIngestPayload(
      JSON.stringify({ table: "blocks", block_number: "8607915" }),
    ).ok,
    false,
  );
  assert.equal(
    validateChainFirehoseIngestPayload(
      JSON.stringify({ table: "blocks", block_number: -1 }),
    ).ok,
    false,
  );
});

test("validateChainFirehoseIngestPayload: rejects an oversized string field", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "extrinsics",
      block_number: 1,
      signer: "x".repeat(300),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds the field size limit/);
});

test("validateChainFirehoseIngestPayload: rejects a nested object/array field", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({ table: "blocks", block_number: 1, nested: { a: 1 } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported value type/);
});

test("validateChainFirehoseIngestPayload: rejects a body over the size cap", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "blocks",
      block_number: 1,
      block_hash: "x".repeat(CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES),
    }),
  );
  assert.equal(result.ok, false);
});

test("validateChainFirehoseIngestPayload: null fields are accepted (skipped)", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({ table: "blocks", block_number: 1, block_hash: null }),
  );
  assert.equal(result.ok, true);
});

test("validateChainFirehoseIngestPayload: a non-finite numeric field round-trips as JSON null and is accepted (skipped), not rejected as non-finite", () => {
  // JSON.stringify emits `null` for Infinity/NaN, and JSON.parse can never
  // itself produce a non-finite number from valid syntax -- the
  // !Number.isFinite branch in the source is unreachable by construction
  // (see its own /* v8 ignore */ comment) and is not exercised here.
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "blocks",
      block_number: 1,
      extrinsic_count: Infinity,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.payload.extrinsic_count, null);
});

// --- formatChainFirehoseSseFrame -------------------------------------------------

test("formatChainFirehoseSseFrame: frames a payload as an SSE `chain` event", () => {
  const frame = formatChainFirehoseSseFrame({
    table: "blocks",
    block_number: 1,
  });
  assert.equal(
    frame,
    'event: chain\ndata: {"table":"blocks","block_number":1}\n\n',
  );
});

// --- ChainFirehoseHub: fetch/handleIngest/broadcast/SSE (Node-testable) ---------

// `graphqlWsTaggedSockets` defaults to empty -- every existing plain-firehose
// test's mock sockets are untagged, matching real state.getWebSockets(tag)
// semantics where a tag-scoped query returns only sockets accepted with
// that tag. Pass a non-empty list to simulate a socket that IS
// graphql-ws-tagged (see the hibernation-staleness tests below).
function stubState(webSockets = [], graphqlWsTaggedSockets = []) {
  return {
    getWebSockets: (tag) => {
      if (tag === undefined) return webSockets;
      if (tag === GRAPHQL_WS_SOCKET_TAG) return graphqlWsTaggedSockets;
      return [];
    },
  };
}

test("ChainFirehoseHub.fetch: 404s on an unrecognized path", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/nope"),
  );
  assert.equal(res.status, 404);
});

test("ChainFirehoseHub.fetch: GET /ingest is not routed to handleIngest (POST-only)", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/ingest", {
      method: "GET",
    }),
  );
  assert.equal(res.status, 404);
});

test("ChainFirehoseHub.handleIngest: 400s on an invalid payload without broadcasting", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  let broadcastCalls = 0;
  hub.broadcast = () => {
    broadcastCalls += 1;
  };
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/ingest", {
      method: "POST",
      body: "not json",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(broadcastCalls, 0);
});

test("ChainFirehoseHub.handleIngest: 202s and broadcasts a valid payload", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  let broadcast;
  hub.broadcast = (payload) => {
    broadcast = payload;
  };
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/ingest", {
      method: "POST",
      body: JSON.stringify({ table: "blocks", block_number: 42 }),
    }),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(broadcast.block_number, 42);
});

test("ChainFirehoseHub /subscribe (SSE): responds with a text/event-stream and an initial comment frame", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), ": connected\n\n");
  await reader.cancel();
});

test("ChainFirehoseHub /subscribe (SSE): rejects new clients at the global connection cap", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const responses = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS; i += 1) {
    const res = await hub.fetch(
      new Request("https://chain-firehose-hub.internal/subscribe"),
    );
    responses.push(res);
  }

  assert.equal(hub.sseClients.size, CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS);
  const capped = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  assert.equal(capped.status, 503);
  assert.equal(await capped.text(), "too many connections");

  await Promise.all(responses.map((res) => res.body.cancel()));
  assert.equal(hub.sseClients.size, 0);
});

test("ChainFirehoseHub /subscribe (SSE) -> broadcast: a connected client receives a matching event, not a filtered-out one", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe?topics=blocks"),
  );
  const reader = res.body.getReader();
  await reader.read(); // drain the initial ": connected" comment frame

  hub.broadcast({ table: "extrinsics", block_number: 1 }); // filtered out
  hub.broadcast({ table: "blocks", block_number: 2 }); // matches

  const { value } = await reader.read();
  assert.equal(
    new TextDecoder().decode(value),
    'event: chain\ndata: {"table":"blocks","block_number":2}\n\n',
  );
  await reader.cancel();
});

test("ChainFirehoseHub broadcast: drops a stalled SSE client instead of growing its queue unboundedly", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  // Never read from the body -- push past the CountQueuingStrategy high-water
  // mark so controller.desiredSize goes negative, then confirm broadcast
  // removes the client (checked indirectly via hub.sseClients emptying).
  assert.equal(hub.sseClients.size, 1);
  for (let i = 0; i < CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK + 5; i += 1) {
    hub.broadcast({ table: "blocks", block_number: i });
  }
  assert.equal(hub.sseClients.size, 0);
  await res.body.cancel();
});

test("ChainFirehoseHub broadcast: drops an SSE client whose enqueue throws for a reason other than backpressure", () => {
  // Injects a fake sseClients entry directly rather than driving a real
  // ReadableStream into this state -- desiredSize is non-negative (so the
  // backpressure branch above is NOT what's under test here) but enqueue
  // itself throws, exercising the catch-all cleanup as its own branch.
  const hub = new ChainFirehoseHub(stubState(), {});
  const entry = {
    topics: null,
    controller: {
      desiredSize: 1,
      enqueue: () => {
        throw new Error("stream already closed");
      },
    },
  };
  hub.sseClients.add(entry);
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(hub.sseClients.has(entry), false);
});

test("ChainFirehoseHub /subscribe (SSE): cancelling the stream removes it from sseClients", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  assert.equal(hub.sseClients.size, 1);
  await res.body.cancel();
  assert.equal(hub.sseClients.size, 0);
});

test("ChainFirehoseHub broadcast: fans out to WebSockets via the stubbed state.getWebSockets(), honoring their attached topic filter", () => {
  const sent = [];
  const ws = {
    deserializeAttachment: () => ({ topics: ["blocks"] }),
    send: (message) => sent.push(message),
  };
  const hub = new ChainFirehoseHub(stubState([ws]), {});
  hub.broadcast({ table: "extrinsics", block_number: 1 });
  hub.broadcast({ table: "blocks", block_number: 2 });
  assert.deepEqual(sent, [
    JSON.stringify({ table: "blocks", block_number: 2 }),
  ]);
});

test("ChainFirehoseHub broadcast: a WebSocket with no attachment (null topics) receives everything", () => {
  const sent = [];
  const ws = {
    deserializeAttachment: () => null,
    send: (message) => sent.push(message),
  };
  const hub = new ChainFirehoseHub(stubState([ws]), {});
  hub.broadcast({ table: "chain_events", block_number: 3 });
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub broadcast: a WebSocket whose deserializeAttachment throws is treated as unfiltered, not crashed", () => {
  const sent = [];
  const ws = {
    deserializeAttachment: () => {
      throw new Error("boom");
    },
    send: (message) => sent.push(message),
  };
  const hub = new ChainFirehoseHub(stubState([ws]), {});
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub broadcast: a WebSocket whose send() throws (dead socket) doesn't stop the rest of the fanout", () => {
  const sent = [];
  const dead = {
    deserializeAttachment: () => null,
    send: () => {
      throw new Error("socket closed");
    },
  };
  const alive = {
    deserializeAttachment: () => null,
    send: (message) => sent.push(message),
  };
  const hub = new ChainFirehoseHub(stubState([dead, alive]), {});
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub.webSocketMessage: a no-op for a plain firehose socket (not registered in graphqlWsSockets)", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  await assert.doesNotReject(() => hub.webSocketMessage({}, "ignored"));
});

test("ChainFirehoseHub.webSocketMessage: routes to the graphql-ws onMessage callback registered for that socket, decoding a binary frame", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const ws = {};
  const received = [];
  hub.graphqlWsSockets.set(ws, {
    onMessageCb: async (text) => {
      received.push(text);
    },
  });
  await hub.webSocketMessage(ws, '{"type":"ping"}');
  await hub.webSocketMessage(ws, new TextEncoder().encode('{"type":"pong"}'));
  assert.deepEqual(received, ['{"type":"ping"}', '{"type":"pong"}']);
});

test("ChainFirehoseHub.webSocketClose: closes the socket, swallowing an already-closed error", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  let closedWith;
  hub.webSocketClose({ close: (c, r) => (closedWith = [c, r]) }, 1000, "bye");
  assert.deepEqual(closedWith, [1000, "bye"]);
  assert.doesNotThrow(() =>
    hub.webSocketClose(
      {
        close: () => {
          throw new Error("already closed");
        },
      },
      1000,
      "bye",
    ),
  );
});

test("ChainFirehoseHub.webSocketClose: calls the graphql-ws closed() cleanup and removes the socket entry", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const ws = { close: () => {} };
  let closedWith;
  hub.graphqlWsSockets.set(ws, {
    closedCb: (code, reason) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketClose(ws, 1000, "bye");
  assert.deepEqual(closedWith, [1000, "bye"]);
  assert.equal(hub.graphqlWsSockets.has(ws), false);
});

test("ChainFirehoseHub.webSocketError: a no-op for a plain firehose socket", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  assert.doesNotThrow(() => hub.webSocketError({}, new Error("boom")));
});

test("ChainFirehoseHub.webSocketError: calls the graphql-ws closed() cleanup with an internal-error close code", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const ws = {};
  let closedWith;
  hub.graphqlWsSockets.set(ws, {
    closedCb: (code, reason) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketError(ws, new Error("boom"));
  assert.deepEqual(closedWith, [1011, "boom"]);
  assert.equal(hub.graphqlWsSockets.has(ws), false);
});

test("ChainFirehoseHub.webSocketError: falls back to a generic reason when no error/message is given", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const ws = {};
  let closedWith;
  hub.graphqlWsSockets.set(ws, {
    closedCb: (code, reason) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketError(ws);
  assert.deepEqual(closedWith, [1011, "internal error"]);
});

// --- subscribeChainEvents / unsubscribeChainEvents / broadcast (#4983) ----------

test("ChainFirehoseHub.subscribeChainEvents: broadcast delivers matching payloads to the returned repeater", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const repeater = hub.subscribeChainEvents(new Set(["blocks"]));
  hub.broadcast({ table: "extrinsics", block_number: 1 }); // filtered out
  hub.broadcast({ table: "blocks", block_number: 2 }); // matches
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), {
    value: { table: "blocks", block_number: 2 },
    done: false,
  });
});

test("ChainFirehoseHub.subscribeChainEvents: null topics receives every table", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const repeater = hub.subscribeChainEvents(null);
  hub.broadcast({ table: "chain_events", block_number: 1 });
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), {
    value: { table: "chain_events", block_number: 1 },
    done: false,
  });
});

test("ChainFirehoseHub.unsubscribeChainEvents: ends the repeater and stops further delivery", async () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const repeater = hub.subscribeChainEvents(null);
  assert.equal(hub.chainEventSubscribers.size, 1);
  hub.unsubscribeChainEvents(repeater);
  assert.equal(hub.chainEventSubscribers.size, 0);
  const it = repeater[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("ChainFirehoseHub.unsubscribeChainEvents: a non-matching repeater in a NON-empty set leaves the real entry intact", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  hub.subscribeChainEvents(null); // one real entry, so the loop body actually runs
  const foreign = { end() {} };
  hub.unsubscribeChainEvents(foreign);
  assert.equal(hub.chainEventSubscribers.size, 1);
});

test("ChainFirehoseHub.unsubscribeChainEvents: unsubscribing a repeater not in the set is a no-op", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  const foreign = { end() {} };
  assert.doesNotThrow(() => hub.unsubscribeChainEvents(foreign));
});

test("ChainFirehoseHub.broadcast: a REGISTERED graphql-ws-tagged WebSocket is excluded from the plain firehose send() loop", () => {
  const sent = [];
  const ws = { deserializeAttachment: () => null };
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), {});
  hub.graphqlWsSockets.set(ws, { onMessageCb: async () => {} });
  ws.send = (message) => sent.push(message); // would fail the test if called
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 0);
});

// --- Hibernation-survival staleness (Bug 1, found by adversarial review) --------
//
// A Durable Object is reconstructed from scratch (constructor runs again) on
// every hibernation wake / idle eviction / Worker redeploy. The WebSocket
// objects themselves survive (state.getWebSockets(), tag included), but
// graphqlWsSockets/graphqlWsServer are fresh, in-memory-only state that does
// NOT. A socket tagged graphql-ws at accept time but absent from the fresh
// graphqlWsSockets WeakMap is exactly that scenario -- these tests assert it
// gets closed (forcing a clean client reconnect) rather than silently
// misrouted through the plain-firehose send path (wire-protocol corruption)
// or having its messages silently dropped.

test("ChainFirehoseHub.broadcast: a STALE graphql-ws-tagged WebSocket (tagged but unregistered) is closed, not sent to or silently skipped", () => {
  const sent = [];
  let closedWith;
  const ws = {
    deserializeAttachment: () => null,
    send: (message) => sent.push(message),
    close: (code, reason) => {
      closedWith = [code, reason];
    },
  };
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), {});
  // Deliberately NOT registered in hub.graphqlWsSockets -- simulates a
  // post-hibernation-reconstruction instance that never re-opened it.
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 0);
  assert.equal(closedWith[0], 1012);
});

test("ChainFirehoseHub.webSocketMessage: a STALE graphql-ws-tagged WebSocket is closed rather than silently dropping the message", async () => {
  let closedWith;
  const ws = {
    close: (code, reason) => {
      closedWith = [code, reason];
    },
  };
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), {});
  await hub.webSocketMessage(ws, "some graphql-ws protocol message");
  assert.equal(closedWith[0], 1012);
});

test("ChainFirehoseHub.webSocketMessage: an untagged (genuinely plain) socket with no graphqlWsSockets entry stays a silent no-op", async () => {
  const ws = { close: () => assert.fail("should not be closed") };
  const hub = new ChainFirehoseHub(stubState([ws]), {}); // not tagged
  await assert.doesNotReject(() => hub.webSocketMessage(ws, "ignored"));
});

test("ChainFirehoseHub.isGraphqlWsTaggedSocket / closeStaleGraphqlWsSocket: direct unit coverage", () => {
  const ws = { close: () => {} };
  const taggedHub = new ChainFirehoseHub(stubState([ws], [ws]), {});
  assert.equal(taggedHub.isGraphqlWsTaggedSocket(ws), true);
  const untaggedHub = new ChainFirehoseHub(stubState([ws]), {});
  assert.equal(untaggedHub.isGraphqlWsTaggedSocket(ws), false);
  assert.doesNotThrow(() => taggedHub.closeStaleGraphqlWsSocket(ws));
  assert.doesNotThrow(() =>
    taggedHub.closeStaleGraphqlWsSocket({
      close: () => {
        throw new Error("already closed");
      },
    }),
  );
});

// --- CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS (Finding 1, found by adversarial review) --

test("ChainFirehoseHub.subscribeChainEvents: returns null (not a repeater) once at CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS; i += 1) {
    assert.notEqual(hub.subscribeChainEvents(null), null);
  }
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  );
  assert.equal(hub.subscribeChainEvents(null), null);
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  );
});

test("GRAPHQL_WS_SOCKET_TAG is the documented tag string", () => {
  assert.equal(GRAPHQL_WS_SOCKET_TAG, "graphql-ws");
});

test("CHAIN_FIREHOSE_INGEST_TOKEN_HEADER and CHAIN_FIREHOSE_TABLES are the documented constants", () => {
  assert.equal(
    CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
    "x-chain-firehose-sync-token",
  );
  assert.deepEqual([...CHAIN_FIREHOSE_TABLES].sort(), [
    "blocks",
    "chain_events",
    "extrinsics",
  ]);
});
