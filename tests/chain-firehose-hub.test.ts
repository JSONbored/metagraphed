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
  ALERTER_HUB_EVALUATE_TIMEOUT_MS,
  CHAIN_FIREHOSE_GRAPHQL_SUBSCRIPTION_HIGH_WATER_MARK,
  CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
  CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP,
  CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP,
  CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_SOCKET,
  CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE,
  CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES,
  CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS,
  CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK,
  CHAIN_FIREHOSE_TABLES,
  GRAPHQL_WS_SOCKET_TAG,
  ChainFirehoseHub,
  chainFirehoseMatchesTopics,
  createAsyncRepeater,
  type AsyncRepeater,
  type ChainFirehoseIngestPayload,
  formatChainFirehoseSseFrame,
  parseChainFirehoseTopics,
  validateChainEventsSubscribePayload,
  validateChainFirehoseIngestPayload,
} from "../workers/chain-firehose-hub.ts";
import { MCP_CHAIN_STREAM_RESOURCE_URI } from "../workers/mcp-session-hub.ts";
import { mockEnv, type Row } from "./row-type.ts";

// SseClientEntry/ChainEventSubscriberEntry aren't exported from the source
// module, so these reference their shape structurally through the public
// methods that accept them (mirrors the established pattern for other
// non-exported local types in this test suite).
type SseEntryLike = Parameters<ChainFirehoseHub["addSseClient"]>[0];

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
    validateChainEventsSubscribePayload({})![0].message,
    /Missing required field: query/,
  );
  assert.match(
    validateChainEventsSubscribePayload({ query: "   " })![0].message,
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
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: "a", done: false });
  assert.deepEqual(await it.next(), { value: "b", done: false });
});

test("createAsyncRepeater: a next() called before any push() resolves once push() happens", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater![Symbol.asyncIterator]();
  const pending = it.next();
  repeater.push("late");
  assert.deepEqual(await pending, { value: "late", done: false });
});

test("createAsyncRepeater: end() completes a pending next() with done:true", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater![Symbol.asyncIterator]();
  const pending = it.next();
  repeater.end();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("createAsyncRepeater: next() after end() resolves done:true immediately", async () => {
  const repeater = createAsyncRepeater();
  repeater.end();
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: push() after end() is silently dropped, not queued", async () => {
  const repeater = createAsyncRepeater();
  repeater.end();
  repeater.push("too late");
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: calling end() twice is idempotent", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater![Symbol.asyncIterator]();
  const pending = it.next();
  repeater.end();
  assert.doesNotThrow(() => repeater.end());
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("createAsyncRepeater: return() ends iteration (for-await early break support)", async () => {
  const repeater = createAsyncRepeater();
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.return!(), { value: undefined, done: true });
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: a real for-await loop consumes pushed values in order", async () => {
  const repeater = createAsyncRepeater();
  const seen: unknown[] = [];
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

test("createAsyncRepeater: defaults highWaterMark to CHAIN_FIREHOSE_GRAPHQL_SUBSCRIPTION_HIGH_WATER_MARK", async () => {
  const repeater = createAsyncRepeater();
  // Fills pending to exactly the default mark, none consumed yet -- not
  // overflowed (the check is pending.length >= highWaterMark, so the LAST of
  // these still finds room).
  for (
    let i = 0;
    i < CHAIN_FIREHOSE_GRAPHQL_SUBSCRIPTION_HIGH_WATER_MARK;
    i += 1
  ) {
    repeater.push(i);
  }
  // pending.length is now already at the mark -- this one overflows.
  repeater.push("one-more");
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: ends and calls onOverflow instead of buffering past a custom highWaterMark", async () => {
  let overflowed = false;
  const repeater = createAsyncRepeater({
    highWaterMark: 2,
    onOverflow: () => {
      overflowed = true;
    },
  });
  repeater.push("a");
  repeater.push("b");
  repeater.push("c"); // exceeds the mark -> ends instead of buffering
  assert.equal(overflowed, true);
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("createAsyncRepeater: overflow clears any already-buffered pending values", async () => {
  const repeater = createAsyncRepeater({ highWaterMark: 1 });
  repeater.push("fills-to-the-mark"); // pending.length 0 -> 1, at the mark
  repeater.push("triggers-overflow"); // pending.length already >= mark -> finish(), pending cleared
  repeater.push("dropped-after-finish"); // finished -> silent no-op
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

// --- parseChainFirehoseTopics --------------------------------------------------

test("parseChainFirehoseTopics: no topics param means no filter (null)", () => {
  assert.equal(parseChainFirehoseTopics(new URLSearchParams()), null);
});

test("parseChainFirehoseTopics: parses a comma-separated known-table list", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics=blocks,extrinsics"),
  );
  assert.deepEqual([...topics!].sort(), ["blocks", "extrinsics"]);
});

test("parseChainFirehoseTopics: trims whitespace around entries", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics= blocks , chain_events "),
  );
  assert.deepEqual([...topics!].sort(), ["blocks", "chain_events"]);
});

test("parseChainFirehoseTopics: account_events is a recognized topic (#4984 prerequisite)", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics=account_events"),
  );
  assert.deepEqual([...topics!], ["account_events"]);
});

test("parseChainFirehoseTopics: drops unknown table names silently", () => {
  const topics = parseChainFirehoseTopics(
    new URLSearchParams("topics=blocks,not_a_real_table"),
  );
  assert.deepEqual([...topics!], ["blocks"]);
});

test("parseChainFirehoseTopics: an all-unrecognized list yields an empty Set (matches nothing), not the everything-filter", () => {
  const topics = parseChainFirehoseTopics(new URLSearchParams("topics=bogus"));
  assert.deepEqual([...topics!], []);
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
  assert.equal((result.payload as Row).block_number, 8607915);
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

test("validateChainFirehoseIngestPayload: accepts a well-formed account_events payload (#4984 prerequisite)", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "account_events",
      block_number: 8608870,
      event_index: 4,
      event_kind: "Transfer",
      hotkey: "5F...",
      coldkey: "5G...",
      netuid: 7,
      amount_tao: 12.5,
      observed_at: "2026-07-13T02:00:00.000Z",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal((result.payload as Row).netuid, 7);
  assert.equal((result.payload as Row).amount_tao, 12.5);
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
  assert.equal((result.payload as Row).success, true);
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

// #6672: a JSON array is now a BATCH of payloads (closes the ingest capacity
// gap without touching the rate limit -- see CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE's
// own comment), not an automatic reject -- but each element still has to be
// a well-formed payload object.
test("validateChainFirehoseIngestPayload: rejects a JSON array of non-object elements", () => {
  const result = validateChainFirehoseIngestPayload("[1,2,3]");
  assert.equal(result.ok, false);
  assert.match(result.error, /batch\[0\]/);
  assert.match(result.error, /JSON object/);
});

test("validateChainFirehoseIngestPayload: accepts a batch array of well-formed payloads", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify([
      { table: "blocks", block_number: 1 },
      { table: "blocks", block_number: 2 },
    ]),
  );
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.payload));
  assert.equal(result.payload.length, 2);
  assert.equal(result.payload[1].block_number, 2);
});

test("validateChainFirehoseIngestPayload: rejects an empty batch array", () => {
  const result = validateChainFirehoseIngestPayload("[]");
  assert.equal(result.ok, false);
  assert.match(result.error, /must not be empty/);
});

test("validateChainFirehoseIngestPayload: rejects a batch array over CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE", () => {
  const oversized = Array.from(
    { length: CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE + 1 },
    (_, i) => ({ table: "blocks", block_number: i }),
  );
  const result = validateChainFirehoseIngestPayload(JSON.stringify(oversized));
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds/);
});

