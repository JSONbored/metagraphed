import { expect, it, vi } from "vitest";
import {
  accountFeedReadAhead,
  foldAccountFeedGroups,
} from "../src/history-account-feed-groups.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import {
  mergeAccountFeedEntries,
  type IndexedAccountFeedEntry,
} from "../src/history-account-feed.ts";
import type { HistoryFeedNode } from "../schemas-src/artifacts/history-account-feed.ts";

function node(
  key: string,
  offset = 0,
  length = 10,
): Extract<HistoryFeedNode, { height: 0 }> {
  return {
    first: "0".repeat(166),
    last: "f".repeat(166),
    rows: 1,
    height: 0,
    minBlock: 1,
    maxBlock: 1,
    offset,
    length,
    decodedBytes: 1,
    object: { key, etag: "immutable", bytes: 1024 * 1024 },
  };
}

it("bounds resident read-ahead and charges every prefetched byte and request", async () => {
  const data = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
  const source = {
    read: vi.fn(
      async (_key: string, _etag: string, offset: number, length: number) =>
        data.buffer.slice(offset, offset + length),
    ),
  };
  const budget = parquetReadBudget(16 * 1024 * 1024, 100);
  const read = accountFeedReadAhead(source, budget);
  expect(new Uint8Array(await read(node("a", 100, 20)))).toEqual(
    data.slice(100, 120),
  );
  expect(new Uint8Array(await read(node("a", 200, 40)))).toEqual(
    data.slice(200, 240),
  );
  expect(source.read).toHaveBeenCalledTimes(1);
  await read(node("a", 0, 20));
  await read(node("a", 300000, 300000));
  expect(source.read).toHaveBeenLastCalledWith(
    "a",
    "immutable",
    300000,
    300000,
  );
  await read(node("a", data.length - 20, 20));
  expect(source.read).toHaveBeenLastCalledWith(
    "a",
    "immutable",
    data.length - 20,
    20,
  );
  for (let i = 0; i < 17; i++) await read(node(`key-${i}`));
  const previous = source.read.mock.calls.length;
  await read(node("key-0"));
  expect(source.read).toHaveBeenCalledTimes(previous + 1);
  expect(budget.bytes).toBe(
    source.read.mock.calls.reduce((sum, args) => sum + args[3], 0),
  );
  expect(budget.requests).toBe(source.read.mock.calls.length);
  await expect(
    accountFeedReadAhead(source, parquetReadBudget(1, 1))(node("too-large")),
  ).rejects.toThrow("budget");
});

function entries(
  count: number,
  uniqueGroups = false,
  amount = 0.5,
  alpha: number | null = null,
) {
  const closed = vi.fn();
  async function* stream(): AsyncGenerator<IndexedAccountFeedEntry> {
    try {
      for (let i = 0; i < count; i++)
        yield {
          token: "0".repeat(94) + i.toString(16).padStart(72, "0"),
          row: {
            block_number: count - i,
            event_index: 0,
            extrinsic_index: null,
            event_kind: "StakeAdded",
            hotkey: "self",
            coldkey: "self",
            netuid: uniqueGroups ? i : null,
            uid: null,
            amount_tao: amount,
            alpha_amount: alpha,
            observed_at: 10000 - i,
          },
        };
    } finally {
      closed();
    }
  }
  return { stream, closed };
}

it("folds more than a page of physical events once and closes every stream", async () => {
  const a = entries(6002);
  expect(await foldAccountFeedGroups([a.stream(), a.stream()])).toEqual([
    {
      event_kind: "StakeAdded",
      netuid: null,
      event_count: 6002,
      total_tao: 3001,
      total_alpha: null,
      first_block: 1,
      last_block: 6002,
      first_observed: 3999,
      last_observed: 10000,
    },
  ]);
  expect(a.closed).toHaveBeenCalledTimes(2);
  expect(await foldAccountFeedGroups([])).toEqual([]);
  const alpha = entries(2, false, 0, 3);
  expect(await foldAccountFeedGroups([alpha.stream()])).toMatchObject([
    { total_tao: 0, total_alpha: 6 },
  ]);
});

it("refuses overflowing aggregates and group or stream budgets without partial totals", async () => {
  const groups = entries(4097, true);
  await expect(foldAccountFeedGroups([groups.stream()])).rejects.toThrow(
    "group budget",
  );
  expect(groups.closed).toHaveBeenCalledOnce();
  for (const [amount, alpha] of [
    [Number.MAX_VALUE, null],
    [0, Number.MAX_VALUE],
  ] as const) {
    const large = entries(2, false, amount, alpha);
    await expect(foldAccountFeedGroups([large.stream()])).rejects.toThrow(
      "numeric range",
    );
    expect(large.closed).toHaveBeenCalledOnce();
  }
  const tooMany = mergeAccountFeedEntries(
    Array.from({ length: 17 }, () => entries(0).stream()),
  );
  await expect(tooMany.next()).rejects.toThrow("budget");
});
