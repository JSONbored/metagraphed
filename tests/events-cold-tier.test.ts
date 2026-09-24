import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import * as feeds from "../src/indexed-account-feeds.ts";
import * as history from "../src/indexed-history-store.ts";
import { nativeAccountRow } from "./helpers/native-account-row.ts";
import { CHAIN_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import { ChainEventsRowSchema } from "../schemas-src/lakehouse.ts";
import {
  loadAccountEventsColdTier,
  loadSubnetEventsColdTier,
  loadBlockEventsColdTier,
  loadBlockChainEventsColdTier,
} from "../src/events-cold-tier.ts";
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  HASH = "0x" + "ab".repeat(32);
const page = vi.spyOn(feeds, "loadIndexedAccountFeedPage"),
  block = vi.spyOn(history, "readSelectedHistoryBlock"),
  hash = vi.spyOn(history, "readSelectedHistoryHash");
const row = (i = 1) =>
  nativeAccountRow({
    block_number: 100,
    event_index: i,
    observed_at: 1700000000000,
    hotkey: ADDR,
    netuid: 7,
  });
const raw = (i = 1) =>
  ChainEventsRowSchema.required().parse({
    ...Object.fromEntries(CHAIN_EVENTS_COLUMNS.map((k) => [k, null])),
    block_number: 100,
    event_index: i,
    extrinsic_index: 0,
    pallet: "Balances",
    method: "Transfer",
    args: "[]",
    observed_at: 1700000000000,
  });
beforeEach(() => {
  page.mockReset().mockResolvedValue([row(2), row(1)]);
  block.mockReset().mockResolvedValue([row(2), row(1)]);
  hash.mockReset().mockResolvedValue({ block_number: 100 });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP forbidden");
    }),
  );
});
describe("native account and subnet event pages", () => {
  test("forwards all narrowing and the composite cursor on both networks", async () => {
    for (const network of ["mainnet", "testnet"] as const) {
      const args = {
        limit: 2,
        offset: 7,
        kind: "Transfer",
        netuid: 7,
        blockStart: 90,
        blockEnd: 110,
        cursor: "1700000000100.101.2",
      };
      const result = await loadAccountEventsColdTier({}, ADDR, args, network);
      assert.equal(result?.event_count, 2);
      assert.equal(result.next_cursor, "1700000000000.100.1");
      const filters = {
        kind: "Transfer",
        netuid: 7,
        blockStart: 90,
        blockEnd: 110,
        cursor: [1700000000100, 101, 2],
      };
      assert.deepEqual(page.mock.lastCall, [
        {},
        ["hotkey", "coldkey"].map((side) => ({
          ...filters,
          side,
          account: ADDR,
        })),
        2,
        0,
        network,
      ]);
      const subnet = await loadSubnetEventsColdTier({}, 7, args, network);
      assert.equal(subnet?.event_count, 2);
      assert.equal(subnet.next_cursor, result.next_cursor);
      assert.deepEqual(page.mock.lastCall, [
        {},
        [{ ...filters, side: "all", account: "*" }],
        2,
        0,
        network,
      ]);
    }
  });
  test("offset is applied once; malformed cursors and short pages preserve the public contract", async () => {
    page.mockResolvedValue([row()]);
    for (const load of [
      () =>
        loadAccountEventsColdTier({}, ADDR, {
          limit: 2,
          offset: 3,
          cursor: "bad",
        }),
      () =>
        loadSubnetEventsColdTier({}, 7, { limit: 2, offset: 3, cursor: "bad" }),
    ]) {
      const result = await load();
      assert.equal(result?.event_count, 1);
      assert.equal(result.next_cursor, null);
      assert.equal(page.mock.lastCall?.[3], 3);
    }
    page.mockResolvedValue([nativeAccountRow({ observed_at: null })]);
    assert.equal(
      (await loadAccountEventsColdTier({}, ADDR, { limit: 1 }))?.next_cursor,
      null,
    );
    assert.equal(
      (await loadSubnetEventsColdTier({}, 7, { limit: 1 }))?.next_cursor,
      null,
    );
  });
  test("invalid input never drops filters or starts an unbounded read", async () => {
    for (const args of [
      { limit: 0 },
      { limit: 2, offset: -1 },
      { limit: 2, offset: 100000 },
      { limit: 2, kind: "bad'" },
      { limit: 2, blockStart: -1 },
      { limit: 2, blockEnd: "bad" },
    ]) {
      assert.equal(await loadAccountEventsColdTier({}, ADDR, args), null);
      assert.equal(await loadSubnetEventsColdTier({}, 7, args), null);
    }
    assert.equal(
      await loadAccountEventsColdTier({}, "bad", { limit: 2 }),
      null,
    );
    assert.equal(
      await loadAccountEventsColdTier({}, ADDR, { limit: 2, netuid: -1 }),
      null,
    );
    assert.equal(await loadSubnetEventsColdTier({}, -1, { limit: 2 }), null);
    assert.equal(page.mock.calls.length, 0);
  });
  test("selected failures decline while a verified empty page remains an answer", async () => {
    for (const value of [null, undefined, []]) {
      page.mockResolvedValue(value);
      const a = await loadAccountEventsColdTier({}, ADDR, { limit: 2 });
      const s = await loadSubnetEventsColdTier({}, 7, { limit: 2 });
      if (value) {
        assert.equal(a?.event_count, 0);
        assert.equal(s?.event_count, 0);
      } else {
        assert.equal(a, null);
        assert.equal(s, null);
      }
    }
  });
});
describe("native block event detail", () => {
  test("numeric and hash refs return natural event order and truthful offset counts", async () => {
    for (const ref of ["100", HASH]) {
      const result = await loadBlockEventsColdTier(
        {},
        ref,
        { limit: 3, offset: 1 },
        "testnet",
      );
      assert.equal(result?.event_count, 2);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].event_index, 2);
      assert.equal(block.mock.lastCall?.[1], "account_events");
      assert.equal(block.mock.lastCall?.[2], 100);
      assert.equal(block.mock.lastCall?.[3], "testnet");
    }
    assert.equal(hash.mock.lastCall?.[2], HASH);
    assert.equal(
      (await loadBlockEventsColdTier({}, "100", { limit: 1 }))?.events[0]
        .event_index,
      1,
    );
  });
  test("unknown hashes, invalid refs, malformed rows and failed selected reads decline", async () => {
    for (const value of [null, undefined, [] as [], { block_number: "bad" }]) {
      hash.mockResolvedValue(value);
      assert.equal(await loadBlockEventsColdTier({}, HASH, { limit: 2 }), null);
    }
    for (const ref of ["bad", "-1"]) {
      assert.equal(await loadBlockEventsColdTier({}, ref, { limit: 2 }), null);
      assert.equal(await loadBlockChainEventsColdTier({}, ref), null);
    }
    for (const args of [
      { limit: 0 },
      { limit: 2, offset: -1 },
      { limit: 2, offset: 100000 },
    ])
      assert.equal(await loadBlockEventsColdTier({}, "100", args), null);
    for (const value of [null, undefined, [{ block_number: "bad" }]]) {
      block.mockResolvedValue(value);
      assert.equal(
        await loadBlockEventsColdTier({}, "100", { limit: 2 }),
        null,
      );
      assert.equal(await loadBlockChainEventsColdTier({}, "100"), null);
    }
  });
  test("raw block events are uncapped, validated and formatted once", async () => {
    block.mockResolvedValue(
      Array.from({ length: 700 }, (_, i) => raw(700 - i)),
    );
    const result = await loadBlockChainEventsColdTier({}, HASH, "testnet");
    assert.equal(result?.count, 700);
    assert.equal(result.events[0].event_index, 1);
    assert.equal(result.events.at(-1)?.event_index, 700);
    assert.deepEqual(result.events[0].args, []);
    assert.equal(block.mock.lastCall?.[1], "chain_events");
    block.mockResolvedValue([]);
    assert.deepEqual(await loadBlockChainEventsColdTier({}, "100"), {
      block_number: 100,
      count: 0,
      events: [],
    });
  });
});
