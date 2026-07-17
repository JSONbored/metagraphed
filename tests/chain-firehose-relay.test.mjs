// Unit tests for scripts/chain-firehose-relay.mjs's pure logic (#4981,
// #5027, ADR 0015). The long-running poll/cleanup loop (main()) needs a real
// Postgres connection and process lifecycle and is intentionally excluded
// from vitest.config.mjs's coverage.include (matching deploy/wss-lb's
// node --test convention for standalone deploy/-tier processes) -- see that
// function's own /* v8 ignore */ comment. Every decision it makes is tested
// directly here instead.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vitest";

// Hoisted spies -- mocked the same way apps/ui/src/lib/error-reporting.test.ts
// mocks @sentry/browser. reportRateLimitPause and main()'s own fatal catch
// are the only two call sites that actually invoke Sentry directly in this
// file; computeDropWindowUpdate is a pure state-transition function with no
// Sentry dependency at all (main()'s poll loop is the one that calls
// Sentry.captureMessage when it reports === true) -- see that function's own
// comment for why it's deliberately NOT the one holding module-level state
// or calling Sentry itself.
const captureMessage = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
const sentryInit = vi.hoisted(() => vi.fn());
const setTag = vi.hoisted(() => vi.fn());
const startSession = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@sentry/node", () => ({
  init: sentryInit,
  setTag,
  captureMessage,
  captureException,
  startSession,
  endSession,
  flush,
}));

import {
  CHAIN_FIREHOSE_BACKOFF_BASE_MS,
  CHAIN_FIREHOSE_BACKOFF_MAX_MS,
  CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS,
  CHAIN_FIREHOSE_DROP_REPORT_INTERVAL_MS,
  CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD,
  CHAIN_FIREHOSE_FORWARD_TIMEOUT_MS,
  CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
  CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS,
  CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS,
  CHAIN_FIREHOSE_POLL_BATCH_SIZE,
  CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S,
  computeBackoffDelayMs,
  computeBatchPaceDelayMs,
  computeDropWindowUpdate,
  endSessionAndFlush,
  forwardBatch,
  forwardChainFirehoseNotification,
  forwardWithRetry,
  initSentry,
  isHeartbeatFresh,
  mapBounded,
  parseRelayConfig,
  parseRetryAfterMs,
  reportRateLimitPause,
  touchHeartbeat,
} from "../scripts/chain-firehose-relay.mjs";

// --- mapBounded ---------------------------------------------------------------

test("mapBounded: preserves result order by input index regardless of completion order", async () => {
  const results = await mapBounded([30, 10, 20], 3, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms;
  });
  assert.deepEqual(results, [30, 10, 20]);
});

test("mapBounded: never runs more than `concurrency` workers at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await mapBounded([1, 2, 3, 4, 5, 6], 2, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  });
  assert.equal(maxInFlight, 2);
});

test("mapBounded: an empty items array resolves to an empty results array", async () => {
  const results = await mapBounded([], 5, async () => {
    throw new Error("should never be called");
  });
  assert.deepEqual(results, []);
});

test("mapBounded: a null/undefined items list is treated as empty, not a crash", async () => {
  const results = await mapBounded(null, 5, async () => 1);
  assert.deepEqual(results, []);
});

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

// --- computeBatchPaceDelayMs -------------------------------------------------

test("computeBatchPaceDelayMs: a full batch that forwarded instantly gets the full target delay", () => {
  // 200 rows at the safe rate takes (200/960)*60_000 = 12_500ms; if forwarding
  // itself took ~0ms, the full 12_500ms must still be slept.
  const delay = computeBatchPaceDelayMs(CHAIN_FIREHOSE_POLL_BATCH_SIZE, 0);
  assert.equal(delay, 12_500);
});

test("computeBatchPaceDelayMs: subtracts wall-clock time the batch already spent forwarding", () => {
  const delay = computeBatchPaceDelayMs(CHAIN_FIREHOSE_POLL_BATCH_SIZE, 5_000);
  assert.equal(delay, 12_500 - 5_000);
});