test("validateChainFirehoseIngestPayload: a batch stops at the first invalid element and reports its index", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify([
      { table: "blocks", block_number: 1 },
      { table: "not-a-real-table", block_number: 2 },
    ]),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /batch\[1\]/);
  assert.match(result.error, /table must be one of/);
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

test("validateChainFirehoseIngestPayload: rejects a body over the size cap (via the per-field cap, well under the #6672 batch-scaled raw-body cap)", () => {
  const result = validateChainFirehoseIngestPayload(
    JSON.stringify({
      table: "blocks",
      block_number: 1,
      block_hash: "x".repeat(CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds the field size limit/);
});

// #6672: the raw-body byte cap itself is now sized for a full batch
// (CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE payloads), not a single payload -- a
// body genuinely over THAT is rejected before JSON.parse is even attempted.
test("validateChainFirehoseIngestPayload: rejects a raw body over the batch-scaled byte cap", () => {
  const oversizedRaw = "x".repeat(
    CHAIN_FIREHOSE_MAX_INGEST_BODY_BYTES *
      CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE +
      1,
  );
  const result = validateChainFirehoseIngestPayload(oversizedRaw);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds \d+ bytes/);
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
  assert.equal((result.payload as Row).extrinsic_count, null);
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
function stubState(
  webSockets: Row[] = [],
  graphqlWsTaggedSockets: Row[] = [],
): DurableObjectState {
  return {
    getWebSockets: (tag?: string) => {
      if (tag === undefined) return webSockets;
      if (tag === GRAPHQL_WS_SOCKET_TAG) return graphqlWsTaggedSockets;
      return [];
    },
  } as unknown as DurableObjectState;
}

test("ChainFirehoseHub.fetch: 404s on an unrecognized path", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/nope"),
  );
  assert.equal(res.status, 404);
});

test("ChainFirehoseHub.fetch: GET /ingest is not routed to handleIngest (POST-only)", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/ingest", {
      method: "GET",
    }),
  );
  assert.equal(res.status, 404);
});

test("ChainFirehoseHub.handleIngest: 400s on an invalid payload without broadcasting", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  let broadcastCalls = 0;
  hub.broadcast = async () => {
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
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  let broadcast: Row | undefined;
  hub.broadcast = async (payload: Row) => {
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
  assert.equal(broadcast!.block_number, 42);
});

// #6672: a batch-array body broadcasts every element, in order, sequentially.
test("ChainFirehoseHub.handleIngest: 202s and broadcasts every element of a batch payload, in order", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const broadcasts: Row[] = [];
  hub.broadcast = async (payload: Row) => {
    broadcasts.push(payload);
  };
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/ingest", {
      method: "POST",
      body: JSON.stringify([
        { table: "blocks", block_number: 1 },
        { table: "blocks", block_number: 2 },
        { table: "blocks", block_number: 3 },
      ]),
    }),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(
    broadcasts.map((p) => p.block_number),
    [1, 2, 3],
  );
});

test("ChainFirehoseHub /subscribe (SSE): responds with a text/event-stream and an initial comment frame", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-store");
  // #5545: SSE responses must carry nosniff like every other response builder.
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), ": connected\n\n");
  await reader.cancel();
});

test("ChainFirehoseHub /subscribe (SSE): rejects new clients at the global connection cap", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const responses = [];
  // Spread across many distinct IPs, well under the per-IP cap each (#5004
  // item 1's dedicated tests further below cover THAT cap specifically) --
  // this test is about the pre-existing GLOBAL cap, independent of it.
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS; i += 1) {
    const res = await hub.fetch(
      new Request("https://chain-firehose-hub.internal/subscribe", {
        headers: { "cf-connecting-ip": `198.51.100.${i % 100}` },
      }),
    );
    responses.push(res);
  }

  assert.equal(hub.sseClients.size, CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS);
  const capped = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe", {
      headers: { "cf-connecting-ip": "198.51.100.250" }, // a fresh IP, nowhere near its own per-IP cap
    }),
  );
  assert.equal(capped.status, 503);
  assert.equal(await capped.text(), "too many connections");

  await Promise.all(responses.map((res) => res.body!.cancel()));
  assert.equal(hub.sseClients.size, 0);
});

test("ChainFirehoseHub /subscribe (SSE) -> broadcast: a connected client receives a matching event, not a filtered-out one", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe?topics=blocks"),
  );
  const reader = res.body!.getReader();
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
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
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
  await res.body!.cancel();
});

test("ChainFirehoseHub broadcast: drops an SSE client whose enqueue throws for a reason other than backpressure", () => {
  // Injects a fake sseClients entry directly rather than driving a real
  // ReadableStream into this state -- desiredSize is non-negative (so the
  // backpressure branch above is NOT what's under test here) but enqueue
  // itself throws, exercising the catch-all cleanup as its own branch.
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const entry = {
    topics: null,
    controller: {
      desiredSize: 1,
      enqueue: () => {
        throw new Error("stream already closed");
      },
    },
  };
  hub.sseClients.add(entry as unknown as SseEntryLike);
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(hub.sseClients.has(entry as unknown as SseEntryLike), false);
});

