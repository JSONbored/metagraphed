import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
const indexed = vi.hoisted(() => ({ block: vi.fn(), hash: vi.fn() }));
vi.mock("../src/indexed-history-store.ts", () => ({
  readSelectedHistoryBlock: indexed.block,
  readSelectedHistoryHash: indexed.hash,
}));
import {
  loadBlockFromR2Sql,
  loadBlockWithEconomicsFromR2Sql,
} from "../src/r2-sql-blocks.ts";
import {
  loadBlockExtrinsicsColdTier,
  loadExtrinsicColdTier,
} from "../src/extrinsics-cold-tier.ts";
import { loadBlockEventsColdTier } from "../src/events-cold-tier.ts";
import { buildBlock, declineBlock } from "../src/blocks.ts";
import { buildBlockExtrinsics, buildExtrinsic } from "../src/extrinsics.ts";
import { buildBlockEvents, formatAccountEvent } from "../src/account-events.ts";
const env = { R2_SQL_TOKEN: "test" },
  hash = "0x" + "a".repeat(64);
const header = (block_number = 7) => ({
  block_number,
  block_hash: hash,
  observed_at: 1700000000000,
});
const extrinsic = (extrinsic_index = 0, observed_at = 1700000000000) => ({
  block_number: 7,
  extrinsic_index,
  extrinsic_hash: hash,
  observed_at,
  signer: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  call_module: "Balances",
  call_function: "transfer",
  success: true,
  fee_tao: 0.125,
  tip_tao: 0.005,
  call_args: "[]",
});
const event = (event_index = 0, extrinsic_index: number | null = 0) => ({
  block_number: 7,
  event_index,
  extrinsic_index,
  event_kind: "Transfer",
  amount_tao: 2.5,
  observed_at: 1700000000000,
});
beforeEach(() => {
  indexed.block.mockReset().mockResolvedValue([]);
  indexed.hash.mockReset().mockResolvedValue(header());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("SQL must not be called");
    }),
  );
});
afterEach(() => {
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  vi.unstubAllGlobals();
});
test("selected numeric and hash block details retain stored navigation and one shared budget", async () => {
  indexed.block.mockImplementation(async (_env, table, block) =>
    table === "blocks" ? [header(block)] : [],
  );
  for (const ref of ["7", hash]) {
    assert.deepEqual(
      await loadBlockFromR2Sql(env, ref, "testnet"),
      buildBlock(header(), ref, { prev: 6, next: 8 }),
    );
    const calls = indexed.block.mock.calls;
    assert.ok(calls.every((c) => c[3] === "testnet"));
    assert.equal(calls.at(-1)?.[4], calls.at(-2)?.[4]);
  }
  assert.deepEqual(
    await loadBlockFromR2Sql(env, "0"),
    buildBlock(header(0), "0", { prev: null, next: 1 }),
  );
});
test("selected block failures decline, absence stays distinct, and missing navigation keeps the block", async () => {
  for (const value of [null, [{ block_number: "bad" }]]) {
    indexed.block.mockResolvedValue(value);
    assert.deepEqual(await loadBlockFromR2Sql(env, "7"), declineBlock("7"));
  }
  indexed.block.mockResolvedValue([]);
  assert.deepEqual(
    await loadBlockFromR2Sql(env, "7"),
    buildBlock(undefined, "7"),
  );
  indexed.hash.mockResolvedValue({ block_number: null });
  assert.deepEqual(
    await loadBlockFromR2Sql(env, hash),
    buildBlock({ block_number: null }, hash),
  );
  indexed.block.mockImplementation(async (_env, _table, block) =>
    block === 7 ? [header()] : null,
  );
  assert.deepEqual(
    await loadBlockFromR2Sql(env, "7"),
    buildBlock(header(), "7", { prev: null, next: null }),
  );
  indexed.hash.mockResolvedValue(null);
  assert.deepEqual(await loadBlockFromR2Sql(env, hash), declineBlock(hash));
});
test("economics uses selected companion rows with shared budget and preserves unavailable summaries", async () => {
  indexed.block.mockImplementation(async (_env, table, block) =>
    table === "blocks"
      ? [header(block)]
      : table === "extrinsics"
        ? [extrinsic()]
        : [event()],
  );
  for (const ref of ["7", hash]) {
    indexed.block.mockClear();
    const result = await loadBlockWithEconomicsFromR2Sql(env, ref, "testnet");
    assert.equal(result?.block?.fee_tao, 0.125);
    assert.equal(result?.block?.native_transfer_tao, 2.5);
    const budgets = indexed.block.mock.calls.map((c) => c[4]);
    assert.equal(budgets[0].maxRequests, 96);
    assert.equal(budgets[0].maxBytes, 24 * 1024 * 1024);
    assert.ok(budgets.every((b) => b === budgets.at(-1)));
  }
  for (const table of ["extrinsics", "account_events"]) {
    for (const value of [null, [{ block_number: "bad" }]]) {
      indexed.block.mockImplementation(async (_env, t, block) =>
        t === table ? value : t === "blocks" ? [header(block)] : [],
      );
      assert.equal(
        (await loadBlockWithEconomicsFromR2Sql(env, "7"))?.block?.fee_tao,
        null,
      );
    }
  }
});
test("block extrinsic pages preserve capture ordering, offsets, and numeric/hash refs", async () => {
  const rows = [
    extrinsic(0),
    extrinsic(1),
    extrinsic(2, 1699999999999),
    extrinsic(1),
  ];
  indexed.block.mockResolvedValue(rows);
  for (const ref of ["7", hash])
    assert.deepEqual(
      await loadBlockExtrinsicsColdTier(
        env,
        ref,
        { limit: 2, offset: 1 },
        "testnet",
      ),
      buildBlockExtrinsics([rows[3], rows[0]], ref, 7, { limit: 2, offset: 1 }),
    );
  for (const page of [
    { limit: 0 },
    { limit: -1 },
    { limit: 1, offset: -1 },
    { limit: 1, offset: 251 },
  ])
    assert.equal(await loadBlockExtrinsicsColdTier(env, "7", page), null);
  for (const rows of [null, [{ extrinsic_index: "bad" }]]) {
    indexed.block.mockResolvedValue(rows);
    assert.equal(
      await loadBlockExtrinsicsColdTier(env, "7", { limit: 1 }),
      null,
    );
  }
  indexed.hash.mockResolvedValue(null);
  assert.equal(
    await loadBlockExtrinsicsColdTier(env, hash, { limit: 1 }),
    null,
  );
  indexed.hash.mockResolvedValue({ block_number: null });
  assert.equal(
    await loadBlockExtrinsicsColdTier(env, hash, { limit: 1 }),
    null,
  );
});
test("selected extrinsic detail preserves embedded event order and cap without widening null indices", async () => {
  const target = extrinsic(0),
    events = [
      event(70, 1),
      event(71, null),
      ...Array.from({ length: 60 }, (_, i) => event(59 - i)),
    ];
  indexed.block.mockImplementation(async (_env, table) =>
    table === "extrinsics"
      ? [{ ...target, extrinsic_index: null }, extrinsic(1), target]
      : events,
  );
  indexed.hash.mockResolvedValue(target);
  const embedded = Array.from({ length: 50 }, (_, i) =>
    formatAccountEvent(event(i)),
  ).filter(Boolean);
  for (const ref of ["7-0", hash])
    assert.deepEqual(
      await loadExtrinsicColdTier(env, ref, "testnet"),
      buildExtrinsic(target, ref, embedded),
    );
  indexed.block.mockResolvedValue([]);
  assert.deepEqual(
    await loadExtrinsicColdTier(env, "7-0"),
    buildExtrinsic(undefined, "7-0"),
  );
  for (const value of [null, [{ extrinsic_index: "bad" }]]) {
    indexed.block.mockResolvedValue(value);
    assert.equal(await loadExtrinsicColdTier(env, "7-0"), null);
  }
  indexed.hash.mockResolvedValue(null);
  assert.equal(await loadExtrinsicColdTier(env, hash), null);
  indexed.hash.mockResolvedValue({ ...target, block_number: null });
  assert.deepEqual(
    await loadExtrinsicColdTier(env, hash),
    buildExtrinsic({ ...target, block_number: null }, hash, []),
  );
  indexed.hash.mockResolvedValue(target);
  indexed.block.mockResolvedValue(null);
  assert.deepEqual(
    await loadExtrinsicColdTier(env, hash),
    buildExtrinsic(target, hash, []),
  );
});
test("curated block events keep the legacy page and total-count contract", async () => {
  const rows = [event(2), event(0), event(1)];
  indexed.block.mockResolvedValue(rows);
  for (const ref of ["7", hash])
    assert.deepEqual(
      await loadBlockEventsColdTier(
        env,
        ref,
        { limit: 1, offset: 1 },
        "testnet",
      ),
      buildBlockEvents([event(1)], ref, 7, {
        limit: 1,
        offset: 1,
        totalCount: null,
      }),
    );
  indexed.block.mockResolvedValue([event(0)]);
  assert.deepEqual(
    await loadBlockEventsColdTier(env, "7", { limit: 2 }),
    buildBlockEvents([event(0)], "7", 7, {
      limit: 2,
      offset: 0,
      totalCount: 1,
    }),
  );
  for (const value of [null, [{ event_index: "bad" }]]) {
    indexed.block.mockResolvedValue(value);
    assert.equal(await loadBlockEventsColdTier(env, "7", { limit: 1 }), null);
  }
});

test("retired detail transport preserves invalid-reference guards and missing-index semantics", async () => {
  for (const ref of [
    "bad",
    "-1",
    "9999999999999999999-0",
    "7-9999999999999999999",
  ])
    assert.equal(await loadExtrinsicColdTier(env, ref), null);
  assert.equal(
    await loadBlockExtrinsicsColdTier(env, "bad", { limit: 1 }),
    null,
  );
  indexed.block.mockResolvedValue(undefined);
  indexed.hash.mockResolvedValue(undefined);
  assert.equal(await loadBlockExtrinsicsColdTier(env, "7", { limit: 1 }), null);
  assert.equal(
    await loadBlockExtrinsicsColdTier(env, hash, { limit: 1 }),
    null,
  );
  assert.equal(await loadExtrinsicColdTier(env, "7-0"), null);
  indexed.hash.mockResolvedValue(extrinsic());
  assert.deepEqual(
    await loadExtrinsicColdTier(env, hash),
    buildExtrinsic(extrinsic(), hash, []),
  );
});
