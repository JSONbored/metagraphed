// Reading subnet_lifecycle (#10263) -- the serving half of #10262's writer.
//
// The assertions are weighted toward the two distinctions this route exists to
// preserve, because both are easy to flatten and both are load-bearing:
//
//   1. `block_number: null` is a REAL ANSWER (the transition predates capture),
//      not a missing value. Coercing it to 0 would publish a claim about block
//      zero that nothing observed.
//   2. "no store" and "no rows" are different facts. The loader answers null
//      for the first and [] for the second, so a watchdog can tell an
//      unreachable store from a subnet that has genuinely never moved.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  buildChainSubnetLifecycle,
  buildSubnetLifecycle,
  CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX,
  DEFAULT_SUBNET_LIFECYCLE_WINDOW,
  loadChainSubnetLifecycle,
  loadSubnetLifecycle,
} from "../src/subnet-lifecycle-read.ts";

/** A read handle over canned rows that records the SQL and binds it saw. */
function fakeStore(rows: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const store = {
    query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return Promise.resolve(rows);
    },
  };
  return { store: store as never, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  netuid: 7,
  event: "registered",
  block_number: 8_800_000,
  observed_at: 1_800_000_000_000,
  predates_capture: false,
  ...over,
});

describe("loadSubnetLifecycle", () => {
  test("no store answers null, NOT an empty page", async () => {
    // The distinction the whole family rests on: `[]` would tell a caller this
    // subnet has never moved, which is a claim we cannot make with no store.
    assert.equal(
      await loadSubnetLifecycle({}, 7, { limit: 10, offset: 0 }),
      null,
    );
  });

  test("an empty result is [] -- 'no transitions' is a real answer", async () => {
    const { store } = fakeStore([]);
    assert.deepEqual(
      await loadSubnetLifecycle({}, 7, { limit: 10, offset: 0 }, store),
      [],
    );
  });

  test("binds netuid, limit and offset in that order", async () => {
    const { store, calls } = fakeStore([row()]);
    await loadSubnetLifecycle({}, 7, { limit: 5, offset: 10 }, store);
    assert.deepEqual(calls[0]!.values, [7, 5, 10]);
    assert.match(calls[0]!.sql, /WHERE netuid = \?/);
    // Newest first, with id as the tiebreak: two events in one millisecond
    // must still come back in the order they were appended.
    assert.match(calls[0]!.sql, /ORDER BY observed_at DESC, id DESC/);
  });

  test("a null block stays null and is not coerced to 0", async () => {
    const { store } = fakeStore([
      row({ block_number: null, predates_capture: true }),
    ]);
    const [entry] = (await loadSubnetLifecycle(
      {},
      7,
      { limit: 10, offset: 0 },
      store,
    ))!;
    assert.equal(entry!.block_number, null);
    assert.equal(entry!.predates_capture, true);
  });

  test("block 0 is also null -- a zero block is not an observation", async () => {
    const { store } = fakeStore([row({ block_number: 0 })]);
    const [entry] = (await loadSubnetLifecycle(
      {},
      7,
      { limit: 10, offset: 0 },
      store,
    ))!;
    assert.equal(entry!.block_number, null);
  });

  test("observed_at becomes an ISO string", async () => {
    const { store } = fakeStore([row({ observed_at: 1_800_000_000_000 })]);
    const [entry] = (await loadSubnetLifecycle(
      {},
      7,
      { limit: 10, offset: 0 },
      store,
    ))!;
    assert.equal(entry!.observed_at, new Date(1_800_000_000_000).toISOString());
  });

  test("a row with an unknown event is DROPPED, not published", async () => {
    // The table has a CHECK constraint, so this should be unreachable -- but a
    // row that slipped past it must not reach the contract's enum.
    const { store } = fakeStore([row({ event: "exploded" }), row()]);
    const entries = (await loadSubnetLifecycle(
      {},
      7,
      { limit: 10, offset: 0 },
      store,
    ))!;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.event, "registered");
  });

  test("a row with a non-integer netuid is dropped", async () => {
    const { store } = fakeStore([row({ netuid: "abc" }), row()]);
    const entries = (await loadSubnetLifecycle(
      {},
      7,
      { limit: 10, offset: 0 },
      store,
    ))!;
    assert.equal(entries.length, 1);
  });
});