test("computeBatchPaceDelayMs: never negative -- a batch that took longer than its target needs no extra pause", () => {
  assert.equal(
    computeBatchPaceDelayMs(CHAIN_FIREHOSE_POLL_BATCH_SIZE, 99_999),
    0,
  );
});

test("computeBatchPaceDelayMs: zero or negative claimed count needs no pause", () => {
  assert.equal(computeBatchPaceDelayMs(0, 0), 0);
  assert.equal(computeBatchPaceDelayMs(-1, 0), 0);
});

test("computeBatchPaceDelayMs: scales proportionally with a partial batch, not just full ones", () => {
  // A partial batch of 50 rows only needs to pace to (50/960)*60_000 ≈ 3_125ms,
  // not the full-batch target -- pacing scales with actual claimed rows so a
  // relay that's nearly caught up isn't throttled as hard as one draining a
  // real backlog.
  const delay = computeBatchPaceDelayMs(50, 0);
  assert.equal(delay, (50 / CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S) * 60_000);
  assert.ok(delay < 12_500);
});

test("computeBatchPaceDelayMs: sustained full-batch pacing stays at/under the safe rate, not the raw 1200 limit", () => {
  // Simulate draining a large backlog: every batch forwards CHAIN_FIREHOSE_POLL_BATCH_SIZE
  // rows in negligible wall-clock time, so the loop is paced entirely by this
  // function. Over N batches the total elapsed time must be at least
  // N * batchSize / CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S seconds --
  // i.e. the achieved rate never exceeds the safe target, which itself sits
  // comfortably under the server's real 1200/60s cap (see this function's
  // own header comment for why 100% of the raw limit is deliberately not
  // the target).
  const batches = 12;
  let totalDelayMs = 0;
  for (let i = 0; i < batches; i += 1) {
    totalDelayMs += computeBatchPaceDelayMs(CHAIN_FIREHOSE_POLL_BATCH_SIZE, 0);
  }
  const achievedRatePer60s =
    (batches * CHAIN_FIREHOSE_POLL_BATCH_SIZE * 60_000) / totalDelayMs;
  assert.ok(
    achievedRatePer60s <= CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S + 0.01,
    `achieved rate ${achievedRatePer60s}/60s exceeded the safe target ${CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S}/60s`,
  );
  assert.ok(
    achievedRatePer60s < 1200,
    "achieved rate must stay under the raw server limit too",
  );
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
  assert.equal(received.init.signal instanceof AbortSignal, true);
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

test("forwardChainFirehoseNotification: cancels the response body before returning", async () => {
  let canceled = false;
  const result = await forwardChainFirehoseNotification(
    "{}",
    { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
    async () => ({
      ok: true,
      status: 202,
      body: {
        async cancel() {
          canceled = true;
        },
      },
    }),
  );
  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal(canceled, true);
});

test("forwardChainFirehoseNotification: aborts a stalled fetch after the per-attempt timeout", async () => {
  vi.useFakeTimers();
  try {
    const promise = forwardChainFirehoseNotification(
      "{}",
      { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const rejection = assert.rejects(promise, /aborted/);

    await vi.advanceTimersByTimeAsync(CHAIN_FIREHOSE_FORWARD_TIMEOUT_MS);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
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

// --- forwardBatch --------------------------------------------------------------

test("forwardBatch: forwards every row concurrently, JSON-stringifying the already-parsed payload", async () => {
  const seen = new Set();
  const rows = [
    { id: 1, payload: { table: "blocks", block_number: 1 } },
    { id: 2, payload: { table: "blocks", block_number: 2 } },
  ];
  const result = await forwardBatch(
    rows,
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async (_url, init) => {
        seen.add(init.body);
        return new Response("{}", { status: 202 });
      },
      sleepImpl: async () => {},
    },
  );
  assert.equal(result.forwarded, 2);
  assert.equal(result.dropped, 0);
  // Concurrent dispatch (CHAIN_FIREHOSE_FORWARD_CONCURRENCY), not strictly
  // sequential -- assert both were sent, not the order they arrived in.
  assert.deepEqual(
    [...seen].sort(),
    [
      '{"table":"blocks","block_number":1}',
      '{"table":"blocks","block_number":2}',
    ].sort(),
  );
});

test("forwardBatch: counts a row dropped after exhausting retries separately from forwarded rows", async () => {
  const rows = [
    { id: 1, payload: { table: "blocks", block_number: 1 } }, // always fails
    { id: 2, payload: { table: "blocks", block_number: 2 } }, // always succeeds
  ];
  const result = await forwardBatch(
    rows,
    { ingestUrl: "u", syncSecret: "s" },
    {
      // Keyed by payload body, not a shared call counter -- rows forward
      // concurrently, so interleaving between the two isn't deterministic.
      fetchImpl: async (_url, init) =>
        new Response("{}", {
          status: init.body.includes('"block_number":1') ? 500 : 202,
        }),
      sleepImpl: async () => {},
    },
  );
  assert.equal(result.forwarded, 1);
  assert.equal(result.dropped, 1);
});

test("forwardBatch: an empty batch forwards nothing and drops nothing", async () => {
  const result = await forwardBatch([], { ingestUrl: "u", syncSecret: "s" });
  assert.deepEqual(result, { forwarded: 0, dropped: 0 });
});

// --- parseRetryAfterMs -------------------------------------------------------
// Real 2026-07 incident regression coverage: the relay's own rate-limit
// backoff is only as correct as this parsing.

test("parseRetryAfterMs: a plain integer-seconds header", () => {
  assert.equal(parseRetryAfterMs("60"), 60_000);
  assert.equal(parseRetryAfterMs("0"), 0);
});

test("parseRetryAfterMs: an HTTP-date header resolves to a future-relative delay", () => {
  const future = new Date(Date.now() + 30_000).toUTCString();
  const ms = parseRetryAfterMs(future);
  // Allow slop for wall-clock time elapsed between Date.now() above and the
  // parse itself -- assert it's in the right ballpark, not an exact ms match.
  assert.ok(ms > 25_000 && ms <= 30_000, `expected ~30000, got ${ms}`);
});

test("parseRetryAfterMs: a past HTTP-date clamps to 0, never negative", () => {
  const past = new Date(Date.now() - 30_000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 0);
});

test("parseRetryAfterMs: absent or unparseable input returns null", () => {
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs("not-a-header-value"), null);
});

// --- forwardChainFirehoseNotification: retry-after surfacing ----------------

test("forwardChainFirehoseNotification: surfaces retryAfterMs when the response carries the header", async () => {
  const result = await forwardChainFirehoseNotification(
    "{}",
    { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
    async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
  );
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterMs, 60_000);
});

test("forwardChainFirehoseNotification: no retryAfterMs key at all on a normal 2xx (unchanged return shape)", async () => {
  const result = await forwardChainFirehoseNotification(
    "{}",
    { ingestUrl: "https://hub.example.com/ingest", syncSecret: "shh" },
    async () => new Response("{}", { status: 202 }),
  );
  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal("retryAfterMs" in result, false);
});

// --- forwardWithRetry: 429 handling (the real incident's actual fix) --------

test("forwardWithRetry: a 429 uses retry-after for the pause, NOT the generic exponential backoff", async () => {
  let calls = 0;
  const sleeps = [];
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", {
          status: calls < 3 ? 429 : 202,
          headers: { "retry-after": "5" },
        });
      },
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
  // Two 429s before the success on attempt 3 -- both pauses must be the
  // retry-after value (5000ms), never CHAIN_FIREHOSE_BACKOFF_BASE_MS (500ms)
  // or CHAIN_FIREHOSE_BACKOFF_BASE_MS*2 (1000ms), which is what the generic
  // exponential schedule would have produced for attempts 0 and 1.
  assert.deepEqual(sleeps, [5000, 5000]);
});

test("forwardWithRetry: a 429 with no retry-after header falls back to CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS", async () => {
  const sleeps = [];
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => new Response("{}", { status: 429 }),
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  );
  assert.deepEqual(sleeps, [
    CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS,
    CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS,
  ]);
});

test("forwardWithRetry: an absurd retry-after value is clamped to CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS", async () => {
  const sleeps = [];
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "999999" },
        }),
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  );
  assert.ok(
    sleeps.every((ms) => ms === CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS),
  );
});

