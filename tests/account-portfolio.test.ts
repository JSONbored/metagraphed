import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountPortfolio as buildAccountPortfolioRaw,
  loadAccountPortfolio,
  unavailableAccountPortfolioCapital,
} from "../src/account-portfolio.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

// Unit prices isolate membership/count/stamp assertions from independent
// emission pricing, which a separate describe block exercises below.
const ACCUMULATION_PRICES: Map<number, number | null> = new Map(
  Array.from({ length: 300 }, (_, netuid) => [netuid, 1]),
);

function buildAccountPortfolio(
  rows: unknown,
  ss58: string,
  options?: Partial<Parameters<typeof buildAccountPortfolioRaw>[2]>,
) {
  return buildAccountPortfolioRaw(
    rows as Array<Record<string, unknown>>,
    ss58,
    { priceByNetuid: ACCUMULATION_PRICES, ...options },
  );
}

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// Recorded validator/miner memberships, including a stored zero voting weight.
const ROWS = [
  {
    netuid: 7,
    uid: 3,
    stake_tao: 1000,
    emission_tao: 50,
    rank: 0.9,
    trust: 0.8,
    incentive: 0.5,
    dividends: 0.4,
    validator_permit: 1,
    active: 1,
    captured_at: 1_750_000_000_000,
  },
  {
    netuid: 12,
    uid: 8,
    stake_tao: 200,
    emission_tao: 30,
    rank: 0.3,
    trust: 0.2,
    incentive: 0.1,
    dividends: 0,
    validator_permit: 0,
    active: 1,
    captured_at: 1_750_000_000_000,
  },
  {
    netuid: 12,
    uid: 9,
    stake_tao: 0,
    emission_tao: 0,
    validator_permit: 0,
    active: 0,
    captured_at: 1_750_000_000_000,
  },
];