test("ChainFirehoseHub /subscribe (SSE): cancelling the stream removes it from sseClients", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/subscribe"),
  );
  assert.equal(hub.sseClients.size, 1);
  await res.body!.cancel();
  assert.equal(hub.sseClients.size, 0);
});

// --- SSE per-IP connection sub-quota (#5004 item 1) -------------------------------
//
// CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS is a GLOBAL cap (tested above); this is
// the per-IP sub-quota checked alongside it, so one IP can't consume the
// entire global budget in a loop. subscribeRequest below builds a real
// Request the same way every other test in this file does, just with a
// cf-connecting-ip header attached (mirroring tests/config.test.mjs's own
// fakeRequest pattern for resolveClientIp, but as a real Request since
// handleSubscribe is exercised through hub.fetch here, not called directly).
function subscribeRequest(ip: string | null, query = "") {
  return new Request(
    `https://chain-firehose-hub.internal/subscribe${query}`,
    ip ? { headers: { "cf-connecting-ip": ip } } : undefined,
  );
}

test("ChainFirehoseHub /subscribe (SSE): rejects a new client from the SAME IP at the per-IP cap, well below the global cap", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const responses = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP; i += 1) {
    responses.push(await hub.fetch(subscribeRequest("203.0.113.9")));
  }
  assert.equal(hub.sseClients.size, CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP);
  assert.ok(
    CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP < CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS,
  );

  const capped = await hub.fetch(subscribeRequest("203.0.113.9"));
  assert.equal(capped.status, 503);
  assert.equal(await capped.text(), "too many connections");
  // The per-IP cap didn't consume any of the global budget beyond this IP's
  // own connections -- the rejection is purely from sseClientsByIp, not
  // sseClients hitting CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS.
  assert.equal(hub.sseClients.size, CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP);

  await Promise.all(responses.map((res) => res.body!.cancel()));
});

test("ChainFirehoseHub /subscribe (SSE): a DIFFERENT IP is unaffected by another IP's per-IP cap", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const responses = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP; i += 1) {
    responses.push(await hub.fetch(subscribeRequest("203.0.113.9")));
  }
  const otherIp = await hub.fetch(subscribeRequest("198.51.100.4"));
  assert.equal(otherIp.status, 200);
  await Promise.all([...responses, otherIp].map((res) => res.body!.cancel()));
});

test("ChainFirehoseHub /subscribe (SSE): cancelling one connection frees that IP's slot for a new one", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const responses = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP; i += 1) {
    responses.push(await hub.fetch(subscribeRequest("203.0.113.9")));
  }
  await responses[0].body!.cancel();
  assert.equal(
    hub.sseClientsByIp.get("203.0.113.9"),
    CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP - 1,
  );

  const reconnected = await hub.fetch(subscribeRequest("203.0.113.9"));
  assert.equal(reconnected.status, 200);
  assert.equal(
    hub.sseClientsByIp.get("203.0.113.9"),
    CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP,
  );

  await Promise.all(
    [...responses.slice(1), reconnected].map((res) => res.body!.cancel()),
  );
});

test("ChainFirehoseHub /subscribe (SSE): requests with no cf-connecting-ip header share the anonymous bucket", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const responses = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP; i += 1) {
    responses.push(await hub.fetch(subscribeRequest(null)));
  }
  const capped = await hub.fetch(subscribeRequest(null));
  assert.equal(capped.status, 503);
  await Promise.all(responses.map((res) => res.body!.cancel()));
});

test("ChainFirehoseHub broadcast: dropping a stalled SSE client also releases its per-IP slot (not just sseClients)", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(subscribeRequest("203.0.113.9"));
  assert.equal(hub.sseClientsByIp.get("203.0.113.9"), 1);
  for (let i = 0; i < CHAIN_FIREHOSE_SSE_HIGH_WATER_MARK + 5; i += 1) {
    hub.broadcast({ table: "blocks", block_number: i });
  }
  assert.equal(hub.sseClients.size, 0);
  assert.equal(hub.sseClientsByIp.has("203.0.113.9"), false);
  await res.body!.cancel();
});

test("ChainFirehoseHub.addSseClient: a second connection from the same IP increments rather than overwrites the count", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.addSseClient({ ip: "203.0.113.9" } as unknown as SseEntryLike);
  hub.addSseClient({ ip: "203.0.113.9" } as unknown as SseEntryLike);
  assert.equal(hub.sseClientsByIp.get("203.0.113.9"), 2);
});

test("ChainFirehoseHub.removeSseClient: a no-op (does not throw or touch sseClientsByIp) when the entry was never registered", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  assert.doesNotThrow(() =>
    hub.removeSseClient({ ip: "203.0.113.9" } as unknown as SseEntryLike),
  );
  assert.equal(hub.sseClientsByIp.size, 0);
});

test("ChainFirehoseHub broadcast: fans out to WebSockets via the stubbed state.getWebSockets(), honoring their attached topic filter", () => {
  const sent: Row[] = [];
  const ws = {
    deserializeAttachment: () => ({ topics: ["blocks"] }),
    send: (message: Row) => sent.push(message),
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws]), mockEnv({}));
  hub.broadcast({ table: "extrinsics", block_number: 1 });
  hub.broadcast({ table: "blocks", block_number: 2 });
  assert.deepEqual(sent, [
    JSON.stringify({ table: "blocks", block_number: 2 }),
  ]);
});

test("ChainFirehoseHub broadcast: a WebSocket with no attachment (null topics) receives everything", () => {
  const sent: Row[] = [];
  const ws = {
    deserializeAttachment: () => null,
    send: (message: Row) => sent.push(message),
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws]), mockEnv({}));
  hub.broadcast({ table: "chain_events", block_number: 3 });
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub broadcast: a WebSocket whose deserializeAttachment throws is treated as unfiltered, not crashed", () => {
  const sent: Row[] = [];
  const ws = {
    deserializeAttachment: () => {
      throw new Error("boom");
    },
    send: (message: Row) => sent.push(message),
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws]), mockEnv({}));
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub broadcast: a WebSocket whose send() throws (dead socket) doesn't stop the rest of the fanout", () => {
  const sent: Row[] = [];
  const dead = {
    deserializeAttachment: () => null,
    send: () => {
      throw new Error("socket closed");
    },
  };
  const alive = {
    deserializeAttachment: () => null,
    send: (message: Row) => sent.push(message),
  };
  const hub = new ChainFirehoseHub(stubState([dead, alive]), mockEnv({}));
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 1);
});

