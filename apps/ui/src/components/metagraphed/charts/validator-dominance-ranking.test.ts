import { describe, expect, it } from "vitest";

import {
  VALIDATOR_DOMINANCE_TOP_N,
  buildValidatorDominanceChartData,
  type ValidatorDominanceSource,
} from "./validator-dominance-ranking";

function validator(overrides: Partial<ValidatorDominanceSource>): ValidatorDominanceSource {
  return {
    hotkey: "5AAAA1",
    coldkey_identity: null,
    total_stake_tao: 0,
    stake_dominance: null,
    subnet_count: 0,
    ...overrides,
  };
}

describe("buildValidatorDominanceChartData", () => {
  it("returns an empty list for an empty leaderboard", () => {
    expect(buildValidatorDominanceChartData([])).toEqual([]);
  });

  it("returns an empty list when no row has a known positive stake share", () => {
    const out = buildValidatorDominanceChartData([
      validator({ hotkey: "5Null", stake_dominance: null }),
      validator({ hotkey: "5Zero", stake_dominance: 0 }),
      validator({ hotkey: "5Neg", stake_dominance: -0.01 }),
    ]);
    expect(out).toEqual([]);
  });

  it("shapes a single row, using shortHash as the label when no identity name is set", () => {
    const out = buildValidatorDominanceChartData([
      validator({
        hotkey: "5F1prathntNaN1Xtu9nRe1TwSBYQaBhVQPdpF4Xj9",
        total_stake_tao: 1234.5,
        stake_dominance: 0.1234,
        subnet_count: 7,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hotkey: "5F1prathntNaN1Xtu9nRe1TwSBYQaBhVQPdpF4Xj9",
      share: 0.1234,
      value: 12.34,
      stakeTao: 1234.5,
      subnetCount: 7,
    });
    // shortHash keeps 6 chars on each side, joined with an ellipsis.
    expect(out[0].label).toBe("5F1pra…pF4Xj9");
  });

  it("prefers the coldkey identity name over shortHash when present", () => {
    const out = buildValidatorDominanceChartData([
      validator({
        hotkey: "5Hotkey",
        coldkey_identity: { name: "  TensorOps  " },
        stake_dominance: 0.05,
      }),
    ]);
    expect(out[0].label).toBe("TensorOps");
  });

  it("falls back to shortHash when the identity name is blank", () => {
    const out = buildValidatorDominanceChartData([
      validator({
        hotkey: "5Short",
        coldkey_identity: { name: "   " },
        stake_dominance: 0.05,
      }),
    ]);
    expect(out[0].label).toBe("5Short");
  });

  it("sorts multiple rows by stake_dominance descending", () => {
    const out = buildValidatorDominanceChartData([
      validator({ hotkey: "5Low", stake_dominance: 0.01 }),
      validator({ hotkey: "5High", stake_dominance: 0.4 }),
      validator({ hotkey: "5Mid", stake_dominance: 0.1 }),
    ]);
    expect(out.map((r) => r.hotkey)).toEqual(["5High", "5Mid", "5Low"]);
  });

  it("breaks a stake_dominance tie by total_stake_tao descending", () => {
    const out = buildValidatorDominanceChartData([
      validator({ hotkey: "5Small", stake_dominance: 0.1, total_stake_tao: 100 }),
      validator({ hotkey: "5Big", stake_dominance: 0.1, total_stake_tao: 500 }),
    ]);
    expect(out.map((r) => r.hotkey)).toEqual(["5Big", "5Small"]);
  });

  it("breaks a full stake_dominance + total_stake_tao tie by hotkey ascending", () => {
    const out = buildValidatorDominanceChartData([
      validator({ hotkey: "5Zzz", stake_dominance: 0.1, total_stake_tao: 100 }),
      validator({ hotkey: "5Aaa", stake_dominance: 0.1, total_stake_tao: 100 }),
    ]);
    expect(out.map((r) => r.hotkey)).toEqual(["5Aaa", "5Zzz"]);
  });

  it("exposes the default top-N limit and applies it when no limit is passed", () => {
    expect(VALIDATOR_DOMINANCE_TOP_N).toBe(10);
    const many = Array.from({ length: VALIDATOR_DOMINANCE_TOP_N + 5 }, (_, i) =>
      validator({ hotkey: `5Row${i}`, stake_dominance: 1 - i * 0.01 }),
    );
    expect(buildValidatorDominanceChartData(many)).toHaveLength(VALIDATOR_DOMINANCE_TOP_N);
  });

  it("respects a custom limit", () => {
    const rows = [
      validator({ hotkey: "5A", stake_dominance: 0.3 }),
      validator({ hotkey: "5B", stake_dominance: 0.2 }),
      validator({ hotkey: "5C", stake_dominance: 0.1 }),
    ];
    expect(buildValidatorDominanceChartData(rows, 2)).toHaveLength(2);
  });

  it("clamps a zero or negative limit to an empty list", () => {
    const rows = [validator({ hotkey: "5A", stake_dominance: 0.3 })];
    expect(buildValidatorDominanceChartData(rows, 0)).toEqual([]);
    expect(buildValidatorDominanceChartData(rows, -5)).toEqual([]);
  });
});