describe("buildAccountPortfolio", () => {
  test("preserves membership counts, emission and stamp without inferring capital", () => {
    const out = buildAccountPortfolio(ROWS, SS58);
    assert.equal(out.schema_version, 1);
    assert.equal(out.ss58, SS58);
    assert.equal(out.subnet_count, 2); // netuids 7 and 12
    assert.equal(out.position_count, 3);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 2);
    assert.equal(out.total_stake_tao, null);
    assert.equal(out.total_emission_tao, 80);
    assert.equal(out.overall_yield, null);
    assert.equal(out.stake_concentration, null);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("preserves per-membership scores while declining quantity and yield", () => {
    const out = buildAccountPortfolio(ROWS, SS58);
    assert.equal(out.positions[0].netuid, 7);
    assert.equal(out.positions[0].role, "validator");
    assert.equal(out.positions[0].yield, null);
    assert.equal(out.positions[0].trust, 0.8);
    assert.equal(out.positions[1].yield, null);
    assert.equal(out.positions[2].yield, null);
    assert.ok(out.positions.every((position) => position.stake_alpha === null));
    assert.equal(out.positions[2].rank, null); // absent cell → null
    assert.equal(out.positions[2].active, false);
  });

  test("voting weight cannot change capital, concentration, yield or membership selection", () => {
    const baseline = buildAccountPortfolio(ROWS, SS58);
    for (const weight of [0, 1, 10_000_000, null, "junk", -1]) {
      const changed = ROWS.map((row) => ({ ...row, stake_tao: weight }));
      assert.deepEqual(buildAccountPortfolio(changed, SS58), baseline);
    }
  });

  test("orders every membership by subnet then uid rather than voting weight", () => {
    const out = buildAccountPortfolio(
      [
        { netuid: 12, uid: 9, stake_tao: 1_000_000 },
        { netuid: 7, uid: null, stake_tao: 99 },
        { netuid: 7, uid: 4, stake_tao: 1 },
        { netuid: 7, uid: 2, stake_tao: 0 },
      ],
      SS58,
    );
    assert.deepEqual(
      out.positions.map((position) => [position.netuid, position.uid]),
      [
        [7, 2],
        [7, 4],
        [7, null],
        [12, 9],
      ],
    );
  });

  test("drops positions with a non-numeric netuid; coerces numeric strings", () => {
    const out = buildAccountPortfolio(
      [
        {
          netuid: "7",
          uid: "3",
          stake_tao: "100",
          emission_tao: "5",
          rank: "junk", // non-numeric score → null (not 0)
        },
        { netuid: "", stake_tao: 1 }, // blank → dropped (not subnet 0)
        { netuid: null }, // dropped
        { netuid: "x" }, // dropped
        { netuid: -1 }, // dropped
      ],
      SS58,
    );
    assert.equal(out.position_count, 1);
    assert.equal(out.subnet_count, 1);
    assert.equal(out.positions[0].uid, 3); // "3" coerced
    assert.equal(out.positions[0].rank, null); // non-numeric score dropped
    assert.equal(out.total_stake_tao, null);
  });

  test("blank score cells stay null (not rank/trust 0)", () => {
    // Mirrors the blank-cell guard in metagraph-neurons.ts (#3033): Number("") is 0.
    for (const blank of ["", "   "]) {
      const out = buildAccountPortfolio(
        [
          {
            netuid: 1,
            uid: 1,
            stake_tao: 10,
            rank: blank,
            trust: blank,
            incentive: blank,
            dividends: blank,
          },
        ],
        SS58,
      );
      assert.equal(out.position_count, 1);
      assert.equal(
        out.positions[0].rank,
        null,
        `rank for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        out.positions[0].trust,
        null,
        `trust for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        out.positions[0].incentive,
        null,
        `incentive for ${JSON.stringify(blank)}`,
      );
      assert.equal(
        out.positions[0].dividends,
        null,
        `dividends for ${JSON.stringify(blank)}`,
      );
    }
    const missing = buildAccountPortfolio(
      [
        {
          netuid: 2,
          uid: 1,
          stake_tao: 10,
          rank: null,
          trust: null,
          incentive: null,
          dividends: null,
        },
      ],
      SS58,
    );
    assert.equal(missing.positions[0].rank, null);
    assert.equal(missing.positions[0].trust, null);
    const zero = buildAccountPortfolio(
      [{ netuid: 3, uid: 1, stake_tao: 10, rank: 0, trust: "0" }],
      SS58,
    );
    assert.equal(zero.positions[0].rank, 0);
    assert.equal(zero.positions[0].trust, 0);
  });

  test("accepts a string epoch-ms captured_at, ignoring absent ones", () => {
    const out = buildAccountPortfolio(
      [
        { netuid: 1, stake_tao: 1, captured_at: "1750000000000" },
        { netuid: 2, stake_tao: 1, captured_at: null },
      ],
      SS58,
    );
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("rejects a 0/negative/out-of-range captured_at instead of leaking a junk stamp", () => {
    const out = buildAccountPortfolio(
      [
        { netuid: 1, stake_tao: 1, captured_at: 0 },
        { netuid: 2, stake_tao: 1, captured_at: -1 },
        { netuid: 3, stake_tao: 1, captured_at: 8_640_000_000_000_001 }, // beyond Date range
      ],
      SS58,
    );
    assert.equal(out.captured_at, null);
    assert.equal(out.total_stake_tao, null);
  });

  test("cold/empty → schema-stable empty card", () => {
    const out = buildAccountPortfolio([], SS58);
    assert.equal(out.position_count, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.captured_at, null);
    assert.equal(out.total_stake_tao, null);
    assert.equal(out.overall_yield, null);
    assert.equal(out.stake_concentration, null);
    assert.deepEqual(out.positions, []);
  });

  test("null-safe on junk rows", () => {
    const out = buildAccountPortfolio(
      "nope" as unknown as Record<string, unknown>[],
      SS58,
    );
    assert.equal(out.position_count, 0);
    assert.equal(out.stake_concentration, null);
  });

  test("loadAccountPortfolio filters by hotkey and shapes the rows", async () => {
    let seen: { sql: string; params: unknown[] } | undefined;
    const runner = async (sql: string, params: unknown[]) => {
      // #9051: answer the loader's new subnet_snapshots price read separately
      // so the assertions below still pin the neurons query.
      if (sql.includes("subnet_snapshots")) return [];
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadAccountPortfolio(runner, SS58);
    assert.match(seen!.sql, /FROM neurons WHERE hotkey = \? ORDER BY netuid/);
    assert.deepEqual(seen!.params, [SS58]);
    assert.equal(out.position_count, 3);
    assert.equal(out.subnet_count, 2);
  });
});

describe("GET /api/v1/accounts/{ss58}/portfolio", () => {
  function neuronsEnv(rows: Row[]) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM neurons WHERE hotkey/.test(sql) ? rows : [],
                }),
            }),
          };
        },
      },
    };
  }

  test("cold store → 200 with an empty portfolio", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/portfolio`),
      neuronsEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_tao, null);
    assert.deepEqual(body.data.positions, []);
  });
});

describe("independent portfolio emission pricing", () => {
  test("prices only emission and preserves unpriced memberships without a principal estimate", () => {
    const out = buildAccountPortfolioRaw(
      [
        {
          netuid: 0,
          uid: 0,
          stake_tao: 50,
          emission_tao: 5,
          validator_permit: 1,
        },
        {
          netuid: 1,
          uid: 1,
          stake_tao: 800,
          emission_tao: 40,
          validator_permit: 0,
        },
        {
          netuid: 4,
          uid: 2,
          stake_tao: 12,
          emission_tao: 3,
          validator_permit: 0,
        },
      ],
      SS58,
      {
        priceByNetuid: new Map<number, number | null>([
          [1, 0.5],
          [4, null],
        ]),
      },
    );
    assert.equal(out.total_stake_tao, null);
    assert.equal(out.total_emission_tao, 25); // 5 + 40*0.5
    assert.equal(out.overall_yield, null);
    assert.equal(out.stake_concentration, null);
    const sn1 = out.positions.find((p) => p.netuid === 1)!;
    assert.equal(sn1.stake_alpha, null);
    assert.equal(sn1.emission_alpha, 40);
    assert.equal(out.position_count, 3);
    assert.deepEqual(out.positions.map((position) => position.netuid), [0, 1, 4]);
  });
});

describe("unavailableAccountPortfolioCapital", () => {
  test("clears old positive and zero financial values while preserving the complete evidence", () => {
    for (const legacyValue of [1200, 0]) {
      const original = {
        ss58: SS58,
        captured_at: "2026-07-05T00:00:00Z",
        position_count: 3,
        total_stake_tao: legacyValue,
        total_emission_tao: 80,
        overall_yield: legacyValue,
        stake_concentration: { total: legacyValue, holders: 3 },
        positions: [
          {
            netuid: 12,
            uid: 8,
            stake_alpha: legacyValue,
            emission_alpha: 30,
            yield: legacyValue,
          },
          {
            netuid: 7,
            uid: 4,
            stake_alpha: legacyValue,
            trust: 0.8,
            yield: legacyValue,
          },
          {
            netuid: 7,
            uid: 2,
            stake_alpha: legacyValue,
            active: false,
            yield: legacyValue,
          },
        ],
      };
      const before = structuredClone(original);
      const guarded = unavailableAccountPortfolioCapital(original);
      assert.equal(guarded.total_stake_tao, null);
      assert.equal(guarded.overall_yield, null);
      assert.equal(guarded.stake_concentration, null);
      assert.equal(guarded.total_emission_tao, 80);
      assert.equal(guarded.position_count, 3);
      assert.equal(guarded.captured_at, original.captured_at);
      assert.deepEqual(guarded.positions, [
        { netuid: 7, uid: 2, stake_alpha: null, active: false, yield: null },
        { netuid: 7, uid: 4, stake_alpha: null, trust: 0.8, yield: null },
        { netuid: 12, uid: 8, stake_alpha: null, emission_alpha: 30, yield: null },
      ]);
      assert.deepEqual(
        original,
        before,
        "a guard must not mutate a shared cached response",
      );
      assert.deepEqual(unavailableAccountPortfolioCapital(guarded), guarded);
    }
  });

  test("preserves all complete memberships beyond a display-sized list", () => {
    const original = {
      position_count: 300,
      positions: Array.from({ length: 300 }, (_, index) => ({
        netuid: 299 - index,
        uid: index,
        stake_alpha: index,
        yield: index,
      })),
    };
    const guarded = unavailableAccountPortfolioCapital(original);
    const positions = guarded.positions as Row[];
    assert.equal(guarded.position_count, 300);
    assert.equal(positions.length, 300);
    assert.deepEqual(
      positions.map((position) => position.netuid),
      Array.from({ length: 300 }, (_, index) => index),
    );
    assert.ok(
      positions.every(
        (position) => position.stake_alpha === null && position.yield === null,
      ),
    );
    assert.equal(original.positions[0].netuid, 299);
  });

  test("does not invent a measured empty list when a legacy list is absent or malformed", () => {
    assert.equal(
      Object.hasOwn(unavailableAccountPortfolioCapital({}), "positions"),
      false,
    );
    for (const positions of [null, "unknown", { count: 1 }]) {
      const guarded = unavailableAccountPortfolioCapital({ positions });
      assert.equal(guarded.positions, positions);
      assert.equal(guarded.total_stake_tao, null);
    }
    const guarded = unavailableAccountPortfolioCapital({
      positions: [
        { netuid: 2, uid: null },
        "unknown",
        { netuid: 1, uid: null },
        null,
        { netuid: 1, uid: 3 },
        [],
        {},
      ],
    });
    const positions = guarded.positions as unknown[];
    assert.equal(positions.length, 7);
    assert.deepEqual(positions.slice(0, 3), [
      { netuid: 1, uid: 3, stake_alpha: null, yield: null },
      { netuid: 1, uid: null, stake_alpha: null, yield: null },
      { netuid: 2, uid: null, stake_alpha: null, yield: null },
    ]);
    assert.deepEqual(positions.slice(3), [
      "unknown",
      null,
      [],
      { stake_alpha: null, yield: null },
    ]);
  });
});
