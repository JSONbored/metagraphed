import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createPgRootBasketStore } from "../src/root-basket-pg.ts";
import { selectedRootBasketStore } from "../src/root-basket-store.ts";
import type { PgTransaction, PgTransactionRunner } from "../src/pg-pool.ts";
import { handleRootBasketCaptureSync } from "../src/root-basket-capture-sync.ts";
import { handleRootBasketExport } from "../src/root-basket-export.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

const value = syntheticBasketCapture();
function fixture({ ready = true, retained = true, changes = 1 } = {}) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => []);
  const first = vi.fn(async (text: string, _values?: unknown[]) =>
    text.includes("pg_catalog.pg_trigger")
      ? { ready }
      : retained
        ? { capture_id: value.capture_id }
        : null,
  );
  const run = vi.fn(async (_text: string, _values?: unknown[]) => ({
    changes,
  }));
  const tx = { query, first, run } as unknown as PgTransaction;
  const transaction = vi.fn(
    async <T>(
      callback: (tx: PgTransaction) => Promise<T>,
      _options?: { isolation?: "read committed" | "repeatable read" },
    ) => callback(tx),
  );
  const close = vi.fn();
  const store = createPgRootBasketStore({
    transaction: transaction as PgTransactionRunner,
  });
  return { store, tx, query, first, run, transaction, close };
}
const syncRequest = () =>
  new Request("https://example.com/sync", {
    method: "POST",
    headers: { "x-root-basket-capture-sync-token": "test" },
    body: JSON.stringify(value),
  });
const scope = {
  kind: "basket",
  network: value.network,
  network_genesis_hash: value.network_genesis_hash,
  decoder_version: value.decoder_version,
};

test("explicit complete capability is selected and every malformed explicit value fails closed", () => {
  const { store } = fixture();
  for (const env of [null, false, {}, { other: store }])
    assert.equal(selectedRootBasketStore(env), null);
  assert.equal(selectedRootBasketStore({ ROOT_BASKET_STORE: store }), store);
  for (const bad of [
    null,
    undefined,
    false,
    {},
    { write() {} },
    { write() {}, read: {} },
    { write() {}, read: { query() {} } },
    { write: true, read: { query() {}, first() {} } },
  ])
    assert.throws(
      () => selectedRootBasketStore({ ROOT_BASKET_STORE: bad }),
      /ROOT_BASKET_STORE/,
    );
});

test("write is one read-committed lease with exact text quantities and numeric booleans", async () => {
  const f = fixture();
  const receipt = await f.store.write(value, 3000);
  assert.equal(receipt.replayed, false);
  assert.equal(f.transaction.mock.calls.length, 1);
  assert.deepEqual((f.transaction.mock.calls[0] as unknown[])[1], {
    isolation: "read committed",
  });
  assert.match(f.run.mock.calls[0]![0] as string, /pg_catalog, app, pg_temp/);
  const calls = f.run.mock.calls as unknown as [string, unknown[]][];
  const funds = calls.find(([text]) =>
    text.includes("INSERT INTO app.root_basket_fund_snapshots"),
  )!;
  assert.match(funds[0], /shares_atomic text/);
  assert.match(funds[0], /provisional bigint/);
  const row = JSON.parse(funds[1][1] as string)[0];
  assert.equal(row.shares_atomic, value.funds[0]!.shares_atomic);
  assert.equal(row.provisional, 0);
  assert.equal(calls.at(-2)![1][2], "3000");
  assert.match(calls.at(-1)![0], /length\(finalized_block\)/);
  assert.equal(f.close.mock.calls.length, 0);
});

