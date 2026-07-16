import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

// #6032: usage telemetry is instrumented at a single shared chokepoint
// (handleRequest) so every REST route and the /api/v1/graphql POST record
// exactly one usage event, without touching individual route handlers, and
// without ever changing a response or letting a telemetry failure surface.
//
// The chokepoint reads an injected `ctx.recordUsageEvent` when present (the same
// seam the MCP-dispatch instrumentation uses), so these tests observe the event
// it schedules without standing up PostHog.

function req(path, init) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

test("a REST request schedules exactly one usage event (route + ok + coarse latency)", async () => {
  const captured = [];
  const ctx = {
    recordUsageEvent: (_env, event) => {
      captured.push(event);
      return true;
    },
  };
  // OPTIONS preflight returns deterministically without any env bindings, so it
  // exercises the wrapper without depending on a route's data tier.
  const res = await handleRequest(
    req("/api/v1/health", { method: "OPTIONS" }),
    {},
    ctx,
  );
  assert.equal(typeof res.status, "number");
  assert.equal(captured.length, 1);
  const event = captured[0];
  assert.equal(event.route, "/api/v1/health");
  assert.equal(typeof event.ok, "boolean");
  assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
});

test("the /api/v1/graphql POST records under the graphql route (GraphQL transport covered at the same point)", async () => {
  const captured = [];
  const ctx = {
    recordUsageEvent: (_env, event) => {
      captured.push(event);
      return true;
    },
  };
  // The GraphQL handler may reject without its env bindings; the chokepoint fires
  // in the wrapper's `finally` regardless, which is exactly what we assert here.
  try {
    await handleRequest(
      req("/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      }),
      {},
      ctx,
    );
  } catch {
    // A missing-binding throw still ran the chokepoint before propagating.
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].route, "/api/v1/graphql");
});

test("a telemetry recorder that throws never breaks the response", async () => {
  const control = await handleRequest(
    req("/api/v1/health", { method: "OPTIONS" }),
    {},
    {},
  );
  const throwingCtx = {
    recordUsageEvent: () => {
      throw new Error("posthog exploded");
    },
  };
  const res = await handleRequest(
    req("/api/v1/health", { method: "OPTIONS" }),
    {},
    throwingCtx,
  );
  // Byte-for-byte the same response the request would have produced with no
  // telemetry wired in — the failure is fully swallowed.
  assert.equal(res.status, control.status);
  assert.equal(
    res.headers.get("access-control-allow-methods"),
    control.headers.get("access-control-allow-methods"),
  );
});

test("the scheduled capture is handed to ctx.waitUntil when the executionCtx provides it", async () => {
  const scheduled = [];
  const ctx = {
    waitUntil: (promise) => scheduled.push(promise),
    recordUsageEvent: () => true,
  };
  await handleRequest(req("/api/v1/health", { method: "OPTIONS" }), {}, ctx);
  assert.equal(scheduled.length, 1);
  assert.equal(typeof scheduled[0].then, "function");
});
