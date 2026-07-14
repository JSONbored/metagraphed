import { describe, expect, test } from "vitest";
import {
  buildAccountPositions,
  buildNominatorPositions,
  DEFAULT_EXIT_SLIPPAGE,
  loadAccountPositions,
  loadLatestAlphaPrices,
  loadNominatorPositionRows,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/account-positions.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("buildNominatorPositions", () => {
  test("keeps positive net stake rows as nominator positions", () => {
    const out = buildNominatorPositions([
      { netuid: 1, hotkey: "5Hot", net_stake_tao: 10, net_alpha_amount: 8 },
      { netuid: 2, hotkey: "5Hot2", net_stake_tao: 0, net_alpha_amount: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      position_kind: "nominator",
      netuid: 1,
      delegated_hotkey: "5Hot",
      role: "nominator",
      stake_tao: 10,
      alpha_amount: 8,
    });
  });

  test("accepts alpha-only rows and drops invalid netuid/hotkey pairs", () => {
    const out = buildNominatorPositions([
      { netuid: 1, hotkey: "5Hot", net_stake_tao: 0, net_alpha_amount: 5 },
      { netuid: null, hotkey: "5Hot", net_stake_tao: 1, net_alpha_amount: 0 },
      { netuid: 2, hotkey: "", net_stake_tao: 1, net_alpha_amount: 0 },
      "not-a-row",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      netuid: 1,
      stake_tao: 0,
      alpha_amount: 5,
    });
  });

  test("null-safe on non-array input", () => {
    expect(buildNominatorPositions(null)).toEqual([]);
  });

  test("drops rows with no net stake or alpha and coerces nullable cells", () => {
    const out = buildNominatorPositions([
      { netuid: 1, hotkey: "5Hot", net_stake_tao: "", net_alpha_amount: "" },
      { netuid: 2, hotkey: "5Hot2", net_stake_tao: 3, net_alpha_amount: null },
      { netuid: 3.5, hotkey: "5Hot3", net_stake_tao: 1, net_alpha_amount: 0 },
      { netuid: -1, hotkey: "5Hot4", net_stake_tao: 1, net_alpha_amount: 0 },
      { netuid: 4, hotkey: 123, net_stake_tao: 1, net_alpha_amount: 0 },
      { netuid: 5, hotkey: "5Hot5", net_stake_tao: "nope", net_alpha_amount: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      netuid: 2,
      stake_tao: 3,
      alpha_amount: null,
    });
  });
});

describe("buildAccountPositions", () => {
  test("merges validator-own and nominator rows with valuation fields", () => {
    const portfolio = {
      captured_at: "2026-07-14T00:00:00.000Z",
      positions: [
        {
          netuid: 1,
          uid: 3,
          role: "validator",
          active: true,
          stake_tao: 100,
          emission_tao: 1,
          rank: 0.1,
          trust: 0.2,
          incentive: 0.3,
          dividends: 0.4,
          yield: 0.01,
        },
      ],
    };
    const priceByNetuid = new Map([
      [1, 2],
      [3, 2],
    ]);
    const out = buildAccountPositions(
      {
        portfolio,
        nominatorRows: [
          { netuid: 3, hotkey: "5Val", net_stake_tao: 5, net_alpha_amount: 2 },
        ],
        priceByNetuid,
      },
      SS58,
    );
    expect(out.position_count).toBe(2);
    expect(out.total_spot_mark_tao).toBeGreaterThan(0);
    const own = out.positions.find((p) => p.position_kind === "validator-own");
    const nom = out.positions.find((p) => p.position_kind === "nominator");
    expect(own?.hotkey).toBe(SS58);
    expect(own?.spot_mark_tao).toBe(100);
    expect(own?.exit_value_tao).toBeCloseTo(100 * (1 - DEFAULT_EXIT_SLIPPAGE));
    expect(nom?.delegated_hotkey).toBe("5Val");
    expect(nom?.spot_mark_tao).toBeCloseTo(4);
  });

  test("uses stake as spot mark when alpha price is missing or zero", () => {
    const out = buildAccountPositions(
      {
        portfolio: { positions: [] },
        nominatorRows: [
          { netuid: 4, hotkey: "5Val", net_stake_tao: 7, net_alpha_amount: 3 },
        ],
        priceByNetuid: new Map([[4, 0]]),
      },
      SS58,
    );
    expect(out.positions[0].spot_mark_tao).toBe(7);
    expect(out.positions[0].alpha_price_tao).toBe(0);
    expect(out.positions[0].alpha_amount).toBe(3);
  });

  test("null portfolio yields an empty card without throwing", () => {
    const out = buildAccountPositions(
      {
        portfolio: null,
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out.position_count).toBe(0);
    expect(out.captured_at).toBeNull();
  });

  test("coerces junk stake cells to zero-valued marks", () => {
    const out = buildAccountPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 6,
              uid: 1,
              role: "miner",
              active: true,
              stake_tao: "nope",
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out.positions[0].spot_mark_tao).toBe(0);
    expect(out.total_spot_mark_tao).toBe(0);
    expect(out.total_exit_value_tao).toBe(0);
  });

  test("root netuid 0 is exempt from exit slippage", () => {
    const out = buildAccountPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 0,
              uid: 0,
              role: "validator",
              active: true,
              stake_tao: 50,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out.positions[0].spot_mark_tao).toBe(50);
    expect(out.positions[0].exit_value_tao).toBe(50);
    expect(out.positions[0].root_stake_tao).toBe(50);
    expect(out.positions[0].alpha_stake_tao).toBe(0);
  });

  test("empty inputs yield a schema-stable empty card", () => {
    const out = buildAccountPositions(
      {
        portfolio: { positions: [] },
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out).toMatchObject({
      schema_version: 1,
      ss58: SS58,
      position_count: 0,
      total_spot_mark_tao: 0,
      total_exit_value_tao: 0,
      positions: [],
    });
  });

  test("sorts by spot mark descending and falls back to stake when alpha price is absent", () => {
    const out = buildAccountPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 1,
              uid: 1,
              role: "miner",
              active: true,
              stake_tao: 20,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
            {
              netuid: 2,
              uid: 2,
              role: "miner",
              active: true,
              stake_tao: 50,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominatorRows: [],
        priceByNetuid: {},
      },
      SS58,
    );
    expect(out.positions.map((p) => p.netuid)).toEqual([2, 1]);
    expect(out.positions[0].spot_mark_tao).toBe(50);
    expect(out.positions[0].alpha_stake_tao).toBe(50);
    expect(out.total_spot_mark_tao).toBe(70);
    expect(out.total_exit_value_tao).toBeCloseTo(20 * 0.95 + 50 * 0.95);
  });

  test("breaks spot-mark ties by netuid ascending and tolerates a sparse portfolio", () => {
    const out = buildAccountPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 8,
              uid: 1,
              role: "miner",
              active: true,
              stake_tao: 10,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
            {
              netuid: 2,
              uid: 2,
              role: "miner",
              active: true,
              stake_tao: 10,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominatorRows: [
          { netuid: 5, hotkey: "5A", net_stake_tao: null, net_alpha_amount: 4 },
          { netuid: 3, hotkey: "5B", net_stake_tao: 10, net_alpha_amount: null },
        ],
        priceByNetuid: new Map([[3, 1]]),
      },
      SS58,
    );
    expect(out.positions.map((p) => p.netuid)).toEqual([2, 3, 8, 5]);
    expect(out.positions[1].spot_mark_tao).toBe(10);
    expect(out.positions[2].spot_mark_tao).toBe(10);
    expect(out.positions[3].stake_tao).toBe(4);
    expect(out.positions[3].alpha_amount).toBe(4);
  });
});

describe("loadLatestAlphaPrices", () => {
  test("returns an empty map when no netuids are requested", async () => {
    const map = await loadLatestAlphaPrices(async () => {
      throw new Error("should not query");
    }, []);
    expect(map.size).toBe(0);
  });

  test("keeps the first valid price per netuid and skips junk rows", async () => {
    const map = await loadLatestAlphaPrices(
      async () => [
        { netuid: 1, alpha_price_tao: "2.5" },
        { netuid: 1, alpha_price_tao: "9" },
        { netuid: "bad", alpha_price_tao: "1" },
        { netuid: 2, alpha_price_tao: "" },
        { netuid: 3, alpha_price_tao: "-1" },
      ],
      [1, 2, -1, null],
    );
    expect(map.get(1)).toBe(2.5);
    expect(map.has(2)).toBe(false);
    expect(map.has(3)).toBe(false);
  });

  test("null-safe when netuids or query rows are absent", async () => {
    const map = await loadLatestAlphaPrices(async () => null, null);
    expect(map.size).toBe(0);
  });

  test("accepts numeric alpha prices from snapshot rows", async () => {
    const map = await loadLatestAlphaPrices(
      async () => [{ netuid: 4, alpha_price_tao: 1.25 }],
      [4],
    );
    expect(map.get(4)).toBe(1.25);
  });

  test("ignores blank netuid cells and null price cells", async () => {
    const map = await loadLatestAlphaPrices(
      async () => [
        { netuid: "", alpha_price_tao: "1" },
        { netuid: 5, alpha_price_tao: null },
      ],
      [5],
    );
    expect(map.size).toBe(0);
  });

  test("null-safe when the query returns a non-array payload", async () => {
    const map = await loadLatestAlphaPrices(async () => null, [1]);
    expect(map.size).toBe(0);
  });
});

describe("loadNominatorPositionRows", () => {
  test("aggregates stake-added/removed events for one coldkey", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return [];
    };
    await loadNominatorPositionRows(d1, SS58);
    expect(seen.sql).toContain("FROM account_events WHERE coldkey = ?");
    expect(seen.params).toEqual([
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
      SS58,
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
    ]);
  });
});

