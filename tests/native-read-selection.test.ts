import assert from "node:assert/strict";
import { test } from "vitest";
import { readStore, type ReadStoreDb } from "../src/read-store.ts";
import { loadTaoUsdSeries } from "../src/tao-usd-series.ts";

test("native selection routes an existing reader through the supplied process capability", async () => {
  const calls: string[] = [];
  const store: ReadStoreDb = {
    async query<Row>(text: string) {
      calls.push(text);
      return [
        {
          block_number: 10,
          observed_at: 1000000000000,
          usd_per_tao: 25,
          price_basis: "native",
          eth_usd: null,
          pool_count: 1,
          pools: "[]",
        },
      ] as Row[];
    },
    async first<Row>() {
      return null as Row | null;
    },
  };
  const env = {
    NATIVE_READ_STORE: { tables: ["tao_usd_index"], store },
    D1_STATE_TABLES: "tao_usd_index",
    D1_STATE: {
      prepare() {
        throw new Error("legacy store selected");
      },
    },
    HYPERDRIVE: { connectionString: "postgresql://legacy.invalid/db" },
  };
  const selected = readStore(env, ["tao_usd_index"]);
  assert.equal(selected, store);
  const rows = await loadTaoUsdSeries(selected!, {
    windowHours: 1,
    now: () => 1000000000100,
  });
  assert.equal(rows?.[0]?.usd_per_tao, 25);
  assert.ok(calls.some((text) => text.includes("tao_usd_index")));
});

test("native ownership is all-or-none and an invalid selection cannot fall back", () => {
  const store: ReadStoreDb = { query: async () => [], first: async () => null };
  const env = { NATIVE_READ_STORE: { tables: ["owned"], store } };
  assert.equal(readStore(env, []), undefined);
  assert.equal(readStore(env, ["owned", "owned"]), store);
  assert.throws(() => readStore(env, ["owned", "missing"]), /does not own/);
  assert.throws(() => readStore(env, ["missing"]), /does not own/);
  for (const value of [
    null,
    1,
    {},
    { tables: "owned", store },
    { tables: [1], store },
    { tables: [], store: {} },
    { tables: [], store: { query() {} } },
  ]) {
    assert.throws(
      () => readStore({ NATIVE_READ_STORE: value }, ["owned"]),
      /invalid/,
    );
  }
  assert.equal(readStore({ NATIVE_READ_STORE: null }, ["owned"], store), store);
  assert.equal(readStore({}, ["owned"]), undefined);
});