// Sentry METAGRAPHED-3: state.getWebSockets() itself (not a per-socket op)
// threw a bare Cloudflare "internal error" under concurrent load. Unlike the
// per-socket guards above, this call had no try/catch at all -- a throw here
// used to abort the whole broadcast(), losing SSE/GraphQL/MCP/alerter
// delivery too, not just the WS population.
test("ChainFirehoseHub broadcast: state.getWebSockets() throwing doesn't crash the broadcast or drop SSE delivery", () => {
  const throwingState = {
    getWebSockets: () => {
      throw new Error("internal error; reference = deadbeef");
    },
  } as unknown as DurableObjectState;
  const sseSent: Row[] = [];
  const entry = {
    topics: null,
    controller: {
      desiredSize: 1,
      enqueue: (message: Row) => sseSent.push(message),
    },
  };
  const hub = new ChainFirehoseHub(throwingState, mockEnv({}));
  hub.sseClients.add(entry as unknown as SseEntryLike);
  assert.doesNotThrow(() =>
    hub.broadcast({ table: "blocks", block_number: 1 }),
  );
  assert.equal(sseSent.length, 1);
});

test("ChainFirehoseHub broadcast: state.getWebSockets(tag) throwing for the graphql-ws tag alone doesn't crash the broadcast", () => {
  const sent: Row[] = [];
  const ws = {
    deserializeAttachment: () => null,
    send: (message: Row) => sent.push(message),
  } as unknown as WebSocket;
  const partiallyThrowingState = {
    getWebSockets: (tag: string | undefined) => {
      if (tag === GRAPHQL_WS_SOCKET_TAG) {
        throw new Error("internal error; reference = deadbeef");
      }
      return [ws];
    },
  } as unknown as DurableObjectState;
  const hub = new ChainFirehoseHub(partiallyThrowingState, mockEnv({}));
  assert.doesNotThrow(() =>
    hub.broadcast({ table: "blocks", block_number: 1 }),
  );
  assert.equal(sent.length, 1);
});

test("ChainFirehoseHub.webSocketMessage: a no-op for a plain firehose socket (not registered in graphqlWsSockets)", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  await assert.doesNotReject(() =>
    hub.webSocketMessage({} as unknown as WebSocket, "ignored"),
  );
});

test("ChainFirehoseHub.webSocketMessage: routes to the graphql-ws onMessage callback registered for that socket, decoding a binary frame", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const ws = {} as unknown as WebSocket;
  const received: string[] = [];
  hub.graphqlWsSockets.set(ws, {
    onMessageCb: async (text: string) => {
      received.push(text);
    },
  });
  await hub.webSocketMessage(ws, '{"type":"ping"}');
  await hub.webSocketMessage(
    ws,
    new TextEncoder().encode('{"type":"pong"}').buffer as ArrayBuffer,
  );
  assert.deepEqual(received, ['{"type":"ping"}', '{"type":"pong"}']);
});

test("ChainFirehoseHub.webSocketClose: closes the socket, swallowing an already-closed error", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  let closedWith: [number | undefined, string | undefined] | undefined;
  hub.webSocketClose(
    {
      close: (c: number, r: string) => (closedWith = [c, r]),
    } as unknown as WebSocket,
    1000,
    "bye",
  );
  assert.deepEqual(closedWith, [1000, "bye"]);
  assert.doesNotThrow(() =>
    hub.webSocketClose(
      {
        close: () => {
          throw new Error("already closed");
        },
      } as unknown as WebSocket,
      1000,
      "bye",
    ),
  );
});

test("ChainFirehoseHub.webSocketClose: calls the graphql-ws closed() cleanup and removes the socket entry", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const ws = { close: () => {} } as unknown as WebSocket;
  let closedWith: [number | undefined, string | undefined] | undefined;
  hub.graphqlWsSockets.set(ws, {
    closedCb: async (code?: number, reason?: string) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketClose(ws, 1000, "bye");
  assert.deepEqual(closedWith, [1000, "bye"]);
  assert.equal(hub.graphqlWsSockets.has(ws), false);
});

test("ChainFirehoseHub.webSocketError: a no-op for a plain firehose socket", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  assert.doesNotThrow(() =>
    hub.webSocketError({} as unknown as WebSocket, new Error("boom")),
  );
});

test("ChainFirehoseHub.webSocketError: calls the graphql-ws closed() cleanup with an internal-error close code", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const ws = {} as unknown as WebSocket;
  let closedWith: [number | undefined, string | undefined] | undefined;
  hub.graphqlWsSockets.set(ws, {
    closedCb: async (code?: number, reason?: string) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketError(ws, new Error("boom"));
  assert.deepEqual(closedWith, [1011, "boom"]);
  assert.equal(hub.graphqlWsSockets.has(ws), false);
});

test("ChainFirehoseHub.webSocketError: falls back to a generic reason when no error/message is given", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const ws = {} as unknown as WebSocket;
  let closedWith: [number | undefined, string | undefined] | undefined;
  hub.graphqlWsSockets.set(ws, {
    closedCb: async (code?: number, reason?: string) => {
      closedWith = [code, reason];
    },
  });
  hub.webSocketError(ws, undefined);
  assert.deepEqual(closedWith, [1011, "internal error"]);
});

// --- releaseWsIpSlot / per-IP WS connection sub-quota (#5004 item 1) ------------
//
// The accept-time increment itself lives inside handleSubscribe's
// WebSocket-upgrade branch, which is /* v8 ignore */-marked in the source
// (WebSocketPair/state.acceptWebSocket have no Node equivalent -- same
// convention as every other WS-accept-path test gap in this file). The
// RELEASE half, though, runs inside webSocketClose/webSocketError -- both
// already exercised under plain Node/vitest above via stubbed `ws` objects
// -- so releaseWsIpSlot's branches are tested directly here the same way,
// by seeding hub.wsClientsByIp directly (mirroring how other tests in this
// file seed hub.sseClients/hub.graphqlWsSockets directly) rather than
// needing a real accept step.

test("ChainFirehoseHub.webSocketClose: releases the per-IP WS slot recorded in the socket's attachment", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.wsClientsByIp.set("203.0.113.9", 1);
  const ws = {
    deserializeAttachment: () => ({ topics: null, ip: "203.0.113.9" }),
    close: () => {},
  } as unknown as WebSocket;
  hub.webSocketClose(ws, 1000, "bye");
  assert.equal(hub.wsClientsByIp.has("203.0.113.9"), false);
});