test("provisional and empty captures, batched children and exact replays preserve lifetime", async () => {
  const f = fixture();
  const provisional = syntheticBasketCapture();
  provisional.funds[0]!.baseline = {
    provisional: true,
    first_block: "0",
    price_divisor_q64_bits: null,
    rate0_q32_bits: null,
    tr_splice_q64_bits: null,
  };
  provisional.funds[0]!.holdings = Array.from({ length: 1001 }, (_, i) => ({
    ...provisional.funds[0]!.holdings[1]!,
    netuid: i + 1,
  }));
  await f.store.write(provisional, 1);
  const calls = f.run.mock.calls as unknown as [string, unknown[]][];
  const funds = calls.find(([text]) =>
    text.includes("INSERT INTO app.root_basket_fund_snapshots"),
  )!;
  assert.equal(JSON.parse(funds[1][1] as string)[0].provisional, 1);
  assert.equal(
    calls.filter(([text]) =>
      text.includes("INSERT INTO app.root_basket_holdings"),
    ).length,
    2,
  );
  const empty = {
    ...value,
    expected_funds: 0,
    funds: [],
    pages: [{ ...value.pages[0]!, fund_count: 0 }],
  };
  await f.store.write(empty, 2);
  const replay = fixture({ changes: 0 });
  assert.equal((await replay.store.write(value, 3)).replayed, true);
  assert.equal(replay.run.mock.calls.length, 3);
  assert.match(
    replay.run.mock.calls.at(-1)![0],
    /INSERT INTO app.root_basket_current/,
  );
});

test("validation, missing activation and a missing retained manifest reject before acknowledgment", async () => {
  await assert.rejects(fixture().store.write({}, 1));
  const excessive = {
    ...value,
    expected_funds: 0,
    funds: [],
    expected_pages: 257,
    pages: Array.from({ length: 257 }, (_, i) => ({
      ...value.pages[0]!,
      page_index: i,
      start_after: i ? `0x${i.toString(16).padStart(64, "0")}` : null,
      next_after:
        i === 256 ? null : `0x${(i + 1).toString(16).padStart(64, "0")}`,
      fund_count: 0,
    })),
  };
  const f = fixture();
  await assert.rejects(f.store.write(excessive, 1), /row limits/);
  assert.equal(f.transaction.mock.calls.length, 0);
  await assert.rejects(
    fixture({ ready: false }).store.write(value, 1),
    /not activated/,
  );
  await assert.rejects(
    fixture({ retained: false }).store.write(value, 1),
    /absent/,
  );
});

test("native reads share the transaction pool and forward optional query parameters", async () => {
  const f = fixture();
  await f.store.read.query("SELECT 1");
  await f.store.read.first("SELECT ?", [1]);
  assert.deepEqual(f.query.mock.calls.at(-1), ["SELECT 1", undefined]);
  assert.deepEqual(f.first.mock.calls.at(-1), ["SELECT ?", [1]]);
  await assert.rejects(
    fixture({ ready: false }).store.read.query("SELECT 1"),
    /not activated/,
  );
});

test("protected sync selects the native writer before invalid legacy ownership and never closes it", async () => {
  const f = fixture();
  const env = {
    ROOT_BASKET_CAPTURE_SYNC_SECRET: "test",
    ROOT_BASKET_STORE: f.store,
    D1_STATE_TABLES: "root_basket_captures",
  };
  const reply = await handleRootBasketCaptureSync(syncRequest(), env, {
    now: () => 3000,
  });
  assert.equal(reply.status, 200);
  assert.equal(((await reply.json()) as { ok: boolean }).ok, true);
  assert.equal(f.close.mock.calls.length, 0);
  for (const bad of [null, undefined, {}]) {
    const reply = await handleRootBasketCaptureSync(syncRequest(), {
      ...env,
      ROOT_BASKET_STORE: bad,
    });
    assert.equal(reply.status, 503);
  }
  const conflict = {
    ...f.store,
    write: async () => {
      throw new Error("ROOT_BASKET_CAPTURE_CONFLICT: mismatch");
    },
  };
  assert.equal(
    (
      await handleRootBasketCaptureSync(syncRequest(), {
        ...env,
        ROOT_BASKET_STORE: conflict,
      })
    ).status,
    409,
  );
});

test("export retains envelopes and native cursor SQL, failing closed on explicit bad capability", async () => {
  const f = fixture();
  for (const operation of ["ceiling", "discover", "rows"]) {
    const result = await handleRootBasketExport(
      {
        ...scope,
        operation,
        through: value.capture_id,
        table: "root_basket_holdings",
        capture_id: value.capture_id,
      },
      { ROOT_BASKET_STORE: f.store },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.match(
    (f.query.mock.calls.at(-1) as unknown[])[0] as string,
    /json_build_array\(t.hotkey,t.netuid\)::text/,
  );
  for (const bad of [null, undefined, {}])
    assert.equal(
      (
        await handleRootBasketExport(
          { ...scope, operation: "ceiling" },
          { ROOT_BASKET_STORE: bad },
        )
      ).status,
      503,
    );
});
