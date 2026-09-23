import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/indexed-history-store.ts", () => ({
  readSelectedHistoryBlock: read,
}));
import { loadChainEventsColdTier } from "../src/chain-events-cold-tier.ts";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";

const row = (event_index: number | null, extra = {}) => ({
  block_number: 10,
  event_index,
  pallet: "SubtensorModule",
  method: "WeightsSet",
  args: "[1,2]",
  phase: "ApplyExtrinsic",
  extrinsic_index: 0,
  observed_at: 1_790_100_000_000,
  ...extra,
});
function selected(rows: unknown) {
  read.mockResolvedValue(rows);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("selected history must not call SQL");
    }),
  );
}
afterEach(() => {
  read.mockReset();
  vi.unstubAllGlobals();
});

test("selected block pages retain descending event order and advance the same cursor", async () => {
  selected([row(1), row(3), row(2)]);
  const page = await loadChainEventsColdTier(
    {},
    { block: 10, limit: 2 },
    "testnet",
  );
  assert.deepEqual(
    page!.events.map((r) => r.event_index),
    [3, 2],
  );
  assert.equal(page!.next_before, null);
  assert.deepEqual(
    decodeCursor(page!.next_cursor, 3),
    [1_790_100_000_000, 10, 2],
  );
  assert.deepEqual(read.mock.calls[0], [{}, "chain_events", 10, "testnet"]);
  const next = await loadChainEventsColdTier(
    {},
    { block: 10, limit: 2, cursor: page!.next_cursor },
    "testnet",
  );
  assert.deepEqual(
    next!.events.map((r) => r.event_index),
    [1],
  );
  assert.equal(next!.next_cursor, null);
  assert.equal(next!.next_before, null);
});

test("all filters apply before paging and null extrinsic indexes do not match zero", async () => {
  selected([
    row(6, { pallet: "Other" }),
    row(5, { method: "Other" }),
    row(4, { extrinsic_index: null }),
    row(3),
    row(2),
    row(1, { extrinsic_index: 1 }),
  ]);
  const page = await loadChainEventsColdTier(
    {},
    {
      block: 10,
      pallet: "SubtensorModule",
      method: "WeightsSet",
      extrinsic: 0,
      limit: 1,
    },
  );
  assert.deepEqual(
    page!.events.map((r) => r.event_index),
    [3],
  );
  const next = await loadChainEventsColdTier(
    {},
    {
      block: 10,
      pallet: "SubtensorModule",
      method: "WeightsSet",
      extrinsic: 0,
      limit: 10,
      cursor: page!.next_cursor,
    },
  );
  assert.deepEqual(
    next!.events.map((r) => r.event_index),
    [2],
  );
  assert.equal(next!.next_cursor, null);
});

test("a selected empty block proves exhaustion and corruption never falls back", async () => {
  selected([]);
  assert.deepEqual(await loadChainEventsColdTier({}, { block: 10, limit: 2 }), {
    count: 0,
    next_before: null,
    next_cursor: null,
    events: [],
  });
  for (const invalid of [null, [{ block_number: "invalid" }]]) {
    selected(invalid);
    assert.equal(
      await loadChainEventsColdTier({}, { block: 10, limit: 2 }),
      null,
    );
  }
});

test("nullable event indexes sort last and are excluded by a strict cursor", async () => {
  selected([row(null), row(1), row(null), row(0)]);
  const page = await loadChainEventsColdTier({}, { block: 10, limit: 10 });
  assert.deepEqual(
    page!.events.map((r) => r.event_index),
    [1, 0, null, null],
  );
  const next = await loadChainEventsColdTier(
    {},
    { block: 10, limit: 10, cursor: encodeCursor([1_790_100_000_000, 10, 1]) },
  );
  assert.deepEqual(
    next!.events.map((r) => r.event_index),
    [0],
  );
});
