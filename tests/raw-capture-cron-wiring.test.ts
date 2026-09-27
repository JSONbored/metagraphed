import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const { capture } = vi.hoisted(() => ({
  capture: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/raw-capture-sync.ts", () => ({ runRawCaptureSync: capture }));

import { handleScheduled } from "../workers/api.ts";
import { RAW_CAPTURE_CRON } from "../workers/config.ts";

afterEach(() => capture.mockClear());

test("the deployed cron wires the D1 raw writer only for explicit D1 selection", async () => {
  for (const storage of ["d1", "r2", undefined]) {
    const pending: Promise<unknown>[] = [];
    const env = {
      RAW_CAPTURE_STORAGE: storage,
      D1_STATE: { prepare: vi.fn(), batch: vi.fn() },
    } as unknown as Parameters<typeof handleScheduled>[1];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExecutionContext;
    await handleScheduled(
      { cron: RAW_CAPTURE_CRON } as ScheduledController,
      env,
      ctx,
    );
    const calls = capture.mock.calls as unknown as [
      unknown,
      { d1CaptureStore?: { put: unknown } },
    ][];
    const [received, deps] = calls.at(-1)!;
    assert.equal(received, env);
    assert.equal(
      typeof deps.d1CaptureStore?.put,
      storage === "d1" ? "function" : "undefined",
    );
    await Promise.all(pending);
  }
});
