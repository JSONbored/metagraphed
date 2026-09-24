import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  loadRpcUsageColdTier,
  windowCutoffMs,
} from "../src/rpc-usage-cold-tier.ts";
import { loadRpcUsageNative } from "../src/rpc-usage-native.ts";
vi.mock("../src/rpc-usage-native.ts", () => ({ loadRpcUsageNative: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadRpcUsageNative).mockReset();
});
const now = Date.UTC(2026, 8, 24),
  env = { R2_SQL_TOKEN: "legacy-test" };
test("supported windows preserve exact cutoff and bucket configuration", async () => {
  for (const window of ["1h", "24h", "7d", "30d"]) {
    const bounds = windowCutoffMs(window, now);
    if (!bounds) continue;
    const expected = { window, summary: { total_requests: 42 } };
    vi.mocked(loadRpcUsageNative).mockResolvedValue(expected);
    assert.deepEqual(
      await loadRpcUsageColdTier(env, { window, now, until: now - 1 }),
      expected,
    );
    assert.deepEqual(vi.mocked(loadRpcUsageNative).mock.calls.at(-1), [
      env,
      { window, ...bounds, until: now - 1, now },
    ]);
  }
});
test("unsupported windows and unusable ceilings keep the published defaults", async () => {
  vi.mocked(loadRpcUsageNative).mockResolvedValue(null);
  for (const until of [undefined, null, 0, -1, 1.5, Infinity, NaN]) {
    assert.equal(
      await loadRpcUsageColdTier(env, { window: "unknown", now, until }),
      null,
    );
    assert.deepEqual(vi.mocked(loadRpcUsageNative).mock.calls.at(-1)?.[1], {
      window: "7d",
      ...windowCutoffMs("7d", now),
      until: null,
      now,
    });
  }
  vi.spyOn(Date, "now").mockReturnValue(now);
  await loadRpcUsageColdTier(env);
  assert.equal(vi.mocked(loadRpcUsageNative).mock.calls.at(-1)?.[1].now, now);
});
test("invalid clocks decline before storage and missing owners never use SQL", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("No SQL"));
  assert.equal(windowCutoffMs("unknown", now), null);
  for (const time of [0, NaN, Infinity, now + 0.5])
    assert.equal(await loadRpcUsageColdTier(env, { now: time }), null);
  assert.equal(vi.mocked(loadRpcUsageNative).mock.calls.length, 0);
  for (const value of [undefined, null]) {
    vi.mocked(loadRpcUsageNative).mockResolvedValue(value);
    assert.equal(await loadRpcUsageColdTier(env, { now }), null);
  }
  assert.equal(fetch.mock.calls.length, 0);
});