test("ChainFirehoseHub.webSocketClose: decrements (not deletes) when other connections from the same IP remain", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.wsClientsByIp.set("203.0.113.9", 3);
  const ws = {
    deserializeAttachment: () => ({ ip: "203.0.113.9" }),
    close: () => {},
  } as unknown as WebSocket;
  hub.webSocketClose(ws, 1000, "bye");
  assert.equal(hub.wsClientsByIp.get("203.0.113.9"), 2);
});

test("ChainFirehoseHub.webSocketError: also releases the per-IP WS slot (not just webSocketClose)", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.wsClientsByIp.set("198.51.100.4", 1);
  const ws = {
    deserializeAttachment: () => ({ ip: "198.51.100.4" }),
  } as unknown as WebSocket;
  hub.webSocketError(ws, new Error("boom"));
  assert.equal(hub.wsClientsByIp.has("198.51.100.4"), false);
});

test("ChainFirehoseHub.releaseWsIpSlot: a no-op when the attachment has no ip (e.g. a legacy/malformed attachment)", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.wsClientsByIp.set("203.0.113.9", 1);
  assert.doesNotThrow(() =>
    hub.releaseWsIpSlot({
      deserializeAttachment: () => ({ topics: null }),
    } as unknown as WebSocket),
  );
  // Unrelated IP's count is untouched -- nothing to attribute the release to.
  assert.equal(hub.wsClientsByIp.get("203.0.113.9"), 1);
});

test("ChainFirehoseHub.releaseWsIpSlot: a no-op when deserializeAttachment returns null", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  assert.doesNotThrow(() =>
    hub.releaseWsIpSlot({
      deserializeAttachment: () => null,
    } as unknown as WebSocket),
  );
});

test("ChainFirehoseHub.releaseWsIpSlot: a no-op when this DO instance never recorded that IP (e.g. a socket accepted by a prior, now-replaced instance)", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  assert.doesNotThrow(() =>
    hub.releaseWsIpSlot({
      deserializeAttachment: () => ({ ip: "203.0.113.9" }),
    } as unknown as WebSocket),
  );
  assert.equal(hub.wsClientsByIp.has("203.0.113.9"), false);
});

test("ChainFirehoseHub.rebuildWsClientsByIp: reconstructs per-IP counts from surviving hibernatable WebSocket attachments", () => {
  const hub = new ChainFirehoseHub(
    stubState([
      { deserializeAttachment: () => ({ ip: "203.0.113.9" }) },
      { deserializeAttachment: () => ({ ip: "203.0.113.9", topics: null }) },
      { deserializeAttachment: () => ({ ip: "198.51.100.4" }) },
    ]),
    mockEnv({}),
  );

  hub.wsClientsByIp.set("stale-before-rebuild", 99);
  hub.rebuildWsClientsByIp();

  assert.equal(hub.wsClientsByIp.get("203.0.113.9"), 2);
  assert.equal(hub.wsClientsByIp.get("198.51.100.4"), 1);
  assert.equal(hub.wsClientsByIp.has("stale-before-rebuild"), false);
});

test("ChainFirehoseHub.rebuildWsClientsByIp: ignores malformed attachments while preserving valid counts", () => {
  const hub = new ChainFirehoseHub(
    stubState([
      { deserializeAttachment: () => ({ ip: "203.0.113.9" }) },
      { deserializeAttachment: () => ({ topics: null }) },
      { deserializeAttachment: () => null },
      {
        deserializeAttachment: () => {
          throw new Error("bad attachment");
        },
      },
    ]),
    mockEnv({}),
  );

  assert.doesNotThrow(() => hub.rebuildWsClientsByIp());
  assert.equal(hub.wsClientsByIp.size, 1);
  assert.equal(hub.wsClientsByIp.get("203.0.113.9"), 1);
});

// --- subscribeChainEvents / unsubscribeChainEvents / broadcast (#4983) ----------

test("ChainFirehoseHub.subscribeChainEvents: broadcast delivers matching payloads to the returned repeater", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = hub.subscribeChainEvents(
    new Set(["blocks"]),
    undefined,
    undefined,
  );
  hub.broadcast({ table: "extrinsics", block_number: 1 }); // filtered out
  hub.broadcast({ table: "blocks", block_number: 2 }); // matches
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), {
    value: { table: "blocks", block_number: 2 },
    done: false,
  });
});

test("ChainFirehoseHub.subscribeChainEvents: null topics receives every table", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = hub.subscribeChainEvents(null, undefined, undefined);
  hub.broadcast({ table: "chain_events", block_number: 1 });
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), {
    value: { table: "chain_events", block_number: 1 },
    done: false,
  });
});

test("ChainFirehoseHub.unsubscribeChainEvents: ends the repeater and stops further delivery", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = hub.subscribeChainEvents(null, undefined, undefined);
  assert.equal(hub.chainEventSubscribers.size, 1);
  hub.unsubscribeChainEvents(repeater!);
  assert.equal(hub.chainEventSubscribers.size, 0);
  const it = repeater![Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("ChainFirehoseHub.unsubscribeChainEvents: a non-matching repeater in a NON-empty set leaves the real entry intact", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.subscribeChainEvents(null, undefined, undefined); // one real entry, so the loop body actually runs
  const foreign = {
    end() {},
  } as unknown as AsyncRepeater<ChainFirehoseIngestPayload>;
  hub.unsubscribeChainEvents(foreign);
  assert.equal(hub.chainEventSubscribers.size, 1);
});

test("ChainFirehoseHub.unsubscribeChainEvents: unsubscribing a repeater not in the set is a no-op", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const foreign = {
    end() {},
  } as unknown as AsyncRepeater<ChainFirehoseIngestPayload>;
  assert.doesNotThrow(() => hub.unsubscribeChainEvents(foreign));
});

test("ChainFirehoseHub.broadcast: a REGISTERED graphql-ws-tagged WebSocket is excluded from the plain firehose send() loop", () => {
  const sent: Row[] = [];
  const ws = { deserializeAttachment: () => null } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), mockEnv({}));
  hub.graphqlWsSockets.set(ws, { onMessageCb: async () => {} });
  ws.send = ((message: Row) => sent.push(message)) as unknown as typeof ws.send; // would fail the test if called
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
  const sent: Row[] = [];
  let closedWith: [number | undefined, string | undefined] | undefined;
  const ws = {
    deserializeAttachment: () => null,
    send: (message: Row) => sent.push(message),
    close: (code: number, reason: string) => {
      closedWith = [code, reason];
    },
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), mockEnv({}));
  // Deliberately NOT registered in hub.graphqlWsSockets -- simulates a
  // post-hibernation-reconstruction instance that never re-opened it.
  hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(sent.length, 0);
  assert.equal(closedWith![0], 1012);
});