describe("loadAccountPositions", () => {
  test("loads neurons, nominator rows, and latest alpha prices", async () => {
    const neuronRows = [
      {
        netuid: 4,
        uid: 3,
        stake_tao: 100,
        emission_tao: 1,
        rank: 0.1,
        trust: 0.2,
        incentive: 0.3,
        dividends: 0.4,
        validator_permit: 1,
        active: 1,
        captured_at: "1780000000000",
      },
    ];
    const d1 = async (sql) => {
      if (/FROM neurons WHERE hotkey/.test(sql)) return neuronRows;
      if (/FROM account_events/.test(sql)) {
        return [
          {
            netuid: 3,
            hotkey: "5Val",
            net_stake_tao: 5,
            net_alpha_amount: 2,
          },
        ];
      }
      if (/FROM subnet_snapshots/.test(sql)) {
        return [
          { netuid: 4, alpha_price_tao: 2 },
          { netuid: 3, alpha_price_tao: 2 },
        ];
      }
      return [];
    };
    const out = await loadAccountPositions(d1, SS58);
    expect(out.position_count).toBe(2);
    expect(out.captured_at).toBe(new Date(1780000000000).toISOString());
    expect(out.positions.some((p) => p.position_kind === "nominator")).toBe(
      true,
    );
  });
});

describe("GET /api/v1/accounts/{ss58}/positions", () => {
  test("cold store → 200 with an empty positions card", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/positions`),
      createLocalArtifactEnv(),
      {},
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.position_count).toBe(0);
    expect(body.data.positions).toEqual([]);
  });
});
