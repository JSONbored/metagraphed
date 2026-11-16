import assert from "node:assert/strict";
import { test } from "vitest";
import { selectedAccountBlockStore } from "../src/account-block-store.ts";
import { createPgAccountBlocks } from "../src/account-block-pg.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

test("native block authority is explicit and malformed presence cannot fall back", () => {
  for (const env of [null, undefined, false, "invalid", {}])
    assert.equal(selectedAccountBlockStore(env), null);
  for (const value of [null, {}, { read: true }])
    assert.throws(
      () => selectedAccountBlockStore({ ACCOUNT_BLOCK_STORE: value }),
      /incomplete/,
    );
  const store = {
    read: async () => ({ blocked: false, reasonCode: null, message: null }),
  };
  assert.equal(
    selectedAccountBlockStore({ ACCOUNT_BLOCK_STORE: store }),
    store,
  );
});

test("native authority matches source numeric IDs and exposes only published reasons", async () => {
  const queries: { text: string; values?: unknown[] }[] = [];
  let found = true;
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(callback, options) {
      assert.deepEqual(options, { isolation: "read committed" });
      return callback({
        async query<Row>() {
          return [] as Row[];
        },
        async run() {
          return { changes: 0 };
        },
        async first<Row>(text: string, values?: unknown[]) {
          queries.push({ text, values });
          return (
            found ? { reason_code: "billing_unpaid" } : null
          ) as Row | null;
        },
      });
    },
  };
  const store = createPgAccountBlocks(runtime);
  for (const id of [0, -1, 0.5, Infinity])
    assert.equal((await store.read(id, "rpc")).blocked, false);
  assert.equal(queries.length, 0);
  assert.equal((await store.read(42, "github")).reasonCode, "billing_unpaid");
  assert.match(queries[0].text, /account_id=\?::numeric/);
  assert.deepEqual(queries[0].values, ["github", "42"]);
  assert.equal((await store.read(9007199254740992, "rpc")).blocked, true);
  assert.match(queries[1].text, /account_id::double precision/);
  found = false;
  assert.equal((await store.read(42, "github")).blocked, false);
});
