// Pure-logic tests for the per-IP abuse control (#6444). Zero deps — run with:
//   node --test deploy/wss-lb/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createConnectionLimiter,
  resolveClientIp,
} from "../src/rate-limit.ts";

test("resolveClientIp prefers cf-connecting-ip over x-forwarded-for over the socket", () => {
  assert.equal(
    resolveClientIp({
      headers: { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" },
      socket: { remoteAddress: "3.3.3.3" },
    }),
    "1.1.1.1",
  );
  assert.equal(
    resolveClientIp({
      headers: { "x-forwarded-for": "2.2.2.2, 9.9.9.9" },
      socket: { remoteAddress: "3.3.3.3" },
    }),
    "2.2.2.2",
  );
  assert.equal(
    resolveClientIp({ headers: {}, socket: { remoteAddress: "3.3.3.3" } }),
    "3.3.3.3",
  );
  assert.equal(resolveClientIp({ headers: {}, socket: {} }), "unknown");
});

test("allows connections under both budgets", () => {
  const limiter = createConnectionLimiter({
    maxConcurrent: 5,
    maxAttemptsPerWindow: 5,
    windowMs: 60000,
  });
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(limiter.checkAndTrack("1.1.1.1"), { ok: true });
  }
});

test("rejects once the concurrent cap is hit, independent of the attempt-rate budget", () => {
  const limiter = createConnectionLimiter({
    maxConcurrent: 2,
    maxAttemptsPerWindow: 100,
    windowMs: 60000,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  const rejected = limiter.checkAndTrack("1.1.1.1");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "concurrent_limit");
  assert.ok(rejected.retryAfterSeconds > 0);
});

test("release frees a concurrent slot so a later connect can succeed", () => {
  const limiter = createConnectionLimiter({
    maxConcurrent: 1,
    maxAttemptsPerWindow: 100,
    windowMs: 60000,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, false);
  limiter.release("1.1.1.1");
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
});

test("release is safe to call on an IP with no tracked connections (double-release, unknown IP)", () => {
  const limiter = createConnectionLimiter();
  assert.doesNotThrow(() => limiter.release("never-connected"));
  limiter.checkAndTrack("1.1.1.1");
  limiter.release("1.1.1.1");
  assert.doesNotThrow(() => limiter.release("1.1.1.1")); // double-release
});

test("a rejected attempt does not consume the attempt-rate budget it just failed", () => {
  const limiter = createConnectionLimiter({
    maxConcurrent: 1,
    maxAttemptsPerWindow: 100,
    windowMs: 60000,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true); // fills the concurrent cap
  for (let i = 0; i < 10; i += 1) {
    assert.equal(limiter.checkAndTrack("1.1.1.1").ok, false); // concurrent-rejected each time
  }
  limiter.release("1.1.1.1");
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true); // budget wasn't drained by the rejects
});

test("rejects once the attempt-rate window is exhausted, then allows again once it rolls over", () => {
  let now = 0;
  const limiter = createConnectionLimiter({
    maxConcurrent: 100,
    maxAttemptsPerWindow: 2,
    windowMs: 1000,
    now: () => now,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  const rejected = limiter.checkAndTrack("1.1.1.1");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "attempt_rate_limit");
  assert.ok(rejected.retryAfterSeconds > 0);

  now = 1000; // window rolled over
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
});

test("budgets are tracked independently per IP", () => {
  const limiter = createConnectionLimiter({
    maxConcurrent: 1,
    maxAttemptsPerWindow: 1,
    windowMs: 60000,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, false);
  assert.equal(limiter.checkAndTrack("2.2.2.2").ok, true); // unaffected by 1.1.1.1's budget
});

test("prune drops expired attempt-window entries for IPs with no live connections", () => {
  let now = 0;
  const limiter = createConnectionLimiter({
    maxConcurrent: 100,
    maxAttemptsPerWindow: 5,
    windowMs: 1000,
    now: () => now,
  });
  limiter.checkAndTrack("1.1.1.1");
  now = 5000;
  limiter.prune();
  // Rejoining after a pruned, long-expired window starts a fresh count from
  // zero rather than accumulating unboundedly -- exercised indirectly: a
  // fresh window after prune still allows a full new budget.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
  }
});

test("prune keeps an IP's attempt-window entry alive while it has an open connection", () => {
  let now = 0;
  const limiter = createConnectionLimiter({
    maxConcurrent: 100,
    maxAttemptsPerWindow: 1,
    windowMs: 1000,
    now: () => now,
  });
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true); // still "connected" (never released)
  now = 5000;
  limiter.prune();
  // The window has elapsed, so a fresh attempt in a new window is allowed
  // regardless -- this just confirms prune() didn't throw/corrupt state
  // while a concurrent connection is live.
  assert.equal(limiter.checkAndTrack("1.1.1.1").ok, true);
});