test("ChainFirehoseHub.webSocketMessage: a STALE graphql-ws-tagged WebSocket is closed rather than silently dropping the message", async () => {
  let closedWith: [number | undefined, string | undefined] | undefined;
  const ws = {
    close: (code: number, reason: string) => {
      closedWith = [code, reason];
    },
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws], [ws]), mockEnv({}));
  await hub.webSocketMessage(ws, "some graphql-ws protocol message");
  assert.equal(closedWith![0], 1012);
});

test("ChainFirehoseHub.webSocketMessage: an untagged (genuinely plain) socket with no graphqlWsSockets entry stays a silent no-op", async () => {
  const ws = {
    close: () => assert.fail("should not be closed"),
  } as unknown as WebSocket;
  const hub = new ChainFirehoseHub(stubState([ws]), mockEnv({})); // not tagged
  await assert.doesNotReject(() => hub.webSocketMessage(ws, "ignored"));
});

test("ChainFirehoseHub.isGraphqlWsTaggedSocket / closeStaleGraphqlWsSocket: direct unit coverage", () => {
  const ws = { close: () => {} } as unknown as WebSocket;
  const taggedHub = new ChainFirehoseHub(stubState([ws], [ws]), mockEnv({}));
  assert.equal(taggedHub.isGraphqlWsTaggedSocket(ws), true);
  const untaggedHub = new ChainFirehoseHub(stubState([ws]), mockEnv({}));
  assert.equal(untaggedHub.isGraphqlWsTaggedSocket(ws), false);
  assert.doesNotThrow(() => taggedHub.closeStaleGraphqlWsSocket(ws));
  assert.doesNotThrow(() =>
    taggedHub.closeStaleGraphqlWsSocket({
      close: () => {
        throw new Error("already closed");
      },
    } as unknown as WebSocket),
  );
});

// --- CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS (Finding 1, found by adversarial review) --

test("ChainFirehoseHub.subscribeChainEvents: returns null (not a repeater) once at CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS; i += 1) {
    assert.notEqual(hub.subscribeChainEvents(null, undefined, undefined), null);
  }
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  );
  assert.equal(hub.subscribeChainEvents(null, undefined, undefined), null);
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  );
});

// --- CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP (#5004 item 2) -------------
//
// The per-IP counterpart to the global cap above: CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP
// bounds how many graphql-ws SOCKETS one IP can open, but graphql-ws itself
// imposes no per-socket subscription-count limit -- so without this, a single
// IP using just one of its (already capped) sockets could still multiplex its
// way up to the ENTIRE global CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS budget.
// clientIp is threaded from handleSubscribe's WS-upgrade branch through
// graphql-ws's opened()/context() chain into src/graphql.mjs's
// chainEventsSubscribe resolver as context.clientIp, which passes it here as
// subscribeChainEvents's second argument -- see that resolver and
// graphqlWsServer's context callback in the source for the other half of the
// wiring (not Node-testable; same v8-ignored reachability class as every
// other WS-accept-path branch in this file). subscribeChainEvents/
// unsubscribeChainEvents are plain methods, though, so the actual cap logic
// under test here is called directly, the same way the global-cap test above
// does.

test("ChainFirehoseHub.subscribeChainEvents: rejects a new subscription from the SAME IP at the per-IP cap, well below the global cap", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  assert.ok(
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP <
      CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS,
  );
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP; i += 1) {
    assert.notEqual(
      hub.subscribeChainEvents(null, "203.0.113.9", undefined),
      null,
    );
  }
  assert.equal(
    hub.chainEventSubscribersByIp.get("203.0.113.9"),
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP,
  );

  const capped = hub.subscribeChainEvents(null, "203.0.113.9", undefined);
  assert.equal(capped, null);
  // The per-IP rejection didn't consume any of the global budget beyond this
  // IP's own subscriptions -- proves the rejection came from the per-IP
  // check, not CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS.
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP,
  );
});

test("ChainFirehoseHub.subscribeChainEvents: a DIFFERENT IP is unaffected by another IP's per-IP cap", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP; i += 1) {
    hub.subscribeChainEvents(null, "203.0.113.9", undefined);
  }
  const otherIpRepeater = hub.subscribeChainEvents(
    null,
    "198.51.100.4",
    undefined,
  );
  assert.notEqual(otherIpRepeater, null);
  assert.equal(hub.chainEventSubscribersByIp.get("198.51.100.4"), 1);
});

test("ChainFirehoseHub.unsubscribeChainEvents: releases the subscribing IP's slot, freeing room for a new subscription from the same IP", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeaters: (AsyncRepeater<ChainFirehoseIngestPayload> | null)[] = [];
  for (let i = 0; i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP; i += 1) {
    repeaters.push(hub.subscribeChainEvents(null, "203.0.113.9", undefined));
  }
  assert.equal(hub.subscribeChainEvents(null, "203.0.113.9", undefined), null); // capped

  hub.unsubscribeChainEvents(repeaters[0]!);
  assert.equal(
    hub.chainEventSubscribersByIp.get("203.0.113.9"),
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP - 1,
  );

  const reconnected = hub.subscribeChainEvents(null, "203.0.113.9", undefined);
  assert.notEqual(reconnected, null);
  assert.equal(
    hub.chainEventSubscribersByIp.get("203.0.113.9"),
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP,
  );
});

test("ChainFirehoseHub.unsubscribeChainEvents: deletes (not zeroes) the IP's map entry once its last subscription ends", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = hub.subscribeChainEvents(null, "203.0.113.9", undefined);
  assert.equal(hub.chainEventSubscribersByIp.get("203.0.113.9"), 1);
  hub.unsubscribeChainEvents(repeater!);
  assert.equal(hub.chainEventSubscribersByIp.has("203.0.113.9"), false);
});