test("forwardWithRetry: calls onRateLimited on EVERY 429 attempt, including the final one that then drops", async () => {
  // All 3 attempts (CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS) 429 here, including
  // the last -- onRateLimited must still fire on that final attempt (only
  // the actual sleepImpl pause is skipped there, a separate concern) so
  // forwardBatch's caller learns about the rate limit even when a payload
  // gets dropped rather than successfully retried.
  const pauses = [];
  const ok = await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "5" } }),
      sleepImpl: async () => {},
      onRateLimited: (pauseMs) => pauses.push(pauseMs),
    },
  );
  assert.equal(ok, false);
  assert.deepEqual(pauses, [5000, 5000, 5000]);
});

test("forwardWithRetry: onDrop receives the last-observed status code as its second argument", async () => {
  let lastStatus;
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => new Response("{}", { status: 503 }),
      sleepImpl: async () => {},
      onDrop: (_payload, status) => {
        lastStatus = status;
      },
    },
  );
  assert.equal(lastStatus, 503);
});

test("forwardWithRetry: onDrop's status is undefined when every attempt threw (not a stale status from an earlier attempt)", async () => {
  let statusArgWasPassed = true;
  let lastStatus = "unset";
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        throw new Error("network down");
      },
      sleepImpl: async () => {},
      onDrop: (_payload, status) => {
        lastStatus = status;
      },
    },
  );
  assert.equal(lastStatus, undefined);
  assert.equal(statusArgWasPassed, true);
});