describe("loadChainSubnetLifecycle", () => {
  test("no store answers null", async () => {
    assert.equal(
      await loadChainSubnetLifecycle({}, { limit: 10, offset: 0 }),
      null,
    );
  });

  test("an absent window adds NO lower bound and binds only the page", async () => {
    const { store, calls } = fakeStore([row()]);
    await loadChainSubnetLifecycle(
      {},
      { limit: 10, offset: 0, sinceMs: null },
      store,
    );
    assert.doesNotMatch(calls[0]!.sql, /observed_at >= \?/);
    assert.deepEqual(calls[0]!.values, [10, 0]);
  });

  test("a window adds the bound and binds it FIRST", async () => {
    // Order matters: the placeholders are positional, so a since-bound bound
    // after the page would filter on the limit.
    const { store, calls } = fakeStore([row()]);
    await loadChainSubnetLifecycle(
      {},
      { limit: 10, offset: 0, sinceMs: 1_700_000_000_000 },
      store,
    );
    assert.match(calls[0]!.sql, /WHERE observed_at >= \?/);
    assert.deepEqual(calls[0]!.values, [1_700_000_000_000, 10, 0]);
  });

  test("sinceMs of 0 is treated as no bound, not as the epoch", async () => {
    const { store, calls } = fakeStore([row()]);
    await loadChainSubnetLifecycle(
      {},
      { limit: 10, offset: 0, sinceMs: 0 },
      store,
    );
    assert.doesNotMatch(calls[0]!.sql, /observed_at >= \?/);
  });
});

describe("the envelopes", () => {
  test("per-subnet counts its entries and echoes the page", () => {
    const built = buildSubnetLifecycle([], 7, { limit: 10, offset: 20 });
    assert.equal(built.schema_version, 1);
    assert.equal(built.netuid, 7);
    assert.equal(built.entry_count, 0);
    assert.equal(built.limit, 10);
    assert.equal(built.offset, 20);
    assert.equal(built.next_cursor, null);
    assert.deepEqual(built.entries, []);
  });

  test("null rows build the same schema-stable empty page as []", () => {
    // The route answers 200 with an empty page when the store is unbound, so
    // these two must not differ in shape.
    assert.deepEqual(
      buildSubnetLifecycle(null, 7, { limit: 1, offset: 0 }),
      buildSubnetLifecycle([], 7, { limit: 1, offset: 0 }),
    );
  });

  test("the chain feed's subnet_count is DISTINCT netuids, not row count", () => {
    const entries = [
      {
        netuid: 1,
        event: "registered" as const,
        block_number: 1,
        observed_at: "",
        predates_capture: false,
      },
      {
        netuid: 1,
        event: "deregistered" as const,
        block_number: 2,
        observed_at: "",
        predates_capture: false,
      },
      {
        netuid: 2,
        event: "registered" as const,
        block_number: 3,
        observed_at: "",
        predates_capture: false,
      },
    ];
    const built = buildChainSubnetLifecycle(entries, { limit: 10, offset: 0 });
    assert.equal(built.entry_count, 3);
    assert.equal(built.subnet_count, 2, "two subnets, three events");
  });

  test("subnet_count is never greater than entry_count", () => {
    const built = buildChainSubnetLifecycle([], { limit: 10, offset: 0 });
    assert.equal(built.subnet_count, 0);
    assert.equal(built.entry_count, 0);
  });
});

describe("the declared bounds", () => {
  test("the feed defaults to `all`, not the family's 30d", () => {
    // A subnet changes state a handful of times in its LIFETIME, so a 30d
    // default would answer "nothing happened" almost every day.
    assert.equal(DEFAULT_SUBNET_LIFECYCLE_WINDOW, "all");
  });

  test("the ceiling lets a client fetch the whole table in one request", () => {
    assert.equal(CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX, 1000);
  });
});