test("ChainFirehoseHub.unsubscribeChainEvents: a defensive no-op when the entry carries a clientIp that was never (or is no longer) tracked in chainEventSubscribersByIp", () => {
  // Structurally shouldn't happen via the normal subscribeChainEvents path
  // (which always pairs the entry's clientIp with an increment), but this
  // mirrors the same defensive shape releaseWsIpSlot/removeSseClient already
  // use elsewhere in this class for an untracked IP -- seeded directly here
  // (like several other tests in this file seed hub.sseClients/
  // hub.graphqlWsSockets directly) to exercise that guard as its own branch.
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = createAsyncRepeater<ChainFirehoseIngestPayload>();
  const entry = { repeater, topics: null, clientIp: "203.0.113.9" };
  hub.chainEventSubscribers.add(
    entry as unknown as Parameters<typeof hub.chainEventSubscribers.add>[0],
  );
  assert.doesNotThrow(() => hub.unsubscribeChainEvents(repeater!));
  assert.equal(hub.chainEventSubscribersByIp.has("203.0.113.9"), false);
});

test("ChainFirehoseHub.subscribeChainEvents: an undefined clientIp (e.g. a caller not going through the real WS/graphql-ws path) skips the per-IP check entirely, sharing no bucket and never getting capped by it", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  for (
    let i = 0;
    i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP + 5;
    i += 1
  ) {
    assert.notEqual(hub.subscribeChainEvents(null, undefined, undefined), null);
  }
  assert.equal(
    hub.chainEventSubscribers.size,
    CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP + 5,
  );
  assert.equal(hub.chainEventSubscribersByIp.size, 0);
});

test("ChainFirehoseHub.unsubscribeChainEvents: unsubscribing a repeater that was subscribed with no clientIp doesn't touch chainEventSubscribersByIp", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const repeater = hub.subscribeChainEvents(null, undefined, undefined);
  assert.doesNotThrow(() => hub.unsubscribeChainEvents(repeater!));
  assert.equal(hub.chainEventSubscribersByIp.size, 0);
});

// --- CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_SOCKET -----------------------
//
// Defense-in-depth alongside the per-IP cap above: a hard, socket-scoped
// invariant via the SAME connection object stamped on ctx.extra at opened()
// time and threaded through context.graphqlWsConnection into
// subscribeChainEvents's third argument.

test("ChainFirehoseHub.subscribeChainEvents: enforces the per-socket active subscription cap independent of clientIp", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const connection = {
    activeSubscriptions: CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_SOCKET,
  };
  assert.equal(hub.subscribeChainEvents(null, "203.0.113.9", connection), null);
  assert.equal(hub.chainEventSubscribers.size, 0);
  assert.equal(hub.chainEventSubscribersByIp.has("203.0.113.9"), false);
});

test("ChainFirehoseHub.subscribeChainEvents: a DIFFERENT socket (same IP) is unaffected by another socket's per-socket cap", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const fullSocket = {
    activeSubscriptions: CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_SOCKET,
  };
  const freshSocket = { activeSubscriptions: 0 };
  assert.equal(hub.subscribeChainEvents(null, "203.0.113.9", fullSocket), null);
  const repeater = hub.subscribeChainEvents(null, "203.0.113.9", freshSocket);
  assert.notEqual(repeater, null);
  assert.equal(freshSocket.activeSubscriptions, 1);
});

test("ChainFirehoseHub.subscribeChainEvents: increments connection.activeSubscriptions on success", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const connection = { activeSubscriptions: 0 };
  hub.subscribeChainEvents(null, undefined, connection);
  hub.subscribeChainEvents(null, undefined, connection);
  assert.equal(connection.activeSubscriptions, 2);
});

test("ChainFirehoseHub.unsubscribeChainEvents: decrements connection.activeSubscriptions, floored at 0", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const connection = { activeSubscriptions: 0 };
  const repeater = hub.subscribeChainEvents(null, undefined, connection);
  assert.equal(connection.activeSubscriptions, 1);
  hub.unsubscribeChainEvents(repeater!);
  assert.equal(connection.activeSubscriptions, 0);
  assert.doesNotThrow(() => hub.unsubscribeChainEvents(repeater!)); // already removed, no-op
});

test("ChainFirehoseHub.subscribeChainEvents: an undefined connection skips the per-socket check entirely", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  for (
    let i = 0;
    i < CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_SOCKET + 5;
    i += 1
  ) {
    assert.notEqual(hub.subscribeChainEvents(null, undefined, undefined), null);
  }
});

test("ChainFirehoseHub.broadcast: a subscription that overflows its buffer is dropped and its counters released", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const connection = { activeSubscriptions: 0 };
  const repeater = hub.subscribeChainEvents(null, "203.0.113.9", connection);
  for (
    let i = 0;
    i < CHAIN_FIREHOSE_GRAPHQL_SUBSCRIPTION_HIGH_WATER_MARK + 1;
    i += 1
  ) {
    hub.broadcast({ table: "blocks", block_number: i });
  }
  assert.equal(hub.chainEventSubscribers.size, 0);
  assert.equal(hub.chainEventSubscribersByIp.has("203.0.113.9"), false);
  assert.equal(connection.activeSubscriptions, 0);
  assert.deepEqual(await repeater![Symbol.asyncIterator]().next(), {
    value: undefined,
    done: true,
  });
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
    "account_events",
    "blocks",
    "chain_events",
    "extrinsics",
  ]);
});

// --- MCP resource-subscription notify loop (#4983 MCP half) ---------------------

function fakeMcpSessionHubBinding(
  overrides: Record<string, () => Response> = {},
) {
  const calls: Row[] = [];
  return {
    calls,
    idFromName: (name: string) => name,
    get: (sessionId: string) => ({
      fetch: async (url: string | URL, init: RequestInit) => {
        calls.push({ sessionId, url, init });
        if (overrides[sessionId]) return overrides[sessionId]();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
}

test("mcpSubscribeSession / mcpUnsubscribeSession: idempotent Set add/delete", () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.mcpSubscribeSession("s1");
  hub.mcpSubscribeSession("s1"); // double-subscribe is a no-op
  assert.deepEqual([...hub.mcpSubscribedSessions], ["s1"]);
  hub.mcpUnsubscribeSession("s2"); // never subscribed -- harmless no-op
  assert.deepEqual([...hub.mcpSubscribedSessions], ["s1"]);
  hub.mcpUnsubscribeSession("s1");
  assert.equal(hub.mcpSubscribedSessions.size, 0);
});

test("ChainFirehoseHub.fetch: GET /latest returns the latest broadcast payload, null before any broadcast", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const before = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/latest"),
  );
  assert.deepEqual(await before.json(), { payload: null });

  await hub.broadcast({ table: "blocks", block_number: 42 });
  const after = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/latest"),
  );
  assert.deepEqual(await after.json(), {
    payload: { table: "blocks", block_number: 42 },
  });
});