test("forwardWithRetry: a 429 followed by a thrown network error does not leak the 429's stale status into the drop", async () => {
  // Regression test for the exact scoping bug caught while building this fix:
  // `result` must reset each attempt, or a later thrown-error attempt would
  // incorrectly report the PRIOR attempt's 429 status via onDrop.
  let calls = 0;
  let lastStatus = "unset";
  await forwardWithRetry(
    "{}",
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("{}", { status: 429 });
        throw new Error("network down");
      },
      sleepImpl: async () => {},
      onDrop: (_payload, status) => {
        lastStatus = status;
      },
    },
  );
  assert.equal(
    lastStatus,
    undefined,
    "must be undefined (the last attempt threw), not 429 (a stale earlier attempt)",
  );
});

// --- forwardBatch: rate-limit aggregation ------------------------------------

test("forwardBatch: surfaces rateLimitedForMs as the MAX pause seen across the batch's rows", async () => {
  const rows = [
    { id: 1, payload: { table: "blocks", block_number: 1 } },
    { id: 2, payload: { table: "blocks", block_number: 2 } },
  ];
  const result = await forwardBatch(
    rows,
    { ingestUrl: "u", syncSecret: "s" },
    {
      fetchImpl: async (_url, init) =>
        new Response("{}", {
          status: 429,
          headers: {
            "retry-after": init.body.includes('"block_number":1') ? "5" : "20",
          },
        }),
      sleepImpl: async () => {},
    },
  );
  assert.equal(result.rateLimitedForMs, 20_000);
});

test("forwardBatch: no rateLimitedForMs key at all when nothing was rate limited (unchanged return shape)", async () => {
  const result = await forwardBatch(
    [{ id: 1, payload: {} }],
    { ingestUrl: "u", syncSecret: "s" },
    { fetchImpl: async () => new Response("{}", { status: 202 }) },
  );
  assert.deepEqual(result, { forwarded: 1, dropped: 0 });
  assert.equal("rateLimitedForMs" in result, false);
});

