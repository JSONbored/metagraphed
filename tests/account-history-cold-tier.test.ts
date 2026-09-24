import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test, vi } from "vitest";
import { loadAccountHistoryColdTier } from "../src/account-history-cold-tier.ts";
import * as indexed from "../src/account-history-indexed.ts";
import * as projection from "../src/account-summary-projection.ts";
type Row = Record<string, unknown>;
const reader = vi.spyOn(indexed, "loadIndexedAccountHistoryRows"),
  floor = vi.spyOn(projection, "accountHistoryFloorMs");
const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

/** The engine returns a full timestamp for a truncated day. */
const ts = (day: string) => `${day}T00:00:00.000000000Z`;

const DAYS: Row[] = [
  {
    day: ts("2026-08-03"),
    netuid: 64,
    event_count: 72,
    first_block: 8_759_894,
    last_block: 8_765_497,
  },
  {
    day: ts("2026-08-03"),
    netuid: 18,
    event_count: 39,
    first_block: 8_760_210,
    last_block: 8_765_627,
  },
  {
    day: ts("2026-08-02"),
    netuid: 64,
    event_count: 12,
    first_block: 8_750_000,
    last_block: 8_755_000,
  },
];
const KINDS: Row[] = [
  { day: ts("2026-08-03"), netuid: 64, event_kind: "StakeAdded" },
  { day: ts("2026-08-03"), netuid: 64, event_kind: "WeightsSet" },
  { day: ts("2026-08-03"), netuid: 18, event_kind: "StakeRemoved" },
  { day: ts("2026-08-02"), netuid: 64, event_kind: "StakeAdded" },
];

const rows = () =>
  DAYS.map((row) => ({
    ...row,
    event_kinds: KINDS.filter(
      (k) => k.day === row.day && k.netuid === row.netuid,
    )
      .map((k) => k.event_kind)
      .join(","),
  }));
beforeEach(() => {
  reader.mockReset().mockResolvedValue(rows());
  floor.mockReset().mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP forbidden");
    }),
  );
});
describe("native account history", () => {
  test("preserves day/subnet ordering, kinds and exact cursor boundary days", async () => {
    const all = await loadAccountHistoryColdTier({}, SS58, { limit: 100 });
    assert.equal(all?.day_count, 3);
    assert.equal(all.days[0].day, "2026-08-03");
    assert.deepEqual(all.days[0].event_kinds, ["StakeAdded", "WeightsSet"]);
    assert.equal(all.days[1].netuid, 18);
    const first = await loadAccountHistoryColdTier({}, SS58, { limit: 1 });
    assert.equal(first?.next_cursor, "20260803.64");
    const next = await loadAccountHistoryColdTier({}, SS58, {
      limit: 2,
      offset: 99,
      cursor: first?.next_cursor,
    });
    assert.deepEqual(
      next?.days.map((r) => [r.day, r.netuid]),
      [
        ["2026-08-03", 18],
        ["2026-08-02", 64],
      ],
    );
    assert.equal(reader.mock.lastCall?.[3], 514);
  });
  test("applies floor, inclusive date bounds and subnet narrowing without losing a boundary day", async () => {
    floor.mockResolvedValue(Date.parse("2026-08-02T00:00:00Z"));
    await loadAccountHistoryColdTier({}, SS58, {
      limit: 10,
      netuid: 7,
      from: "2026-08-01",
      to: "2026-08-03",
    });
    assert.deepEqual(reader.mock.lastCall, [
      {},
      SS58,
      {
        netuid: 7,
        observedStart: Date.parse("2026-08-02T00:00:00Z"),
        observedEnd: Date.parse("2026-08-04T00:00:00Z") - 1,
      },
      10,
    ]);
  });
  test("offset and malformed cursors preserve first-page behavior", async () => {
    const result = await loadAccountHistoryColdTier({}, SS58, {
      limit: 1,
      offset: 1,
      cursor: "bad",
    });
    assert.equal(result?.days[0].netuid, 18);
    assert.equal(reader.mock.lastCall?.[3], 2);
    reader.mockResolvedValue([]);
    const empty = await loadAccountHistoryColdTier({}, SS58, { limit: 2 });
    assert.equal(empty?.day_count, 0);
    assert.equal(empty.next_cursor, null);
  });
  test("declines invalid input and missing native coverage", async () => {
    assert.equal(
      await loadAccountHistoryColdTier({}, "bad", { limit: 2 }),
      null,
    );
    for (const query of [
      { limit: 0 },
      { limit: 2, offset: -1 },
      { limit: 2, netuid: -1 },
      { limit: 2, from: "bad" },
      { limit: 2, to: "2026-99-99" },
    ])
      assert.equal(await loadAccountHistoryColdTier({}, SS58, query), null);
    assert.equal(reader.mock.calls.length, 0);
    for (const value of [null, undefined]) {
      reader.mockResolvedValue(value);
      assert.equal(
        await loadAccountHistoryColdTier({}, SS58, { limit: 2 }),
        null,
      );
    }
  });
  test("unusable day cells are not published as historical facts", async () => {
    reader.mockResolvedValue([
      { ...rows()[0], day: null },
      { ...rows()[1], day: "bad" },
      rows()[2],
    ]);
    assert.equal(
      (await loadAccountHistoryColdTier({}, SS58, { limit: 2 }))?.day_count,
      1,
    );
  });
});
describe("all three history surfaces reach the lakehouse", () => {
  test("REST calls the reader and MCP/GraphQL go through the shared loader", () => {
    assert.match(
      readFileSync("workers/request-handlers/entities.ts", "utf8"),
      /loadAccountHistoryColdTier\(/,
      "REST would answer a zeroed series",
    );
    // MCP and GraphQL both call loadAccountHistory, which is now the thing that
    // reaches the lakehouse -- so wiring it once covers both.
    const shared = readFileSync("src/account-events.ts", "utf8");
    assert.match(shared, /loadAccountHistoryColdTier\(/);
    for (const path of ["src/mcp-server.ts", "src/graphql.ts"]) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadAccountHistory\(\s*(ctx|context)\.env,/,
        `${path} must pass env, or the loader cannot reach the lakehouse`,
      );
    }
  });
});
