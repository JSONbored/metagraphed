import assert from "node:assert/strict";
import { test } from "vitest";
import { chainCoreNetwork, chainViewsStore } from "../src/chain-core-read.ts";

test("the chain core's views are read only where the native application binds a queryable store", () => {
  const store = { query: async () => [] };
  assert.equal(
    chainViewsStore({ NATIVE_CHAIN_READ_STORE: { tables: [], store } }),
    store,
  );
  for (const env of [
    null,
    {},
    { NATIVE_CHAIN_READ_STORE: null },
    { NATIVE_CHAIN_READ_STORE: { store: {} } },
  ])
    assert.equal(chainViewsStore(env), null);
});

test("the chain core keys mainnet by its chain's name and every other network as itself", () => {
  assert.equal(chainCoreNetwork("mainnet"), "finney");
  assert.equal(chainCoreNetwork("testnet"), "testnet");
});
