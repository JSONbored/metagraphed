import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { loadSelfHealthColdTier } from "../src/self-health-cold-tier.ts";
import { selectedD1Store, createD1Sql } from "../src/d1-store.ts";
import { loadSelfHealthNeon } from "../src/self-health-neon.ts";
import { buildSelfHealth } from "../src/self-health.ts";
vi.mock("../src/d1-store.ts", () => ({
  selectedD1Store: vi.fn(),
  createD1Sql: vi.fn(),
}));
vi.mock("../src/self-health-neon.ts", () => ({ loadSelfHealthNeon: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const env = { R2_SQL_TOKEN: "legacy-test" };
test("D1 health preserves the canonical payload and explicit clock", async () => {
  const expected = buildSelfHealth([], []),
    store = {} as never;
  vi.mocked(selectedD1Store).mockReturnValue(store);
  vi.mocked(loadSelfHealthNeon).mockImplementation(async (_sql, clock) => {
    assert.equal(clock?.(), 1234);
    return expected;
  });
  assert.deepEqual(await loadSelfHealthColdTier(env, 1234), expected);
  assert.equal(vi.mocked(createD1Sql).mock.calls.at(-1)?.[0], store);
});
test("default clock and store failures never revive SQL", async () => {
  vi.spyOn(Date, "now").mockReturnValue(9876);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("No SQL"));
  vi.mocked(selectedD1Store).mockReturnValue({} as never);
  vi.mocked(loadSelfHealthNeon).mockImplementation(async (_sql, clock) => {
    assert.equal(clock?.(), 9876);
    throw Error("D1 unavailable");
  });
  assert.equal(await loadSelfHealthColdTier(env), null);
  vi.mocked(selectedD1Store).mockReturnValue(null);
  assert.equal(await loadSelfHealthColdTier(env), null);
  vi.mocked(selectedD1Store).mockImplementation(() => {
    throw Error("Incomplete owner");
  });
  assert.equal(await loadSelfHealthColdTier(env), null);
  assert.equal(fetch.mock.calls.length, 0);
});
