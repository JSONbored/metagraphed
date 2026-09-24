import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import * as feed from "../src/indexed-account-feeds.ts";
import * as weights from "../src/account-weight-setters-native.ts";
import * as nominators from "../src/validator-nominators-indexed.ts";
import { nativeAccountRow } from "./helpers/native-account-row.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { AccountFeedGroup } from "../src/history-account-feed-groups.ts";
import {
  loadAccountTransfersColdTier,
  loadAccountStakeFlowColdTier,
  loadAccountStakeMovesColdTier,
  loadAccountRegistrationsColdTier,
  loadAccountServingColdTier,
  loadAccountPrometheusColdTier,
  loadAccountWeightSettersColdTier,
  loadAccountCounterpartiesColdTier,
  loadCounterpartyRelationshipColdTier,
  loadValidatorNominatorsColdTier,
} from "../src/account-feeds-cold-tier.ts";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  OTHER = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const NOW = 1_700_000_100_000;
const page = vi.spyOn(feed, "loadIndexedAccountFeedPage"),
  groups = vi.spyOn(feed, "loadIndexedAccountFeedGroups"),
  weight = vi.spyOn(weights, "loadNativeAccountWeightSetters"),
  nominator = vi.spyOn(nominators, "loadIndexedValidatorNominators");
