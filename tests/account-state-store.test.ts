import assert from "node:assert/strict";
import { test } from "vitest";
import { selectedAccountStateStore } from "../src/account-state-store.ts";
import { createNativeAccountState } from "../src/native-account-state.ts";

test("native account selection requires the complete family and never falls back on malformed presence", () => {
  const store = createNativeAccountState({
    async transaction() {
      throw new Error("not used");
    },
  });
  for (const env of [undefined, null, "invalid", {}])
    assert.equal(selectedAccountStateStore(env), null);
  assert.equal(
    selectedAccountStateStore({ ACCOUNT_STATE_STORE: store }),
    store,
  );
  const invalid = [
    null,
    42,
    {},
    { ...store, sql: null },
    { ...store, sql: () => [] },
    { ...store, sql: Object.assign(() => [], { unsafe: null }) },
    { ...store, usage: null },
    { ...store, usage: 42 },
    { ...store, quota: null },
    { ...store, quota: 42 },
    { ...store, quota: {} },
    { ...store, quota: { spend: true } },
    { ...store, blocks: null },
    { ...store, blocks: 42 },
    { ...store, blocks: {} },
    { ...store, blocks: { read: true } },
  ];
  for (const value of invalid)
    assert.throws(
      () => selectedAccountStateStore({ ACCOUNT_STATE_STORE: value }),
      /incomplete/,
    );
  for (const method of [
    "increment",
    "writeRollup",
    "accountRows",
    "anomalyRows",
    "rollupRows",
  ])
    for (const value of [undefined, 42])
      assert.throws(
        () =>
          selectedAccountStateStore({
            ACCOUNT_STATE_STORE: {
              ...store,
              usage: { ...store.usage, [method]: value },
            },
          }),
        /usage capability/,
      );
});
