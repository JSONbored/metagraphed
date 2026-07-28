import { describe, expect, it } from "vitest";
import {
  buildStakeFlowSankeyData,
  computeRegistrationCostStats,
  MAX_SANKEY_SUBNETS,
  MAX_SANKEY_VALIDATORS,
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

describe("buildStakeFlowSankeyData", () => {
  it("builds a root node plus one node per shown subnet, linked with matching flow values", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 50)]);
    const vs = validators([]);
    const { nodes, links, shownNetuids } = buildStakeFlowSankeyData(flow, vs);
    expect(shownNetuids).toEqual([1, 2]);
    expect(nodes.find((n) => n.id === "root")?.value).toBe(150);
    expect(links.filter((l) => l.source === "root")).toHaveLength(2);
  });

  it("collapses subnets beyond maxSubnets into one 'Other subnets' node", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 50), subnetFlow(3, 10)]);
    const { nodes, links, shownNetuids } = buildStakeFlowSankeyData(
      flow,
      validators([]),
      2,
      MAX_SANKEY_VALIDATORS,
    );
    expect(shownNetuids).toEqual([1, 2]);
    const other = nodes.find((n) => n.id === "subnet:other");
    expect(other?.value).toBe(10);
    expect(links.some((l) => l.target === "subnet:other" && l.value === 10)).toBe(true);
  });

  it("omits subnets with zero flow entirely (nothing to show)", () => {
    const flow = stakeFlow([subnetFlow(1, 100), subnetFlow(2, 0)]);
    const { shownNetuids } = buildStakeFlowSankeyData(flow, validators([]));
    expect(shownNetuids).toEqual([1]);
  });

  it("adds a validator node per top validator, sized by stake in shown subnets only", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([
      validator("5AAA", [{ netuid: 1, stake_tao: 40 }]),
      validator("5BBB", [{ netuid: 1, stake_tao: 20 }]),
    ]);
    const { nodes, links } = buildStakeFlowSankeyData(flow, vs);
    const va = nodes.find((n) => n.id === "validator:5AAA");
    expect(va?.value).toBe(40);
    expect(links.some((l) => l.source === "subnet:1" && l.target === "validator:5AAA")).toBe(true);
  });

  it("ignores a validator's stake in a subnet that wasn't shown", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([
      validator("5AAA", [
        { netuid: 1, stake_tao: 40 },
        { netuid: 99, stake_tao: 999 },
      ]),
    ]);
    const { nodes } = buildStakeFlowSankeyData(flow, vs);
    expect(nodes.find((n) => n.id === "validator:5AAA")?.value).toBe(40);
  });

  it("collapses validators beyond maxValidators into 'Other validators', still split per subnet", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([
      validator("5AAA", [{ netuid: 1, stake_tao: 40 }]),
      validator("5BBB", [{ netuid: 1, stake_tao: 20 }]),
    ]);
    const { nodes, links } = buildStakeFlowSankeyData(flow, vs, MAX_SANKEY_SUBNETS, 1);
    expect(nodes.some((n) => n.id === "validator:other")).toBe(true);
    expect(
      links.some(
        (l) => l.source === "subnet:1" && l.target === "validator:other" && l.value === 20,
      ),
    ).toBe(true);
  });

  it("returns no validator nodes when no validator has stake in any shown subnet", () => {
    const flow = stakeFlow([subnetFlow(1, 100)]);
    const vs = validators([validator("5AAA", [{ netuid: 99, stake_tao: 40 }])]);
    const { nodes } = buildStakeFlowSankeyData(flow, vs);
    expect(nodes.some((n) => n.column === 2)).toBe(false);
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
