import type { ChainStakeFlow, GlobalValidators } from "./types";

// #8378: pure data-shaping for the Chain hub's Analytics tab. Kept separate
// from the components so the selection and stat math (the parts most worth
// getting right) are unit-testable without rendering anything.

export const MAX_FLOW_SUBNETS = 10;
export const MAX_FLOW_VALIDATORS = 10;

export interface StakeFlowSubnetRow {
  netuid: number;
  grossFlowTao: number;
  netFlowTao: number;
  stakedTao: number;
  unstakedTao: number;
  direction: string;
}

export interface StakeFlowValidatorRow {
  hotkey: string;
  /** Current stake across the shown subnets only, not the validator's network-wide total. */
  stakeInShownTao: number;
  /** How many of the shown subnets this validator holds stake in. */
  subnetCount: number;
}

export interface StakeFlowRails {
  /** Top subnets by gross windowed flow, largest first; zero-flow subnets are dropped. */
  subnets: StakeFlowSubnetRow[];
  /** Top validators by current stake in those subnets, largest first. */
  validators: StakeFlowValidatorRow[];
  /** netuids actually ranked. */
  shownNetuids: number[];
}

/**
 * Builds the two stake-flow rails from two separate data sources with two
 * separate meanings: the subnet rail is a real WINDOWED FLOW (stake-flow's
 * gross_flow_tao), while the validator rail is the CURRENT stake each top
 * validator holds in those subnets (the global validator leaderboard has no
 * windowed-flow breakdown by validator — no endpoint does). Callers must
 * label this in the UI rather than imply both rails are one kind of number.
 */
export function buildStakeFlowRails(
  stakeFlow: ChainStakeFlow,
  validators: GlobalValidators,
  maxSubnets: number = MAX_FLOW_SUBNETS,
  maxValidators: number = MAX_FLOW_VALIDATORS,
): StakeFlowRails {
  const shown = [...stakeFlow.subnets]
    .sort((a, b) => b.gross_flow_tao - a.gross_flow_tao)
    .slice(0, maxSubnets)
    .filter((s) => s.gross_flow_tao > 0);
  const shownNetuids = shown.map((s) => s.netuid);
  const shownNetuidSet = new Set(shownNetuids);

  const subnets: StakeFlowSubnetRow[] = shown.map((s) => ({
    netuid: s.netuid,
    grossFlowTao: s.gross_flow_tao,
    netFlowTao: s.net_flow_tao,
    stakedTao: s.total_staked_tao,
    unstakedTao: s.total_unstaked_tao,
    direction: s.direction,
  }));

  const ranked: StakeFlowValidatorRow[] = validators.validators
    .map((v) => {
      const inShown = v.subnets.filter((m) => shownNetuidSet.has(m.netuid) && m.stake_tao > 0);
      return {
        hotkey: v.hotkey,
        stakeInShownTao: inShown.reduce((sum, m) => sum + m.stake_tao, 0),
        subnetCount: inShown.length,
      };
    })
    .filter((x) => x.stakeInShownTao > 0)
    .sort((a, b) => b.stakeInShownTao - a.stakeInShownTao)
    .slice(0, maxValidators);

  return { subnets, validators: ranked, shownNetuids };
}

export interface RegistrationCostStats {
  count: number;
  minTao: number | null;
  medianTao: number | null;
  maxTao: number | null;
}

/** Min/median/max registration cost across subnets with a known value. */
export function computeRegistrationCostStats(
  subnets: readonly { registration_cost_tao?: number }[],
): RegistrationCostStats {
  const costs = subnets
    .map((s) => s.registration_cost_tao)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c))
    .sort((a, b) => a - b);
  if (costs.length === 0) return { count: 0, minTao: null, medianTao: null, maxTao: null };
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 === 0 ? (costs[mid - 1]! + costs[mid]!) / 2 : costs[mid]!;
  return { count: costs.length, minTao: costs[0]!, medianTao: median, maxTao: costs.at(-1)! };
}
