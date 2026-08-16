// The PRODUCTION read path: `loadAxonRemovals` going through `readStore` to
// Postgres, rather than the injected `query` the other suites use.
//
// Its own file because it needs `vi.mock("pg", …)` at module scope, and mixing
// that into the pure-logic suites would make them depend on a database double
// they have no use for.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import { loadAxonRemovals } from "../src/axon-removals-loader.ts";

beforeEach(() => {
  pg.control.queries.length = 0;
  pg.control.rows = [];
  pg.control.failNext = null;
});

describe("loadAxonRemovals — through readStore", () => {
  test("reads Postgres and derives from what it returns", async () => {
    pg.control.rows = [
      {
        netuid: 7,
        uid: 1,
        snapshot_date: "2026-08-01",
        hotkey: "hkA",
        axon: "1.2.3.4:8091",
      },
      {
        netuid: 7,
        uid: 1,
        snapshot_date: "2026-08-02",
        hotkey: "hkA",
        axon: null,
      },
      {
        netuid: 7,
        uid: 1,
        snapshot_date: "2026-08-03",
        hotkey: "hkA",
        axon: null,
      },
    ];
    const out = await loadAxonRemovals(pgMockEnv());
    assert.deepEqual(out!.subnets, [
      { netuid: 7, distinct_removers: 1, removals: 1 },
    ]);
    // The narrowing predicate reaches the database, not just the unit test.
    assert.equal(pg.control.queries.length, 1);
    assert.match(String(pg.control.queries[0]!.text), /FROM neuron_daily/);
    assert.match(String(pg.control.queries[0]!.text), /JOIN dropped/);
  });

  test("an unbound Hyperdrive is null, and never reaches a query", async () => {
    const out = await loadAxonRemovals({});
    assert.equal(out, null);
    assert.equal(pg.control.queries.length, 0, "no store, no read");
  });
});
