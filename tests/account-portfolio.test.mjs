import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountPortfolio,
  loadAccountPortfolio,
} from "../src/account-portfolio.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// A wallet holding a validator position on netuid 7 and a miner position on 12,
// plus a zero-stake position (excluded from stake concentration + yield).
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
  test("aggregates positions, counts, totals, overall yield, and stamp", () => {
    const out = buildAccountPortfolio(ROWS, SS58);
    assert.equal(out.schema_version, 1);
    assert.equal(out.ss58, SS58);
    assert.equal(out.subnet_count, 2); // netuids 7 and 12
    assert.equal(out.position_count, 3);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 2);
    assert.equal(out.total_stake_tao, 1200);
    assert.equal(out.total_emission_tao, 80);
    assert.ok(Math.abs(out.overall_yield - 80 / 1200) < 1e-6);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("positions carry per-position economics + yield, biggest stake first", () => {
    const out = buildAccountPortfolio(ROWS, SS58);
    assert.equal(out.positions[0].netuid, 7); // 1000 stake sorts first
    assert.equal(out.positions[0].role, "validator");
    assert.equal(out.positions[0].yield, 0.05); // 50 / 1000
    assert.equal(out.positions[0].trust, 0.8);
    assert.equal(out.positions[1].yield, 0.15); // 30 / 200
    assert.equal(out.positions[2].yield, null); // zero-stake → null
    assert.equal(out.positions[2].rank, null); // absent cell → null
    assert.equal(out.positions[2].active, false);
  });

  test("stake_concentration is over the positive-stake positions", () => {
    const out = buildAccountPortfolio(ROWS, SS58);
    assert.equal(out.stake_concentration.holders, 2); // zero-stake dropped
    assert.equal(out.stake_concentration.total, 1200);
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
    assert.equal(out.total_stake_tao, 100);
  });

  test("blank score cells stay null (not rank/trust 0)", () => {
    // Mirrors the blank-cell guard in metagraph-neurons.mjs (#3033): Number("") is 0.
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
  });

  test("cold/empty → schema-stable empty card", () => {
    const out = buildAccountPortfolio([], SS58);
    assert.equal(out.position_count, 0);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.captured_at, null);
    assert.equal(out.overall_yield, null);
    assert.equal(out.stake_concentration, null);
    assert.deepEqual(out.positions, []);
  });

  test("null-safe on junk rows", () => {
    const out = buildAccountPortfolio("nope", SS58);
    assert.equal(out.position_count, 0);
    assert.equal(out.stake_concentration, null);
  });

  test("loadAccountPortfolio filters by hotkey and shapes the rows", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadAccountPortfolio(d1, SS58);
    assert.match(seen.sql, /FROM neurons WHERE hotkey = \? ORDER BY netuid/);
    assert.deepEqual(seen.params, [SS58]);
    assert.equal(out.position_count, 3);
    assert.equal(out.subnet_count, 2);
  });
});

describe("GET /api/v1/accounts/{ss58}/portfolio", () => {
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
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
      neuronsEnv([]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.position_count, 0);
    assert.deepEqual(body.data.positions, []);
  });
});
