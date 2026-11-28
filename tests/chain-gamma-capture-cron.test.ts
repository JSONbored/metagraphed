import assert from "node:assert/strict";
import { test } from "vitest";
import { handleScheduled } from "../workers/api.ts";
import { SUBNET_BURN_CAPTURE_CRON } from "../workers/config.ts";

// The Gamma capture rides the burn tick (src/chain-gamma-capture.ts). With no
// store bound, both lanes decline by name, each records its own verdict, and
// neither throws: the burn series' result is still what the cron reports.
test("the burn capture tick also captures gamma, each lane with its own verdict", async () => {
  const waited: Promise<unknown>[] = [];
  const result = (await handleScheduled(
    { cron: SUBNET_BURN_CAPTURE_CRON } as unknown as ScheduledController,
    {} as unknown as Env,
    {
      waitUntil(promise: Promise<unknown>) {
        waited.push(promise);
      },
    } as unknown as ExecutionContext,
  )) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_store_binding");
  // Both verdicts were scheduled, burn's and gamma's, and both settle.
  const settled = await Promise.allSettled(waited);
  assert.ok(settled.length >= 2);
});
