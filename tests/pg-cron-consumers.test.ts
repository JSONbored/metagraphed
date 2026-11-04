import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { test, vi } from "vitest";
import {
  createPgCronDispatcher,
  type NativeCronEvent,
} from "../src/pg-cron.ts";
import {
  EMBEDDING_SYNC_CRON,
  SELF_HEALTH_PROBE_CRON,
} from "../workers/config.ts";
import { NEON_PRUNE_CRON } from "../src/neon-prune.ts";
import { apiEnv, dataApiEnv, registrySyncEnv } from "./helpers/worker-env.ts";
import { cronFixture } from "./helpers/cron-fixture.ts";

vi.resetModules();
const { default: api } = await import("../workers/api.ts");
const { default: data } = await import("../workers/data-api.ts");
const { default: registry } = await import("../workers/registry-sync-api.ts");

test("dispatch invokes existing owner handlers with their exact cron and preserves domain results", async () => {
  const db = new PGlite();
  const { scheduler } = await cronFixture(db, [
    { owner: "api", cron: EMBEDDING_SYNC_CRON },
    { owner: "data", cron: NEON_PRUNE_CRON },
    { owner: "registry", cron: SELF_HEALTH_PROBE_CRON },
  ]);
  const fetch = vi.fn(() => {
    throw new Error("This fixture must not contact a network");
  });
  vi.stubGlobal("fetch", fetch);
  const invoke = async (
    event: NativeCronEvent,
    handler: (
      controller: ScheduledController,
      context: ExecutionContext,
    ) => Promise<unknown>,
  ) => {
    const pending: Promise<unknown>[] = [];
    const result = await handler(
      {
        ...event,
        noRetry() {
          throw new Error("Current cron owners do not call noRetry");
        },
      },
      {
        waitUntil(value: Promise<unknown>) {
          pending.push(value);
        },
      } as ExecutionContext,
    );
    await Promise.all(pending);
    return result;
  };
  try {
    await scheduler.register(0);
    await scheduler.plan();
    const dispatch = createPgCronDispatcher(scheduler, {
      api: {
        scheduled: (event) =>
          invoke(event, (controller, ctx) =>
            api.scheduled(controller, apiEnv(), ctx),
          ),
      },
      data: {
        scheduled: (event) =>
          invoke(event, (controller, ctx) =>
            data.scheduled(controller, dataApiEnv(), ctx),
          ),
      },
      registry: {
        scheduled: (event) =>
          invoke(event, (controller, ctx) =>
            registry.scheduled(controller, registrySyncEnv(), ctx),
          ),
      },
    });
    const results = new Map();
    for (let index = 0; index < 3; index++) {
      const result = await dispatch();
      assert.equal(result.status, "completed");
      assert.ok("owner" in result);
      assert.ok("result" in result);
      results.set(result.owner, result.result);
    }
    assert.deepEqual(results.get("api"), {
      ok: false,
      reason: "ai_unconfigured",
    });
    assert.deepEqual(results.get("data"), { attempted: false });
    assert.deepEqual(results.get("registry"), {
      attempted: false,
      reason: "no postgres runner",
    });
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
    await scheduler.close();
    await db.close();
  }
});