// --- computeDropWindowUpdate / reportRateLimitPause: aggregate reporting ----
// The real incident this whole fix addresses hit millions of drops in ~40h;
// naive per-drop capture would have blown the free-tier event quota in
// minutes and then been silently sampled away by Sentry itself. These tests
// assert the aggregation actually withholds a report below threshold, and
// actually fires at it -- computeDropWindowUpdate itself is pure (no Sentry
// call, no module-level state -- see its own comment), so no mocking is
// needed here at all; only reportRateLimitPause below still calls Sentry
// directly.

test("computeDropWindowUpdate: does not report before the count threshold is reached", () => {
  const update = computeDropWindowUpdate(
    null,
    CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD - 1,
    429,
    1_000_000,
  );
  assert.equal(update.report, false);
  assert.deepEqual(update.nextWindow, {
    startedAt: 1_000_000,
    count: CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD - 1,
  });
});

test("computeDropWindowUpdate: reports exactly when the accumulated count crosses the threshold, carrying the right context", () => {
  const start = 2_000_000;
  const first = computeDropWindowUpdate(
    null,
    CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD - 10,
    429,
    start,
  );
  assert.equal(first.report, false);
  const second = computeDropWindowUpdate(
    first.nextWindow,
    10,
    429,
    start + 1000,
  );
  assert.equal(second.report, true);
  assert.equal(second.count, CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD);
  assert.equal(second.elapsedMs, 1000);
  assert.equal(second.lastStatus, 429);
  // nextWindow is null once reported -- the caller's NEXT drop starts a
  // fresh window rather than continuing to accumulate past the threshold
  // just reported.
  assert.equal(second.nextWindow, null);
});

test("computeDropWindowUpdate: reports on the time threshold even if the count threshold is never reached (a persistent low-volume problem isn't silent forever)", () => {
  const start = 3_000_000;
  const first = computeDropWindowUpdate(null, 1, 500, start);
  assert.equal(first.report, false);
  const second = computeDropWindowUpdate(
    first.nextWindow,
    1,
    500,
    start + CHAIN_FIREHOSE_DROP_REPORT_INTERVAL_MS,
  );
  assert.equal(second.report, true);
  assert.equal(second.count, 2);
});

test("computeDropWindowUpdate: two independent windows (null starting state each time) never leak state into one another", () => {
  // Regression test for the actual bug caught while building this: an
  // earlier draft held count/startedAt as module-level variables, which
  // leaked between unrelated calls (and unrelated unit tests) unless
  // something explicitly reset them. Passing `null` here must always mean
  // "a genuinely fresh window," never a stale value from a prior call.
  const windowA = computeDropWindowUpdate(null, 200, 500, 1_000_000).nextWindow;
  const windowB = computeDropWindowUpdate(null, 50, 429, 5_000_000);
  assert.equal(windowB.count, 50, "windowB must not include windowA's 200");
  assert.notEqual(windowA.startedAt, windowB.nextWindow.startedAt);
});

test("reportRateLimitPause: calls Sentry.captureMessage directly, once per call (naturally low-frequency, no aggregation needed)", () => {
  captureMessage.mockClear();
  reportRateLimitPause(65_000);
  assert.equal(captureMessage.mock.calls.length, 1);
  const [message, options] = captureMessage.mock.calls[0];
  assert.match(message, /pausing 65000ms/);
  assert.equal(options.extra.pauseMs, 65_000);
});

// --- initSentry ---------------------------------------------------------------

test("initSentry: no-ops (never calls Sentry.init) when SENTRY_DSN is unset", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  startSession.mockClear();
  vi.stubEnv("SENTRY_DSN", "");
  initSentry();
  assert.equal(sentryInit.mock.calls.length, 0);
  assert.equal(setTag.mock.calls.length, 0);
  assert.equal(startSession.mock.calls.length, 0);
  vi.unstubAllEnvs();
});

