import { describe, expect, it } from "vitest";
import {
  buildStakeFlowRails,
  computeRegistrationCostStats,
  MAX_FLOW_SUBNETS,
  MAX_FLOW_VALIDATORS,
} from "./chain-analytics";
import type { ChainStakeFlow, GlobalValidators } from "./types";

function stakeFlow(subnets: ChainStakeFlow["subnets"]): ChainStakeFlow {
  return {
    schema_version: 1,
    window: "7d",
    observed_at: null,
    subnet_count: subnets.length,
    network: null,
    net_flow_distribution: null,
    subnets,
  };
}

function validators(entries: GlobalValidators["validators"]): GlobalValidators {
  return {
    sort: "total_stake",
    limit: 20,
    validator_count: entries.length,
    validators: entries,
  };
}

function subnetFlow(
  netuid: number,
  gross: number,
  direction: "gaining" | "losing" | "flat" = "gaining",
): ChainStakeFlow["subnets"][number] {
  return {
    netuid,
    total_staked_tao: gross,
    total_unstaked_tao: 0,
    net_flow_tao: gross,
    gross_flow_tao: gross,
    stake_events: 1,
    unstake_events: 0,
    direction,
  };
}

function validator(
  hotkey: string,
  subnets: { netuid: number; stake_tao: number }[],
): GlobalValidators["validators"][number] {
  return {
    hotkey,
    featured: false,
    coldkey: null,
    coldkey_identity: null,
    coldkey_count: 1,
    subnet_count: subnets.length,
    uid_count: subnets.length,
    take: null,
    total_stake_tao: subnets.reduce((s, m) => s + m.stake_tao, 0),
    root_stake_tao: 0,
    alpha_stake_tao: 0,
    total_emission_tao: 0,
    nominator_count: null,
    apy_estimate: null,
    apy_estimate_eligible_subnet_count: 0,
    avg_validator_trust: null,
    max_validator_trust: null,
    stake_dominance: null,
    latest_captured_at: null,
    latest_block_number: null,
    subnets: subnets.map((s) => ({ ...s, uid: 0, emission_tao: 0, validator_trust: null })),
  };
}

describe("buildStakeFlowRails", () => {
  it("ranks the shown subnets by gross flow, largest first, and carries their flow fields", () => {
    const flow = stakeFlow([subnetFlow(2, 50, "losing"), subnetFlow(1, 100)]);
    const { subnets, shownNetuids } = buildStakeFlowRails(flow, validators([]));
    expect(shownNetuids).toEqual([1, 2]);
    expect(subnets.map((s) => s.grossFlowTao)).toEqual([100, 50]);
    expect(subnets[1]).toMatchObject({ netuid: 2, direction: "losing", netFlowTao: 50 });
  });

  it("drops subnets beyond maxSubnets instead of collapsing them", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 50), subnetFlow(3, 10)]);
    const { subnets, shownNetuids } = buildStakeFlowRails(
      flow,
      validators([]),
      2,
      MAX_FLOW_VALIDATORS,
    );
    expect(shownNetuids).toEqual([1, 2]);
    expect(subnets).toHaveLength(2);
  });

  it("omits subnets with zero flow entirely (nothing to show)", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 0)]);
    const { shownNetuids } = buildStakeFlowRails(flow, validators([]));
    expect(shownNetuids).toEqual([1]);
  });

  it("ranks validators by stake in the shown subnets only, with the subnet count", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 80)]);
    const vs = validators([
      validator("5BBB", [{ netuid: 1, stake_tao: 20 }]),
      validator("5AAA", [
        { netuid: 1, stake_tao: 40 },
        { netuid: 2, stake_tao: 5 },
      ]),
    ]);
    const { validators: ranked } = buildStakeFlowRails(flow, vs);
    expect(ranked).toEqual([
      { hotkey: "5AAA", stakeInShownTao: 45, subnetCount: 2 },
      { hotkey: "5BBB", stakeInShownTao: 20, subnetCount: 1 },
    ]);
  });

  it("ignores a validator's stake in a subnet that wasn't shown", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([
      validator("5AAA", [
        { netuid: 1, stake_tao: 40 },
        { netuid: 99, stake_tao: 999 },
      ]),
    ]);
    const { validators: ranked } = buildStakeFlowRails(flow, vs);
    expect(ranked[0]).toEqual({ hotkey: "5AAA", stakeInShownTao: 40, subnetCount: 1 });
  });

  it("caps the validator rail at maxValidators", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([
      validator("5AAA", [{ netuid: 1, stake_tao: 40 }]),
      validator("5BBB", [{ netuid: 1, stake_tao: 20 }]),
    ]);
    const { validators: ranked } = buildStakeFlowRails(flow, vs, MAX_FLOW_SUBNETS, 1);
    expect(ranked.map((v) => v.hotkey)).toEqual(["5AAA"]);
  });

  it("returns no validators when none has stake in a shown subnet", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([validator("5AAA", [{ netuid: 99, stake_tao: 40 }])]);
    expect(buildStakeFlowRails(flow, vs).validators).toEqual([]);
  });
});

describe("computeRegistrationCostStats", () => {
  it("computes min/median/max across subnets with a known cost", () => {
    const stats = computeRegistrationCostStats([
      { registration_cost_tao: 5 },
      { registration_cost_tao: 1 },
      { registration_cost_tao: 3 },
    ]);
    expect(stats).toEqual({ count: 3, minTao: 1, medianTao: 3, maxTao: 5 });
  });

  it("averages the two middle values for an even count", () => {
    const stats = computeRegistrationCostStats([
      { registration_cost_tao: 10 },
      { registration_cost_tao: 20 },
    ]);
    expect(stats.medianTao).toBe(15);
  });

  it("ignores subnets with no cost value", () => {
    const stats = computeRegistrationCostStats([{ registration_cost_tao: 5 }, {}]);
    expect(stats.count).toBe(1);
  });

  it("returns all-null stats for an empty or all-missing input", () => {
    expect(computeRegistrationCostStats([])).toEqual({
      count: 0,
      minTao: null,
      medianTao: null,
      maxTao: null,
    });
  });
});
