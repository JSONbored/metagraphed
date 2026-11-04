import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { apiEnv } from "./helpers/worker-env.ts";

vi.mock("../src/health-prober.ts", async (original) => ({
  ...(await original<typeof import("../src/health-prober.ts")>()),
  runHealthProber: vi.fn(async () => ({ ok: true })),
}));

import { runHealthProber } from "../src/health-prober.ts";
import { HEALTH_PROBER_CRON } from "../workers/config.ts";
import { handleScheduled } from "../workers/api.ts";

afterEach(() => vi.restoreAllMocks());

test("the health cron bootstraps the selected native chain owner and retains best-effort behavior", async () => {
  const calls: Request[] = [];
  let fail = false;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const env = apiEnv({
    CHAIN_FIREHOSE_SERVICE: {
      async fetch(request: Request) {
        calls.push(request);
        if (fail) throw new Error("chain unavailable");
        return new Response("{}");
      },
    },
    CHAIN_FIREHOSE_HUB: {
      get() {
        throw new Error("legacy fallback");
      },
    },
  });
  const deferred: Promise<unknown>[] = [];
  const controller = {
    cron: HEALTH_PROBER_CRON,
    scheduledTime: Date.now(),
  } as ScheduledController;
  const context = {
    waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
  } as unknown as ExecutionContext;
  assert.deepEqual(await handleScheduled(controller, env, context), {
    ok: true,
  });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(new URL(calls[0]!.url).pathname, "/poll-start");
  fail = true;
  assert.deepEqual(await handleScheduled(controller, env, context), {
    ok: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(vi.mocked(runHealthProber).mock.calls.length, 2);
  assert.ok(
    errors.mock.calls.some(
      ([message]) => message === "[head-poller-bootstrap]",
    ),
  );
  await Promise.all(deferred);
});
