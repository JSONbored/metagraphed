import { describe, expect, test } from "vitest";

import {
  buildWalletPositions,
  DEFAULT_EXIT_SLIPPAGE,
  economicsByNetuidFromRows,
} from "../src/wallet-positions.mjs";

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("buildWalletPositions", () => {
  test("merges validator-own and nominator rows with valuation fields", () => {
    const econ = economicsByNetuidFromRows([
      {
        netuid: 1,
        alpha_price_tao: 2,
        tao_in_pool_tao: 10000,
        alpha_in_pool: 5000,
      },
      {
        netuid: 0,
        alpha_price_tao: 1,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
      },
    ]);

    const out = buildWalletPositions(
      {
        portfolio: {
          captured_at: "2026-07-14T08:00:00.000Z",
          positions: [
            {
              netuid: 1,
              uid: 3,
              role: "validator",
              active: true,
              stake_tao: 100,
              emission_tao: 1,
              rank: 1,
              trust: 0.9,
              incentive: 0.8,
              dividends: 0.7,
              yield: 0.01,
            },
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
        nominator: {
          positions: [
            {
              hotkey: "5Hot",
              netuid: 3,
              share_fraction: 0.25,
              stake_tao: 40,
            },
          ],
        },
        economicsByNetuid: econ,
      },
      SS58,
    );

    expect(out.position_count).toBe(3);
    expect(out.total_stake_tao).toBe(190);
    expect(out.total_spot_mark_tao).toBeGreaterThan(0);
    expect(out.total_exit_value_tao).toBeGreaterThan(0);

    const own = out.positions.find((p) => p.position_kind === "validator-own");
    expect(own).toMatchObject({
      netuid: 1,
      hotkey: SS58,
      stake_tao: 100,
      alpha_stake_tao: 100,
      root_stake_tao: 0,
    });
    expect(own.spot_mark_tao).toBe(100);
    expect(own.exit_value_tao).toBeGreaterThan(0);

    const root = out.positions.find((p) => p.netuid === 0);
    expect(root.spot_mark_tao).toBe(50);
    expect(root.exit_value_tao).toBe(50);

    const nom = out.positions.find((p) => p.position_kind === "nominator");
    expect(nom).toMatchObject({
      netuid: 3,
      delegated_hotkey: "5Hot",
      role: "nominator",
      stake_tao: 40,
    });
    expect(nom.realized_yield_tao).toBeNull();
  });

  test("falls back to slippage band when pool reserves are absent", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 8,
              uid: 1,
              role: "miner",
              active: true,
              stake_tao: 200,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([[8, { alpha_price_tao: 1.5 }]]),
      },
      SS58,
    );

    expect(out.positions[0].exit_value_tao).toBeCloseTo(
      200 * (1 - DEFAULT_EXIT_SLIPPAGE),
      6,
    );
  });

  test("returns a schema-stable empty card", () => {
    const out = buildWalletPositions({}, SS58);
    expect(out).toMatchObject({
      schema_version: 1,
      ss58: SS58,
      position_count: 0,
      total_stake_tao: 0,
      total_spot_mark_tao: 0,
      total_exit_value_tao: 0,
      positions: [],
    });
  });
});

describe("economicsByNetuidFromRows", () => {
  test("maps subnet economics rows by netuid", () => {
    const map = economicsByNetuidFromRows([
      {
        netuid: 1,
        alpha_price_tao: 1.2,
        tao_in_pool_tao: 100,
        alpha_in_pool: 50,
      },
    ]);
    expect(map.get(1)?.alpha_price_tao).toBe(1.2);
  });
});
