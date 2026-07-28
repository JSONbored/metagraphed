import type { SankeyLink, SankeyNode } from "@jsonbored/ui-kit";
import type { ChainStakeFlow, GlobalValidators } from "./types";

// #8378: pure data-shaping for the Chain hub's Analytics tab. Kept separate
// from the components so the "other" aggregation and stat math (the parts
// most worth getting right) are unit-testable without rendering anything.

export const MAX_SANKEY_SUBNETS = 10;
export const MAX_SANKEY_VALIDATORS = 10;

const OTHER_SUBNETS_ID = "subnet:other";
const OTHER_VALIDATORS_ID = "validator:other";

function directionColor(direction: string): string {
  if (direction === "gaining") return "var(--health-ok)";
  if (direction === "losing") return "var(--health-down)";
  return "var(--ink-muted)";
}

export interface StakeFlowSankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** netuids actually drawn (excludes whatever collapsed into "Other subnets"). */
  shownNetuids: number[];
}

/**
 * Builds the sankey's three columns (root, subnets, validators) from two
 * separate data sources with two separate meanings: root<->subnet edges are
 * a real WINDOWED FLOW (stake-flow's gross_flow_tao), while subnet<->
 * validator edges are the CURRENT stake each top validator holds in that
 * subnet (the global validator leaderboard has no windowed-flow breakdown by
 * validator — no endpoint does). Both lenses share one diagram deliberately;
 * callers must label this in the UI rather than imply it's all one flow.
 */
export function buildStakeFlowSankeyData(
  stakeFlow: ChainStakeFlow,
  validators: GlobalValidators,
  maxSubnets: number = MAX_SANKEY_SUBNETS,
  maxValidators: number = MAX_SANKEY_VALIDATORS,
): StakeFlowSankeyData {
  const bySize = [...stakeFlow.subnets].sort((a, b) => b.gross_flow_tao - a.gross_flow_tao);
  const shown = bySize.slice(0, maxSubnets).filter((s) => s.gross_flow_tao > 0);
  const rest = bySize.slice(maxSubnets);
  const shownNetuids = shown.map((s) => s.netuid);
  const shownNetuidSet = new Set(shownNetuids);

  const nodes: SankeyNode[] = [
    {
      id: "root",
      label: "Root",
      value: shown.reduce((sum, s) => sum + s.gross_flow_tao, 0),
      column: 0,
    },
  ];
  const links: SankeyLink[] = [];

  for (const s of shown) {
    nodes.push({
      id: `subnet:${s.netuid}`,
      label: `SN${s.netuid}`,
      value: s.gross_flow_tao,
      column: 1,
      color: directionColor(s.direction),
    });
    links.push({
      source: "root",
      target: `subnet:${s.netuid}`,
      value: s.gross_flow_tao,
      color: directionColor(s.direction),
    });
  }
  const otherFlow = rest.reduce((sum, s) => sum + s.gross_flow_tao, 0);
  if (otherFlow > 0) {
    nodes.push({ id: OTHER_SUBNETS_ID, label: "Other subnets", value: otherFlow, column: 1 });
    links.push({ source: "root", target: OTHER_SUBNETS_ID, value: otherFlow });
  }

  // Validator column: current stake each validator holds across the shown
  // subnets only (not their network-wide total) — the edges below only
  // connect to subnets already drawn in column 1.
  const candidateValidators = validators.validators
    .map((v) => ({
      v,
      stakeInShown: v.subnets
        .filter((m) => shownNetuidSet.has(m.netuid))
        .reduce((sum, m) => sum + m.stake_tao, 0),
    }))
    .filter((x) => x.stakeInShown > 0)
    .sort((a, b) => b.stakeInShown - a.stakeInShown);

  const topValidators = candidateValidators.slice(0, maxValidators);
  const restValidators = candidateValidators.slice(maxValidators);
  const topHotkeys = new Set(topValidators.map((x) => x.v.hotkey));

  for (const { v, stakeInShown } of topValidators) {
    nodes.push({
      id: `validator:${v.hotkey}`,
      label: `${v.hotkey.slice(0, 6)}…${v.hotkey.slice(-4)}`,
      value: stakeInShown,
      column: 2,
    });
  }
  const otherValidatorStake = restValidators.reduce((sum, x) => sum + x.stakeInShown, 0);
  const hasOtherValidators = otherValidatorStake > 0;
  if (hasOtherValidators) {
    nodes.push({
      id: OTHER_VALIDATORS_ID,
      label: "Other validators",
      value: otherValidatorStake,
      column: 2,
    });
  }

  for (const s of shown) {
    for (const v of validators.validators) {
      const membership = v.subnets.find((m) => m.netuid === s.netuid);
      if (!membership || membership.stake_tao <= 0) continue;
      const target = topHotkeys.has(v.hotkey) ? `validator:${v.hotkey}` : null;
      if (target) {
        links.push({ source: `subnet:${s.netuid}`, target, value: membership.stake_tao });
      }
    }
    if (hasOtherValidators) {
      const otherStakeForSubnet = restValidators.reduce((sum, x) => {
        const m = x.v.subnets.find((mem) => mem.netuid === s.netuid);
        return sum + (m?.stake_tao ?? 0);
      }, 0);
      if (otherStakeForSubnet > 0) {
        links.push({
          source: `subnet:${s.netuid}`,
          target: OTHER_VALIDATORS_ID,
          value: otherStakeForSubnet,
        });
      }
    }
  }

  return { nodes, links, shownNetuids };
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
