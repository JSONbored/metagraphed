import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import * as history from "../src/indexed-history-store.ts";
import * as windows from "../src/indexed-chain-windows.ts";
import * as seam from "../src/blocks-seam.ts";
import * as hot from "../src/chain-detail-hot-tier.ts";
import * as lease from "../src/lease-presence-native.ts";
import { CHAIN_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import { ChainEventsRowSchema } from "../schemas-src/lakehouse.ts";
import {
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
  loadSubnetLeaseHistoryColdTier,
  chainEventsQueryError,
  CHAIN_EVENTS_BLOCK_WINDOW,
} from "../src/chain-events-cold-tier.ts";
const block = vi.spyOn(history, "readSelectedHistoryBlock"),
  window = vi.spyOn(windows, "loadIndexedChainWindow"),
  stats = vi.spyOn(windows, "loadIndexedChainWindowStats"),
  head = vi.spyOn(seam, "lakehouseHeadBlock"),
  hotPage = vi.spyOn(hot, "loadChainEventsHeadHotTier"),
  presence = vi.spyOn(lease, "loadNativeLeasePresence");
const row = (height = 10000, index = 1) =>
  ChainEventsRowSchema.required().parse({
    ...Object.fromEntries(CHAIN_EVENTS_COLUMNS.map((k) => [k, null])),
    block_number: height,
    event_index: index,
    extrinsic_index: 2,
    pallet: "Balances",
    method: "Transfer",
    args: "[]",
    observed_at: 1700000000000,
  });
beforeEach(() => {
  block.mockReset().mockResolvedValue([]);
  window.mockReset().mockResolvedValue([]);
  stats.mockReset().mockResolvedValue([]);
  head.mockReset().mockResolvedValue(10000);
  hotPage.mockReset().mockResolvedValue(null);
  presence.mockReset().mockResolvedValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP forbidden");
    }),
  );
});
describe("native raw event feed", () => {
  test("short windows continue backwards until genesis and before zero reads nothing", async () => {
    const first = await loadChainEventsColdTier({}, { limit: 2 });
    assert.deepEqual(first, {
      count: 0,
      next_before: 5000,
      next_cursor: null,
      events: [],
    });
    assert.equal(
      window.mock.lastCall?.[1].first,
      10000 - CHAIN_EVENTS_BLOCK_WINDOW,
    );
    const next = await loadChainEventsColdTier(
      {},
      { limit: 2, before: first.next_before },
    );
    assert.equal(next?.next_before, null);
    assert.equal(window.mock.lastCall?.[1].last, 4999);
    window.mockClear();
    assert.deepEqual(
      await loadChainEventsColdTier({}, { limit: 2, before: 0 }),
      { count: 0, next_before: null, next_cursor: null, events: [] },
    );
    assert.equal(window.mock.calls.length, 0);
  });
  test("full pages preserve the exact cursor and forward every supported window filter", async () => {
    window.mockResolvedValue([row(9999, 2), row(9999, 1)]);
    const first = await loadChainEventsColdTier(
      {},
      { limit: 2, pallet: "Balances", method: "Transfer" },
      "testnet",
    );
    assert.equal(first?.next_cursor, "1700000000000.9999.1");
    assert.equal(first.next_before, 9999);
    assert.deepEqual(first.events[0].args, []);
    await loadChainEventsColdTier(
      {},
      {
        limit: 2,
        cursor: first.next_cursor,
        before: "ignored",
        pallet: "Balances",
        method: "Transfer",
      },
      "testnet",
    );
    assert.deepEqual(window.mock.lastCall, [
      {},
      {
        first: 4999,
        last: 9999,
        limit: 2,
        pallet: "Balances",
        method: "Transfer",
        cursor: [1700000000000, 9999, 1],
      },
      "testnet",
    ]);
  });
  test("exact blocks filter pallet, method and extrinsic and seek by event index", async () => {
    block.mockResolvedValue([
      row(100, 3),
      row(100, 1),
      row(100, 2),
      { ...row(100, 4), pallet: "Other" },
      { ...row(100, 5), method: "Other" },
      { ...row(100, 6), extrinsic_index: 4 },
    ]);
    const result = await loadChainEventsColdTier(
      {},
      {
        limit: 2,
        block: 100,
        extrinsic: 2,
        pallet: "Balances",
        method: "Transfer",
        cursor: "1700000000000.100.3",
      },
      "testnet",
    );
    assert.deepEqual(
      result?.events.map((r) => r.event_index),
      [2, 1],
    );
    assert.equal(result.next_before, null);
    assert.equal(result.next_cursor, "1700000000000.100.1");
    assert.equal(window.mock.calls.length, 0);
    assert.equal(
      (await loadChainEventsColdTier({}, { limit: 10, block: 100 }))
        ?.next_before,
      null,
    );
  });
  test("bad input, unavailable sources and malformed physical rows decline", async () => {
    for (const query of [
      { limit: 0 },
      { limit: 2, pallet: "bad'" },
      { limit: 2, method: "bad'" },
      { limit: 2, block: -1 },
      { limit: 2, extrinsic: -1 },
      { limit: 2, before: "bad" },
    ])
      assert.equal(await loadChainEventsColdTier({}, query), null);
    assert.equal(window.mock.calls.length, 0);
    head.mockResolvedValue(null);
    assert.equal(await loadChainEventsColdTier({}, { limit: 2 }), null);
    for (const rows of [null, undefined, [{ block_number: "bad" }]]) {
      block.mockResolvedValue(rows);
      assert.equal(
        await loadChainEventsColdTier({}, { limit: 2, block: 100 }),
        null,
      );
    }
    head.mockResolvedValue(10000);
    for (const rows of [null, undefined]) {
      window.mockResolvedValue(rows);
      assert.equal(await loadChainEventsColdTier({}, { limit: 2 }), null);
    }
  });
  test("a full hot page is complete, a short one falls through, other networks remain isolated", async () => {
    hotPage.mockResolvedValue([row(10001, 2), row(10001, 1)]);
    const result = await loadChainEventsColdTier({}, { limit: 2 });
    assert.equal(result?.next_cursor, "1700000000000.10001.1");
    assert.equal(window.mock.calls.length, 0);
    hotPage.mockResolvedValue([row()]);
    window.mockResolvedValue([row(9999, 2), row(9999, 1)]);
    assert.equal(
      (await loadChainEventsColdTier({}, { limit: 2 }))?.events[0].block_number,
      9999,
    );
    hotPage.mockClear();
    await loadChainEventsColdTier({}, { limit: 2 }, "testnet");
    await loadChainEventsColdTier({}, { limit: 2, block: 100 });
    assert.equal(hotPage.mock.calls.length, 0);
  });
});
describe("native event stats and lease presence", () => {
  test("stats apply exact network, inclusive head and bounded block windows", async () => {
    stats.mockResolvedValue([
      { pallet: "Balances", method: "Transfer", event_count: 3 },
    ]);
    for (const [requested, width] of [
      [undefined, 1000],
      [0, 1000],
      [1, 1],
      [99999, 5000],
    ] as const) {
      const result = await loadChainEventsStatsColdTier(
        {},
        requested,
        "testnet",
      );
      assert.equal(result?.window_blocks, width);
      assert.equal(result.groups, 1);
      assert.deepEqual(stats.mock.lastCall, [
        {},
        10000 - width + 1,
        10000,
        "testnet",
      ]);
    }
    assert.equal(await loadChainEventsStatsColdTier({}, "bad"), null);
    head.mockResolvedValue(null);
    assert.equal(await loadChainEventsStatsColdTier({}), null);
    head.mockResolvedValue(5);
    stats.mockResolvedValue(null);
    assert.equal(await loadChainEventsStatsColdTier({}), null);
  });
  test("only verified global absence proves an empty subnet lease history", async () => {
    assert.deepEqual(await loadSubnetLeaseHistoryColdTier({}, 7, "testnet"), {
      rows: [],
    });
    assert.deepEqual(presence.mock.lastCall, [{}, "testnet"]);
    for (const value of [true, null, undefined]) {
      presence.mockResolvedValue(value);
      assert.equal(await loadSubnetLeaseHistoryColdTier({}, 7), null);
    }
    assert.equal(await loadSubnetLeaseHistoryColdTier({}, -1), null);
  });
});
describe("chainEventsQueryError names the unusable parameter", () => {
  test("a usable query is null", () => {
    assert.equal(chainEventsQueryError({ limit: 50 }), null);
    assert.equal(
      chainEventsQueryError({
        limit: 50,
        pallet: "SubtensorModule",
        method: "WeightsSet",
        block: 8_759_336,
        extrinsic: 2,
        before: 8_759_000,
      }),
      null,
    );
  });

  test("each parameter is named by its own guard", () => {
    for (const [query, expected] of [
      [{ limit: 0 }, "limit"],
      [{ limit: "many" }, "limit"],
      [{ limit: 50, pallet: "not a pallet name" }, "pallet"],
      [{ limit: 50, method: "Weights'; DROP" }, "method"],
      [{ limit: 50, block: "soon" }, "block"],
      [{ limit: 50, extrinsic: -1 }, "extrinsic"],
      [{ limit: 50, before: "yesterday" }, "before"],
    ] as [Record<string, unknown>, string][]) {
      assert.equal(
        chainEventsQueryError(query as never),
        expected,
        JSON.stringify(query),
      );
    }
  });

  // A cursor supersedes `before`, so an unusable one is inert -- rejecting it
  // would break a caller paging by cursor who still echoes their stale `before`.
  test("an unusable before is inert once a cursor supersedes it", () => {
    assert.equal(
      chainEventsQueryError({
        limit: 50,
        cursor: "1785708540000.8759336.294",
        before: "yesterday",
      } as never),
      null,
    );
  });
});
