// The neurons lane carries a second write, and these are the two properties
// that makes load-bearing (#10262, and #10849 item 5 which moved it into the
// registry).
//
// tests/subnet-lifecycle.test.ts asserts the same two by reading workers/api.ts
// as TEXT and matching regexes against it. That was the only option while the
// logic lived inside a cron branch, which is reachable only through
// handleScheduled with a live-ish env -- but a regex over source cannot tell you
// the code RUNS, only that it is written down, and it goes blind the moment a
// formatter rewraps the line. Now the lane is a callable registry entry, so both
// are asserted by executing it.
import assert from "node:assert/strict";
import { describe, expect, test, vi } from "vitest";

const lifecycleCalls: Array<Record<string, unknown>> = [];
let lifecycleRejects = false;

vi.mock("../src/subnet-lifecycle.ts", () => ({
  runSubnetLifecycleLane: async (
    _env: unknown,
    opts: Record<string, unknown>,
  ) => {
    lifecycleCalls.push(opts);
    if (lifecycleRejects) throw new Error("lifecycle write failed");
    return { ok: true };
  },
}));

vi.mock("../src/neurons-staleness-watchdog.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The alarm is the half that must survive everything else.
  runNeuronsStalenessWatchdog: async () => ({ ok: true, alerted: false }),
}));

async function neuronsLane() {
  const { STALENESS_WATCHDOGS } = await import("../workers/api.ts");
  const lane = STALENESS_WATCHDOGS.find((l) => l.name === "neurons-staleness");
  assert.ok(lane, "the neurons lane is registered");
  return lane;
}

describe("the neurons lane's lifecycle rider (#10262)", () => {
  test("a lifecycle FAILURE cannot cost the estate the staleness verdict", async () => {
    // The load-bearing half is the alarm. The lifecycle write is deliberately
    // after it and its rejection swallowed, so a broken lifecycle lane degrades
    // to "no lifecycle row" rather than to "no neurons alarm".
    lifecycleRejects = true;
    const lane = await neuronsLane();
    const result = await lane.run({ env: {} as never, ctx: undefined });
    assert.deepEqual(
      result,
      { ok: true, alerted: false },
      "the verdict survives",
    );
    lifecycleRejects = false;
  });

  test("a ctx WITH waitUntil gets the lifecycle promise", async () => {
    const seen: unknown[] = [];
    const lane = await neuronsLane();
    await lane.run({
      env: {} as never,
      ctx: { waitUntil: (p: unknown) => seen.push(p) } as never,
    });
    assert.equal(seen.length, 1, "the write is detached, not awaited");
    await seen[0];
  });

  test("a ctx with NO waitUntil is awaited, not thrown on", async () => {
    // A bare `{}` ctx reaches here from callers that have none to give, and
    // calling ctx.waitUntil on it would throw -- taking the staleness alarm down
    // with it, which is the outcome the guard exists to prevent. Awaiting is the
    // fallback rather than dropping the promise, because a floating promise in
    // an isolate about to end is work silently not done.
    const before = lifecycleCalls.length;
    const lane = await neuronsLane();
    const result = await lane.run({ env: {} as never, ctx: {} as never });
    assert.deepEqual(result, { ok: true, alerted: false });
    assert.equal(
      lifecycleCalls.length,
      before + 1,
      "the lifecycle lane still ran",
    );
  });

  test("the guard is not vacuous — a real ctx.waitUntil would throw here", () => {
    // Proves the branch above is worth having: calling waitUntil on the bare
    // object the fallback exists for does throw.
    const bare = {} as { waitUntil?: (p: unknown) => void };
    expect(() => bare.waitUntil!(Promise.resolve())).toThrow();
  });
});