test("initSentry: calls Sentry.init with dsn/environment/release, tags the component, and starts a release-health session when SENTRY_DSN is set", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  startSession.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
  vi.stubEnv("SENTRY_RELEASE", "deadbeef");
  initSentry();
  assert.equal(sentryInit.mock.calls.length, 1);
  const initArgs = sentryInit.mock.calls[0][0];
  assert.equal(initArgs.dsn, "https://abc@o0.ingest.sentry.io/0");
  assert.equal(initArgs.environment, "staging");
  assert.equal(initArgs.release, "deadbeef");
  assert.equal(initArgs.tracesSampleRate, 0);
  assert.deepEqual(setTag.mock.calls[0], ["component", "chain-firehose-relay"]);
  assert.equal(startSession.mock.calls.length, 1);
  vi.unstubAllEnvs();
});

test("initSentry: filters the default ProcessSession integration out (it would otherwise auto-start a second, spurious session)", () => {
  sentryInit.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry();

  const { integrations } = sentryInit.mock.calls[0][0];
  const filtered = integrations([{ name: "ProcessSession" }, { name: "Http" }]);
  assert.deepEqual(
    filtered.map((i) => i.name),
    ["Http"],
  );

  vi.unstubAllEnvs();
});

test("initSentry: SENTRY_ENVIRONMENT defaults to 'production' when unset", () => {
  sentryInit.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  vi.stubEnv("SENTRY_ENVIRONMENT", "");
  initSentry();
  assert.equal(sentryInit.mock.calls[0][0].environment, "production");
  vi.unstubAllEnvs();
});

// --- endSessionAndFlush -------------------------------------------------------

test("endSessionAndFlush: ends the session and flushes", async () => {
  endSession.mockClear();
  flush.mockClear();
  await endSessionAndFlush();
  assert.equal(endSession.mock.calls.length, 1);
  assert.equal(flush.mock.calls.length, 1);
  assert.equal(flush.mock.calls[0][0], 2000);
});

// --- touchHeartbeat / isHeartbeatFresh -----------------------------------------
// Real filesystem, not mocked -- matches tests/backup-postgres.test.mjs's own
// mkdtempSync convention. Both functions default to the real HEARTBEAT_FILE
// path, but take an explicit `path` override precisely so tests never touch
// /tmp/chain-firehose-relay-heartbeat itself.

function withHeartbeatDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "metagraphed-heartbeat-test-"));
  try {
    return fn(path.join(dir, "heartbeat"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("touchHeartbeat: writes the file; isHeartbeatFresh then reports fresh", () => {
  withHeartbeatDir((heartbeatPath) => {
    touchHeartbeat(heartbeatPath);
    assert.equal(isHeartbeatFresh(heartbeatPath), true);
  });
});

test("isHeartbeatFresh: false when the file doesn't exist yet (e.g. still starting up)", () => {
  withHeartbeatDir((heartbeatPath) => {
    assert.equal(isHeartbeatFresh(heartbeatPath), false);
  });
});

test("isHeartbeatFresh: false once now - mtime exceeds maxAgeMs", () => {
  withHeartbeatDir((heartbeatPath) => {
    touchHeartbeat(heartbeatPath);
    const farFuture = Date.now() + 1_000_000;
    assert.equal(isHeartbeatFresh(heartbeatPath, farFuture, 10_000), false);
  });
});

test("isHeartbeatFresh: true when now - mtime is under maxAgeMs", () => {
  withHeartbeatDir((heartbeatPath) => {
    touchHeartbeat(heartbeatPath);
    const soonAfter = Date.now() + 5_000;
    assert.equal(isHeartbeatFresh(heartbeatPath, soonAfter, 10_000), true);
  });
});

test("touchHeartbeat: a write failure (unwritable path) is swallowed, never throws", () => {
  // Passing a DIRECTORY (not a file path) makes writeFileSync throw EISDIR --
  // touchHeartbeat must catch it, not crash the relay's actual job.
  const dir = mkdtempSync(path.join(tmpdir(), "metagraphed-heartbeat-test-"));
  try {
    assert.doesNotThrow(() => touchHeartbeat(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
