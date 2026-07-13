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
  CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES,
  CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS,
  CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK,
  CHAIN_FIREHOSE_TABLES,
  ChainFirehoseHub,
  chainFirehoseMatchesTopics,
  formatChainFirehoseSseFrame,
  parseChainFirehoseTopics,
  validateChainFirehoseIngestPayload,
} from "../workers/chain-firehose-hub.mjs";

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

function stubState(webSockets = []) {
  return { getWebSockets: () => webSockets };
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

test("ChainFirehoseHub.webSocketMessage: a no-op that never throws", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  assert.doesNotThrow(() => hub.webSocketMessage({}, "ignored"));
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

test("ChainFirehoseHub.webSocketError: a no-op that never throws", () => {
  const hub = new ChainFirehoseHub(stubState(), {});
  assert.doesNotThrow(() => hub.webSocketError({}, new Error("boom")));
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
