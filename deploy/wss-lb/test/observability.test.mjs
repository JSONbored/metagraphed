// Pure-logic tests for wss-lb's Sentry aggregate-reporting window. Zero deps
// (no real Sentry.init call is ever needed to exercise this logic) — run
// with: node --test deploy/wss-lb/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_UPSTREAM_REPORT_THRESHOLD,
  NO_UPSTREAM_REPORT_INTERVAL_MS,
  computeNoUpstreamWindowUpdate,
  initSentry,
} from "../src/observability.mjs";

test("computeNoUpstreamWindowUpdate: does not report before the count threshold or interval is reached", () => {
  const update = computeNoUpstreamWindowUpdate(null, "finney", 1_000_000);
  assert.equal(update.report, false);
  assert.equal(update.count, 1);
  assert.equal(update.lastNetwork, "finney");
  assert.deepEqual(update.nextWindow, { startedAt: 1_000_000, count: 1 });
});

test("computeNoUpstreamWindowUpdate: reports once the count threshold is crossed", () => {
  let window = null;
  let update;
  for (let i = 0; i < NO_UPSTREAM_REPORT_THRESHOLD; i += 1) {
    update = computeNoUpstreamWindowUpdate(window, "finney", 1_000_000);
    window = update.nextWindow;
  }
  assert.equal(update.report, true);
  assert.equal(update.count, NO_UPSTREAM_REPORT_THRESHOLD);
  assert.equal(update.nextWindow, null); // resets after reporting
});

test("computeNoUpstreamWindowUpdate: reports once the interval elapses, even below the count threshold", () => {
  const first = computeNoUpstreamWindowUpdate(null, "finney", 1_000_000);
  const later = computeNoUpstreamWindowUpdate(
    first.nextWindow,
    "finney",
    1_000_000 + NO_UPSTREAM_REPORT_INTERVAL_MS,
  );
  assert.equal(later.report, true);
  assert.equal(later.count, 2);
});

test("computeNoUpstreamWindowUpdate: tracks the most recently affected network", () => {
  const first = computeNoUpstreamWindowUpdate(null, "finney", 1_000_000);
  const second = computeNoUpstreamWindowUpdate(
    first.nextWindow,
    "test",
    1_000_100,
  );
  assert.equal(second.lastNetwork, "test");
});

test("computeNoUpstreamWindowUpdate: two independent windows never leak state into one another", () => {
  // Regression test for the same class of bug chain-firehose-relay.ts's own
  // computeDropWindowUpdate test suite guards against: passing `null` must
  // always mean "a genuinely fresh window," never a stale value from a prior
  // call, since this function deliberately holds no module-level state itself.
  const windowA = computeNoUpstreamWindowUpdate(
    null,
    "finney",
    1_000_000,
  ).nextWindow;
  const windowB = computeNoUpstreamWindowUpdate(null, "test", 5_000_000);
  assert.equal(windowB.count, 1, "windowB must not include windowA's count");
  assert.notEqual(windowA.startedAt, windowB.startedAt);
});

test("initSentry: no-op (does not throw) when SENTRY_DSN is unset", () => {
  const prior = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  try {
    assert.doesNotThrow(() => initSentry());
  } finally {
    if (prior !== undefined) process.env.SENTRY_DSN = prior;
  }
});
