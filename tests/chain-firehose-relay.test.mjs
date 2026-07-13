// Unit tests for scripts/chain-firehose-relay.mjs's pure logic (#4981, ADR
// 0015). The long-running LISTEN/drain loop (main()) needs a real Postgres
// connection and process lifecycle and is intentionally excluded from
// vitest.config.mjs's coverage.include (matching deploy/wss-lb's
// node --test convention for standalone deploy/-tier processes) -- see that
// function's own /* v8 ignore */ comment. Every decision it makes is tested
// directly here instead.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CHAIN_FIREHOSE_BACKOFF_BASE_MS,
  CHAIN_FIREHOSE_BACKOFF_MAX_MS,
  CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
  CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS,
  computeBackoffDelayMs,
  createBoundedDropOldestQueue,
  forwardChainFirehoseNotification,
  forwardWithRetry,
  parseRelayConfig,
} from "../scripts/chain-firehose-relay.mjs";

// --- parseRelayConfig -------------------------------------------------------

test("parseRelayConfig: throws when DATABASE_URL is missing", () => {
  assert.throws(
    () => parseRelayConfig({ CHAIN_FIREHOSE_SYNC_SECRET: "shh" }),
    /DATABASE_URL is required/,
  );
});

test("parseRelayConfig: throws when CHAIN_FIREHOSE_SYNC_SECRET is missing", () => {
  assert.throws(
    () => parseRelayConfig({ DATABASE_URL: "postgres://x" }),
    /CHAIN_FIREHOSE_SYNC_SECRET is required/,
  );
});

test("parseRelayConfig: defaults CHAIN_FIREHOSE_INGEST_URL to the production hub", () => {
  const config = parseRelayConfig({
    DATABASE_URL: "postgres://x",
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
  });
  assert.equal(
    config.ingestUrl,
    "https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest",
  );
});

test("parseRelayConfig: honors an explicit CHAIN_FIREHOSE_INGEST_URL override", () => {
  const config = parseRelayConfig({
    DATABASE_URL: "postgres://x",
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_INGEST_URL: "https://staging.example.com/ingest",
  });
  assert.equal(config.ingestUrl, "https://staging.example.com/ingest");
});

// --- computeBackoffDelayMs ---------------------------------------------------

test("computeBackoffDelayMs: doubles per attempt, capped at maxMs", () => {
  assert.equal(computeBackoffDelayMs(0), CHAIN_FIREHOSE_BACKOFF_BASE_MS);
  assert.equal(computeBackoffDelayMs(1), CHAIN_FIREHOSE_BACKOFF_BASE_MS * 2);
  assert.equal(computeBackoffDelayMs(2), CHAIN_FIREHOSE_BACKOFF_BASE_MS * 4);
  assert.equal(computeBackoffDelayMs(20), CHAIN_FIREHOSE_BACKOFF_MAX_MS);
});

test("computeBackoffDelayMs: honors custom baseMs/maxMs", () => {
  assert.equal(computeBackoffDelayMs(1, { baseMs: 100, maxMs: 1000 }), 200);
  assert.equal(computeBackoffDelayMs(10, { baseMs: 100, maxMs: 1000 }), 1000);
});

// --- createBoundedDropOldestQueue --------------------------------------------

test("createBoundedDropOldestQueue: push/shift behaves as a plain FIFO under capacity", () => {
  const queue = createBoundedDropOldestQueue(3);
  queue.push("a");
  queue.push("b");
  assert.equal(queue.size, 2);
  assert.equal(queue.shift(), "a");
  assert.equal(queue.shift(), "b");
  assert.equal(queue.shift(), undefined);
  assert.equal(queue.size, 0);
});

test("createBoundedDropOldestQueue: drops the OLDEST entry once over maxSize, keeping size bounded", () => {
  const queue = createBoundedDropOldestQueue(2);
  queue.push("a");
  queue.push("b");
  queue.push("c"); // over capacity -- "a" is dropped
  assert.equal(queue.size, 2);
  assert.equal(queue.droppedCount, 1);
  assert.equal(queue.shift(), "b");
  assert.equal(queue.shift(), "c");
});

test("createBoundedDropOldestQueue: defaults to CHAIN_FIREHOSE_QUEUE_MAX_SIZE when no size is given", () => {
  const queue = createBoundedDropOldestQueue();
  assert.equal(queue.droppedCount, 0);
});

// --- forwardChainFirehoseNotification ----------------------------------------

test("forwardChainFirehoseNotification: POSTs the payload with the sync-token header, returns ok/status", async () => {
  let received;
  const fetchImpl = async (url, init) => {
    received = { url, init };
    return new Response("{}", { status: 202 });
  };
  const result = await forwardChainFirehoseNotification(
    '{"table":"blocks","block_number":1}',
    { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(received.url, "https://hub.example.com/ingest");
  assert.equal(received.init.method, "POST");
  assert.equal(
    received.init.headers[CHAIN_FIREHOSE_INGEST_TOKEN_HEADER],
    "shh",
  );
  assert.equal(received.init.body, '{"table":"blocks","block_number":1}');
});

test("forwardChainFirehoseNotification: a non-2xx response is reported as not ok", async () => {
  const fetchImpl = async () => new Response("{}", { status: 401 });
  const result = await forwardChainFirehoseNotification(
    "{}",
    { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
    fetchImpl,
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

// --- forwardWithRetry ---------------------------------------------------------

test("forwardWithRetry: succeeds immediately without sleeping when the first attempt is ok", async () => {
  let calls = 0;
  let slept = 0;
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 202 });
      },
      sleepImpl: async () => {
        slept += 1;
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("forwardWithRetry: retries with backoff on failure, succeeds on a later attempt", async () => {
  let calls = 0;
  const sleeps = [];
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: calls < 2 ? 500 : 202 });
      },
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [CHAIN_FIREHOSE_BACKOFF_BASE_MS]);
});

test("forwardWithRetry: a thrown network error is treated as a failed attempt, not a crash", async () => {
  let calls = 0;
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network down");
      },
      sleepImpl: async () => {},
    },
  );
  assert.equal(ok, false);
  assert.equal(calls, CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS);
});

test("forwardWithRetry: drops the payload and calls onDrop after exhausting all attempts", async () => {
  let dropped;
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => new Response("{}", { status: 500 }),
      sleepImpl: async () => {},
      onDrop: (payload) => {
        dropped = payload;
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(dropped, "{}");
});

test("forwardWithRetry: never sleeps after the final attempt (no wasted delay before dropping)", async () => {
  let sleeps = 0;
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => new Response("{}", { status: 500 }),
      sleepImpl: async () => {
        sleeps += 1;
      },
    },
  );
  assert.equal(sleeps, CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS - 1);
});