function event(block = 100, index = 1) {
  return nativeAccountRow({
    block_number: block,
    event_index: index,
    observed_at: NOW + block,
    hotkey: ADDR,
    coldkey: OTHER,
    amount_tao: 12.5,
  });
}
function group(
  kind = "StakeAdded",
  extra: Partial<AccountFeedGroup> = {},
): AccountFeedGroup {
  return {
    event_kind: kind,
    netuid: 7,
    event_count: 4,
    total_tao: 12.5,
    total_alpha: 25,
    first_block: 1,
    last_block: 100,
    first_observed: NOW - 1000,
    last_observed: NOW,
    ...extra,
  };
}
function store(rows: Record<string, unknown>[], fail = false) {
  pg.control.rows = rows;
  pg.control.onQuery = null;
  pg.control.answers = [];
  pg.control.failNext = fail ? Error("store down") : null;
  return { ...pgMockEnv(), NATIVE_PROJECTIONS: "enabled" };
}
beforeEach(() => {
  page.mockReset().mockResolvedValue([]);
  groups.mockReset().mockResolvedValue([]);
  weight.mockReset().mockResolvedValue([]);
  nominator.mockReset().mockResolvedValue({ rows: [], totalCount: 0 });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP forbidden");
    }),
  );
});
describe("native transfer feed", () => {
  test("preserves direction, ranges, composite cursor and an already paged result", async () => {
    for (const [direction, sides] of [
      [undefined, ["hotkey", "coldkey"]],
      ["all", ["hotkey", "coldkey"]],
      ["sent", ["hotkey"]],
      ["received", ["coldkey"]],
    ] as const) {
      page.mockResolvedValue([event(100, 2), event(100, 1)]);
      const result = await loadAccountTransfersColdTier({}, ADDR, {
        limit: 2,
        offset: 5,
        direction,
        blockStart: 10,
        blockEnd: 200,
        cursor: "1700000100300.300.3",
      });
      assert.equal(result?.transfer_count, 2);
      assert.equal(result?.next_cursor, `${NOW + 100}.100.1`);
      assert.deepEqual(
        page.mock.lastCall?.[1],
        sides.map((side) => ({
          side,
          account: ADDR,
          kind: "Transfer",
          blockStart: 10,
          blockEnd: 200,
          cursor: [1700000100300, 300, 3],
        })),
      );
      assert.equal(page.mock.lastCall?.[3], 0);
    }
  });
  test("offset applies once, malformed cursor means first page, short pages terminate", async () => {
    page.mockResolvedValue([event()]);
    const result = await loadAccountTransfersColdTier({}, ADDR, {
      limit: 5,
      offset: 2,
      cursor: "bad",
    });
    assert.equal(result?.transfer_count, 1);
    assert.equal(result?.next_cursor, null);
    assert.equal(page.mock.lastCall?.[3], 2);
    assert.equal(page.mock.lastCall?.[1][0].cursor, null);
    page.mockResolvedValue([nativeAccountRow({ observed_at: null })]);
    assert.equal(
      (await loadAccountTransfersColdTier({}, ADDR, { limit: 1 }))?.next_cursor,
      null,
    );
  });
  test("invalid input never widens the read; unavailable history declines", async () => {
    for (const args of [
      { limit: 0 },
      { limit: 5, offset: 100000 },
      { limit: 5, offset: -1 },
      { limit: 5, direction: "bad" },
      { limit: 5, blockStart: -1 },
      { limit: 5, blockEnd: "bad" },
    ])
      assert.equal(await loadAccountTransfersColdTier({}, ADDR, args), null);
    assert.equal(
      await loadAccountTransfersColdTier({}, "bad", { limit: 1 }),
      null,
    );
    assert.equal(page.mock.calls.length, 0);
    for (const value of [null, undefined]) {
      page.mockResolvedValue(value);
      assert.equal(
        await loadAccountTransfersColdTier({}, ADDR, { limit: 1 }),
        null,
      );
    }
  });
});
describe("native complete account aggregates", () => {
  test("stake flow forwards both units and chooses the exact direction and default window", async () => {
    groups.mockResolvedValue([group()]);
    for (const [direction, kinds] of [
      [undefined, ["StakeAdded", "StakeRemoved"]],
      ["in", ["StakeAdded"]],
      ["out", ["StakeRemoved"]],
    ] as const) {
      const result = await loadAccountStakeFlowColdTier({}, ADDR, {
        direction,
        window: "unknown",
      });
      assert.ok(result);
      assert.equal(result.data.window, "30d");
      assert.equal(result.rows[0].total_alpha, 25);
      assert.deepEqual(
        groups.mock.lastCall?.[1],
        kinds.flatMap((kind) =>
          ["hotkey", "coldkey"].map((side) => ({
            side,
            account: ADDR,
            kind,
            observedStart: NOW - 30 * 86400000,
          })),
        ),
      );
    }
    groups.mockResolvedValue([group("StakeAdded", { total_tao: null })]);
    assert.ok(await loadAccountStakeFlowColdTier({}, ADDR));
    assert.equal(
      await loadAccountStakeFlowColdTier({}, ADDR, { direction: "bad" }),
      null,
    );
    assert.equal(await loadAccountStakeFlowColdTier({}, "bad"), null);
    groups.mockResolvedValue(null);
    assert.equal(await loadAccountStakeFlowColdTier({}, ADDR), null);
  });
  test("maps native event counts into every published account scorecard", async () => {
    const cases = [
      {
        load: loadAccountRegistrationsColdTier,
        kind: "NeuronRegistered",
        field: "total_registrations",
        sides: ["hotkey"],
      },
      {
        load: loadAccountServingColdTier,
        kind: "AxonServed",
        field: "total_announcements",
        sides: ["hotkey"],
      },
      {
        load: loadAccountPrometheusColdTier,
        kind: "PrometheusServed",
        field: "total_announcements",
        sides: ["hotkey"],
      },
      {
        load: loadAccountStakeMovesColdTier,
        kind: "StakeMoved",
        field: "total_movements",
        sides: ["hotkey", "coldkey"],
      },
    ];
    for (const item of cases) {
      groups.mockResolvedValue([group(item.kind)]);
      const result = await item.load({}, ADDR, { window: "7d" });
      assert.ok(result);
      assert.equal(Reflect.get(result.data, item.field), 4, item.kind);
      assert.equal(result.generatedAt, new Date(NOW).toISOString());
      assert.deepEqual(
        groups.mock.lastCall?.[1],
        item.sides.map((side) => ({
          side,
          account: ADDR,
          kind: item.kind,
          observedStart: NOW - 7 * 86400000,
        })),
      );
      groups.mockResolvedValue([]);
      const empty = await item.load({}, ADDR);
      assert.ok(empty);
      assert.equal(Reflect.get(empty.data, item.field), 0);
      assert.equal(empty.generatedAt, null);
      assert.equal(await item.load({}, "bad"), null);
    }
  });
  test("unavailable aggregates decline and stake moves retain explicit gap semantics", async () => {
    for (const load of [
      loadAccountRegistrationsColdTier,
      loadAccountServingColdTier,
      loadAccountPrometheusColdTier,
    ])
      for (const value of [null, undefined]) {
        groups.mockResolvedValue(value);
        assert.equal(await load({}, ADDR), null);
      }
    groups.mockResolvedValue(undefined);
    assert.equal(await loadAccountStakeMovesColdTier({}, ADDR), null);
    for (const value of [null, undefined]) {
      groups.mockResolvedValue(value);
      const result = await loadAccountStakeMovesColdTier(
        { NATIVE_PROJECTIONS: "enabled" },
        ADDR,
      );
      assert.ok(result?.data.degraded);
      assert.equal(result.generatedAt, null);
    }
  });
  test("price enrichment reads live snapshots and tolerates unavailable or nonfinite prices", async () => {
    groups.mockResolvedValue([group("StakeMoved")]);
    const date = new Date(NOW).toISOString().slice(0, 10);
    for (const [rows, price] of [
      [[{ netuid: 7, snapshot_date: date, alpha_price_tao: 0.25 }], 0.25],
      [[{ netuid: 7, snapshot_date: date, alpha_price_tao: "bad" }], null],
    ] as const) {
      const result = await loadAccountStakeMovesColdTier(
        store([...rows]),
        ADDR,
      );
      assert.equal(result?.data.subnets[0].price_tao_at_last_move, price);
    }
    assert.ok(await loadAccountStakeMovesColdTier(store([], true), ADDR));
  });
  test("weight sets retain all registered slot pairs and decline missing or malformed slots", async () => {
    for (const slots of [
      [],
      [
        { netuid: 11, uid: 4 },
        { netuid: 20, uid: 9 },
      ],
      Array.from({ length: 128 }, (_, i) => ({ netuid: i, uid: i + 1 })),
    ]) {
      weight.mockResolvedValue([
        {
          netuid: 11,
          weight_sets: 6,
          first_observed: NOW - 1000,
          last_observed: NOW,
        },
      ]);
      const result = await loadAccountWeightSettersColdTier(store(slots), ADDR);
      assert.equal(result?.data.total_weight_sets, 6);
      assert.deepEqual(weight.mock.lastCall?.[2], slots);
      assert.equal(weight.mock.lastCall?.[3], NOW - 7 * 86400000);
    }
    for (const slots of [
      [{ netuid: "bad", uid: 1 }],
      [{ netuid: 1, uid: null }],
    ])
      assert.equal(
        await loadAccountWeightSettersColdTier(store(slots), ADDR),
        null,
      );
    assert.equal(await loadAccountWeightSettersColdTier({}, ADDR), null);
    assert.equal(
      await loadAccountWeightSettersColdTier(store([], true), ADDR),
      null,
    );
    assert.equal(await loadAccountWeightSettersColdTier({}, "bad"), null);
    weight.mockResolvedValue(null);
    assert.equal(await loadAccountWeightSettersColdTier(store([]), ADDR), null);
  });
});
describe("counterparty and nominator contracts", () => {
  test("counterparties retain capped totals and pair orientation", async () => {
    page.mockResolvedValue([
      event(),
      nativeAccountRow({
        ...event(99),
        hotkey: OTHER,
        coldkey: ADDR,
        amount_tao: 5,
      }),
    ]);
    const list = await loadAccountCounterpartiesColdTier({}, ADDR, {
      limit: 1,
    });
    assert.equal(list?.total_sent_tao, 12.5);
    assert.equal(list?.total_received_tao, 5);
    assert.equal(page.mock.lastCall?.[2], 5000);
    const pair = await loadCounterpartyRelationshipColdTier({}, ADDR, OTHER, {
      limit: 1,
    });
    assert.equal(pair?.counterparty_count, 1);
    assert.equal(pair?.relationship.transfer_count, 2);
    assert.equal(pair?.counterparties[0].net_tao, -7.5);
    assert.deepEqual(
      page.mock.lastCall?.[1],
      ["hotkey", "coldkey"].map((side) => ({
        side,
        account: ADDR,
        counterparty: OTHER,
        kind: "Transfer",
      })),
    );
    page.mockResolvedValue([]);
    assert.equal(
      (await loadCounterpartyRelationshipColdTier({}, ADDR, OTHER))
        ?.counterparty_count,
      0,
    );
    for (const load of [
      () => loadAccountCounterpartiesColdTier({}, ADDR),
      () => loadCounterpartyRelationshipColdTier({}, ADDR, OTHER),
    ]) {
      page.mockResolvedValue(null);
      assert.equal(await load(), null);
    }
    assert.equal(await loadAccountCounterpartiesColdTier({}, "bad"), null);
    assert.equal(
      await loadCounterpartyRelationshipColdTier({}, "bad", OTHER),
      null,
    );
    assert.equal(
      await loadCounterpartyRelationshipColdTier({}, ADDR, "bad"),
      null,
    );
  });
  test("nominators preserve every sort, coldkey narrowing, true total and one offset", async () => {
    const row = {
      coldkey: OTHER,
      staked_tao: 10,
      unstaked_tao: 2,
      net_staked_tao: 8,
      gross_staked_tao: 12,
      event_count: 3,
      last_observed: NOW,
    };
    nominator.mockResolvedValue({ rows: [row, row], totalCount: 7 });
    for (const sort of ["net_staked", "gross_staked", "last_activity"]) {
      const result = await loadValidatorNominatorsColdTier({}, ADDR, {
        window: "7d",
        sort,
        coldkey: OTHER,
        limit: 1,
        offset: 1,
      });
      assert.equal(result?.data.nominator_count, 7);
      assert.ok(Array.isArray(result.data.nominators));
      assert.equal(result.data.nominators.length, 1);
      assert.deepEqual(nominator.mock.lastCall?.[3], {
        coldkey: OTHER,
        sort,
        limit: 1,
        offset: 1,
      });
    }
    nominator.mockResolvedValue({ rows: [], totalCount: 0 });
    assert.equal(
      (
        await loadValidatorNominatorsColdTier({}, ADDR, {
          limit: 3,
          window: "bad",
        })
      )?.data.window,
      "30d",
    );
    for (const query of [
      { limit: 0 },
      { limit: 2, offset: -1 },
      { limit: 2, offset: 100000 },
      { limit: 2, sort: "bad" },
      { limit: 2, coldkey: "bad" },
    ])
      assert.equal(
        await loadValidatorNominatorsColdTier({}, ADDR, query),
        null,
      );
    assert.equal(
      await loadValidatorNominatorsColdTier({}, "bad", { limit: 1 }),
      null,
    );
    for (const value of [null, undefined]) {
      nominator.mockResolvedValue(value);
      assert.equal(
        await loadValidatorNominatorsColdTier({}, ADDR, { limit: 1 }),
        null,
      );
    }
  });
});
