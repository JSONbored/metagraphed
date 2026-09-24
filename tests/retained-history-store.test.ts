import { expect, it, vi } from "vitest";
import { hasRetainedHistoryStore } from "../src/retained-history-store.ts";
import { answerAccountSummary } from "../src/account-summary-card.ts";
import { answerAccountEntities } from "../src/account-entities-answer.ts";
import { loadSubnetOhlcColdTier } from "../src/subnet-ohlc-cold-tier.ts";
import {
  loadChainEventRollup,
  CHAIN_SERVING_ROLLUP,
} from "../src/chain-event-rollup-cold-tier.ts";
import { loadBlockFromR2Sql } from "../src/r2-sql-blocks.ts";
import { mockEnv } from "./row-type.ts";
const address = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
it("distinguishes a configured history store from a deployment with none", () => {
  for (const env of [
    undefined,
    null,
    {},
    { METAGRAPH_ARCHIVE: {} },
    { METAGRAPH_ARCHIVE: { get: async () => null } },
    { NATIVE_PROJECTIONS: "disabled" },
    { NATIVE_PROJECTIONS: "" },
  ])
    expect(hasRetainedHistoryStore(env)).toBe(false);
  expect(hasRetainedHistoryStore({ NATIVE_PROJECTIONS: "enabled" })).toBe(true);
});
it("keeps history failures visible after removing the SQL token", async () => {
  const env = mockEnv({
    NATIVE_PROJECTIONS: "enabled",
    METAGRAPH_ARCHIVE: { get: async () => null },
  });
  const fetch = vi.fn(() => {
    throw new Error("SQL must not run");
  });
  vi.stubGlobal("fetch", fetch);
  expect((await answerAccountSummary(env, address)).kind).toBe("gap");
  expect(
    (
      await answerAccountEntities(env, address, null, {
        coldTier: async () => null,
        owners: async () => null,
      })
    ).degraded,
  ).toBeDefined();
  expect(
    await loadSubnetOhlcColdTier(env, 7, { interval: "1h", days: 1 }),
  ).toEqual({ kind: "gap" });
  expect(
    await loadChainEventRollup(env, CHAIN_SERVING_ROLLUP, { windowDays: 1 }),
  ).toEqual({ kind: "gap" });
  for (const ref of ["42", "0x" + "a".repeat(64)])
    expect(await loadBlockFromR2Sql(env, ref)).toHaveProperty("degraded");
  expect(fetch).not.toHaveBeenCalled();
});