test("ChainFirehoseHub.fetch: POST /mcp-subscribe registers the session", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/mcp-subscribe", {
      method: "POST",
      body: JSON.stringify({ sessionId: "s1" }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(hub.mcpSubscribedSessions.has("s1"), true);
});

test("ChainFirehoseHub.fetch: POST /mcp-unsubscribe removes the session", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.mcpSubscribeSession("s1");
  const res = await hub.fetch(
    new Request("https://chain-firehose-hub.internal/mcp-unsubscribe", {
      method: "POST",
      body: JSON.stringify({ sessionId: "s1" }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(hub.mcpSubscribedSessions.has("s1"), false);
});

test("broadcast: with no MCP-subscribed sessions, never calls MCP_SESSION_HUB", async () => {
  const mcpHub = fakeMcpSessionHubBinding();
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ MCP_SESSION_HUB: mcpHub }),
  );
  await hub.broadcast({ table: "blocks", block_number: 1 });
  assert.equal(mcpHub.calls.length, 0);
});

test("broadcast: with a subscribed session but MCP_SESSION_HUB unbound, never throws and skips the loop", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  hub.mcpSubscribeSession("s1");
  await assert.doesNotReject(() =>
    hub.broadcast({ table: "blocks", block_number: 1 }),
  );
});

test("broadcast: notifies every MCP-subscribed session's McpSessionHub with a pointer-only uri", async () => {
  const mcpHub = fakeMcpSessionHubBinding();
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ MCP_SESSION_HUB: mcpHub }),
  );
  hub.mcpSubscribeSession("s1");
  hub.mcpSubscribeSession("s2");
  await hub.broadcast({ table: "chain_events", block_number: 7 });
  assert.equal(mcpHub.calls.length, 2);
  const sessionIds = mcpHub.calls.map((c) => c.sessionId).sort();
  assert.deepEqual(sessionIds, ["s1", "s2"]);
  for (const call of mcpHub.calls) {
    assert.match(call.url, /\/notify$/);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body), {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    });
  }
});

test("broadcast: an unreachable/erroring session hub is best-effort -- doesn't throw and doesn't block the other sessions", async () => {
  const mcpHub = fakeMcpSessionHubBinding({
    s1: () => {
      throw new Error("session DO unreachable");
    },
  });
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ MCP_SESSION_HUB: mcpHub }),
  );
  hub.mcpSubscribeSession("s1");
  hub.mcpSubscribeSession("s2");
  await assert.doesNotReject(() =>
    hub.broadcast({ table: "blocks", block_number: 1 }),
  );
  const sessionIds = mcpHub.calls.map((c) => c.sessionId).sort();
  assert.deepEqual(sessionIds, ["s1", "s2"]);
});

// --- ALERTER_HUB ping (#4984 Part 2) ---------------------------------------------

function fakeAlerterHubBinding(overrides: Record<string, () => Response> = {}) {
  const calls: Row[] = [];
  return {
    calls,
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string | URL, init: RequestInit) => {
        calls.push({ name, url, init });
        if (overrides[name]) return overrides[name]();
        return new Response(JSON.stringify({ matched: 0 }), { status: 200 });
      },
    }),
  };
}

test("broadcast: with ALERTER_HUB unbound, never throws and skips the ping", async () => {
  const hub = new ChainFirehoseHub(stubState(), mockEnv({}));
  await assert.doesNotReject(() =>
    hub.broadcast({ table: "account_events", block_number: 1 }),
  );
});

test("broadcast: pings ALERTER_HUB's singleton /evaluate route with the full payload", async () => {
  const alerterHub = fakeAlerterHubBinding();
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ ALERTER_HUB: alerterHub }),
  );
  const payload = {
    table: "account_events",
    block_number: 7,
    netuid: 7,
    amount_tao: 12.5,
  };
  await hub.broadcast(payload);
  assert.equal(alerterHub.calls.length, 1);
  assert.equal(alerterHub.calls[0].name, "global");
  assert.match(alerterHub.calls[0].url, /\/evaluate$/);
  assert.equal(alerterHub.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(alerterHub.calls[0].init.body), payload);
});

test("broadcast: an unreachable/erroring AlerterHub is best-effort -- doesn't throw and doesn't block ingest", async () => {
  const alerterHub = fakeAlerterHubBinding({
    global: () => {
      throw new Error("alerter hub unreachable");
    },
  });
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ ALERTER_HUB: alerterHub }),
  );
  await assert.doesNotReject(() =>
    hub.broadcast({ table: "account_events", block_number: 1 }),
  );
  assert.equal(alerterHub.calls.length, 1);
});

test("broadcast: the ALERTER_HUB ping carries a bounded AbortSignal, so a slow/stuck AlerterHub.evaluate() can't stall broadcast() (and therefore handleIngest's response) indefinitely", async () => {
  const alerterHub = fakeAlerterHubBinding();
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({ ALERTER_HUB: alerterHub }),
  );
  await hub.broadcast({ table: "account_events", block_number: 1 });
  assert.equal(alerterHub.calls.length, 1);
  const { signal } = alerterHub.calls[0].init;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("ALERTER_HUB_EVALUATE_TIMEOUT_MS is generous enough to cover AlerterHub's own worst-case refresh+delivery cycle", () => {
  // Documents the reasoning, not just the number: workers/alerter-hub.ts's
  // own ALERT_TRIGGER_REFRESH_TIMEOUT_MS (4000) plus ALERT_DELIVERY_TIMEOUT_MS
  // (8000, but bounded-concurrency so one slow batch, not summed across every
  // match) should together stay comfortably under this ceiling.
  assert.equal(ALERTER_HUB_EVALUATE_TIMEOUT_MS, 15_000);
  assert.ok(ALERTER_HUB_EVALUATE_TIMEOUT_MS > 4000 + 8000);
});

test("broadcast: pings ALERTER_HUB unconditionally, unlike the per-session MCP loop -- no subscribe step required", async () => {
  const alerterHub = fakeAlerterHubBinding();
  const mcpHub = fakeMcpSessionHubBinding();
  const hub = new ChainFirehoseHub(
    stubState(),
    mockEnv({
      ALERTER_HUB: alerterHub,
      MCP_SESSION_HUB: mcpHub,
    }),
  );
  // No mcpSubscribeSession call -- the MCP loop should stay silent while the
  // alerter ping still fires.
  await hub.broadcast({ table: "account_events", block_number: 1 });
  assert.equal(alerterHub.calls.length, 1);
  assert.equal(mcpHub.calls.length, 0);
});
