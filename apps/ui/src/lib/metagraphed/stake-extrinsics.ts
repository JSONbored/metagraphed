// Client-side stake/unstake/move extrinsic construction (#5237, native-staking
// epic #5229). Correctness-critical: a wrong parameter order or a unit mixup
// here is a real fund-safety bug, not a cosmetic one.
//
// Every call shape below is verified against the live subtensor pallet source
// (opentensor/subtensor, pallets/subtensor/src/macros/dispatches.rs, read
// 2026-07-14) -- call name, parameter order, and parameter type for each of
// add_stake_limit (call_index 88), remove_stake_limit (89), swap_stake_limit
// (90), and move_stake (85).
//
// Per docs/adr/0018-native-staking-architecture.md §3, this module only ever
// builds the `_limit` variants -- add_stake_limit/remove_stake_limit/
// swap_stake_limit -- never the plain, unprotected add_stake/remove_stake.
//
// move_stake is a documented exception, resolved during this epic's own
// review (not the ADR, which didn't separately enumerate it): move_stake has
// NO `_limit` counterpart anywhere in the pallet, and its cross-subnet case
// runs through the same unprotected AMM-swap path as swap_stake (confirmed by
// reading staking/move_stake.rs's `do_move_stake`, which calls the same
// `transition_stake_internal` swap_stake uses, with the price-limit argument
// hardcoded to `None`). A same-subnet move_stake (origin_netuid ==
// destination_netuid) is genuinely riskless -- no AMM swap occurs, it's a
// pure hotkey reassignment -- and is supported directly. A cross-subnet move
// is NOT exposed as a single call here; buildMoveStakeParams throws with a
// pointer to compose it from buildRemoveStakeLimitParams (origin) +
// buildAddStakeLimitParams (destination) instead -- two slippage-protected
// legs achieving the same end state, rather than one unprotected atomic call.

import { taoToRao, raoToTao, type Rao, type RawAlpha } from "./units";
import { isValidSs58 } from "./accounts";

export type StakeDirection = "add" | "remove";

export interface ComputeLimitPriceInput {
  /** Current spot price in TAO per one alpha (e.g. from the stake-quote endpoint's spot_price_tao; 1.0 for root, which has no AMM). */
  spotPriceTao: number;
  /** Tolerance band as a percent, e.g. 5 for 5%. Default per ADR 0018 §3 is 5. */
  tolerancePct: number;
  direction: StakeDirection;
}

/**
 * Compute the on-chain `limit_price` (rao per one alpha) from a spot price and
 * a tolerance band. Adding stake pays alpha's price in TAO, so the limit is
 * the spot price PLUS tolerance (willing to pay up to this much); removing
 * stake receives TAO for alpha, so the limit is the spot price MINUS
 * tolerance (willing to accept down to this much). Getting this direction
 * backwards would silently remove the protection the caller thinks they have.
 */
export function computeLimitPrice({
  spotPriceTao,
  tolerancePct,
  direction,
}: ComputeLimitPriceInput): Rao {
  if (!Number.isFinite(spotPriceTao) || spotPriceTao <= 0) {
    throw new Error(`Invalid spot price: ${spotPriceTao}`);
  }
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
    throw new Error(`Invalid tolerance: ${tolerancePct}`);
  }
  const factor = direction === "add" ? 1 + tolerancePct / 100 : 1 - tolerancePct / 100;
  if (factor <= 0) {
    throw new Error(
      `Tolerance too large: ${tolerancePct}% on the "remove" side would produce a non-positive limit price`,
    );
  }
  // Round through a fixed 9-decimal string, not a raw float->rao multiply --
  // taoToRao's BigInt parse is the single point where a decimal price becomes
  // an exact on-chain integer; doing the multiply here in float and rounding
  // separately would risk float error at the last, most consequential step.
  const limitPriceTao = (spotPriceTao * factor).toFixed(9);
  return taoToRao(limitPriceTao);
}

export interface AddStakeLimitParams {
  call: "add_stake_limit";
  hotkey: string;
  netuid: number;
  amountStaked: Rao;
  limitPrice: Rao;
  allowPartial: boolean;
}

/** Params for subtensorModule.addStakeLimit(hotkey, netuid, amountStaked, limitPrice, allowPartial). */
export function buildAddStakeLimitParams(input: {
  hotkey: string;
  netuid: number;
  amountStaked: Rao;
  limitPrice: Rao;
  allowPartial: boolean;
}): AddStakeLimitParams {
  requirePositive(input.amountStaked, "amountStaked");
  requirePositive(input.limitPrice, "limitPrice");
  return { call: "add_stake_limit", ...input };
}

export interface RemoveStakeLimitParams {
  call: "remove_stake_limit";
  hotkey: string;
  netuid: number;
  amountUnstaked: RawAlpha;
  limitPrice: Rao;
  allowPartial: boolean;
}

/** Params for subtensorModule.removeStakeLimit(hotkey, netuid, amountUnstaked, limitPrice, allowPartial). Note amountUnstaked is alpha, NOT tao -- unlike add_stake_limit's amountStaked. */
export function buildRemoveStakeLimitParams(input: {
  hotkey: string;
  netuid: number;
  amountUnstaked: RawAlpha;
  limitPrice: Rao;
  allowPartial: boolean;
}): RemoveStakeLimitParams {
  requirePositive(input.amountUnstaked, "amountUnstaked");
  requirePositive(input.limitPrice, "limitPrice");
  return { call: "remove_stake_limit", ...input };
}

export interface SwapStakeLimitParams {
  call: "swap_stake_limit";
  hotkey: string;
  originNetuid: number;
  destinationNetuid: number;
  alphaAmount: RawAlpha;
  limitPrice: Rao;
  allowPartial: boolean;
}

/** Params for subtensorModule.swapStakeLimit(hotkey, originNetuid, destinationNetuid, alphaAmount, limitPrice, allowPartial). */
export function buildSwapStakeLimitParams(input: {
  hotkey: string;
  originNetuid: number;
  destinationNetuid: number;
  alphaAmount: RawAlpha;
  limitPrice: Rao;
  allowPartial: boolean;
}): SwapStakeLimitParams {
  if (input.originNetuid === input.destinationNetuid) {
    throw new Error("swap_stake_limit requires distinct origin/destination netuids");
  }
  requirePositive(input.alphaAmount, "alphaAmount");
  requirePositive(input.limitPrice, "limitPrice");
  return { call: "swap_stake_limit", ...input };
}

export interface MoveStakeParams {
  call: "move_stake";
  originHotkey: string;
  destinationHotkey: string;
  netuid: number;
  alphaAmount: RawAlpha;
}

/**
 * Params for subtensorModule.moveStake(originHotkey, destinationHotkey,
 * originNetuid, destinationNetuid, alphaAmount) -- same-subnet only (see
 * module header). Throws for a cross-subnet request; compose
 * buildRemoveStakeLimitParams + buildAddStakeLimitParams instead.
 */
export function buildMoveStakeParams(input: {
  originHotkey: string;
  destinationHotkey: string;
  netuid: number;
  alphaAmount: RawAlpha;
}): MoveStakeParams {
  requirePositive(input.alphaAmount, "alphaAmount");
  return { call: "move_stake", ...input };
}

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Error(`${label} must be a positive amount, got ${value}`);
  }
}

export type StakeValidationIssue =
  | { code: "invalid_hotkey" }
  | { code: "invalid_netuid" }
  | { code: "amount_not_positive" }
  | { code: "below_min_stake"; minStakeRao: Rao }
  | { code: "insufficient_balance"; availableRao: Rao };

export interface ValidateStakeInputsParams {
  hotkey: string;
  /** The netuid this amount is denominated against (for the min-stake floor check). */
  netuid: number;
  /** The known, currently-active subnets (from the app's existing subnet list -- this library never fetches its own copy). */
  knownNetuids: readonly number[];
  /** The amount being staked/unstaked, already converted to rao (add_stake_limit) or its TAO-equivalent estimate (remove_stake_limit -- the pallet's own floor check compares the TAO side of the trade either way). */
  amountRao: Rao;
  /** InitialMinStake, read live via chain-connection.ts's getMinStake() -- never hardcoded (the pallet exposes it as a real `#[pallet::constant]`, so there's no reason to guess a value that could drift). */
  minStakeRao: Rao;
  /** The coldkey's spendable balance in rao, only required (and only checked) for an add_stake (paying TAO out of the free balance) -- omit for remove_stake/move_stake, which draw from existing stake, not the free balance. */
  availableBalanceRao?: Rao;
}

/**
 * Client-side pre-flight checks run before any signature prompt fires (issue
 * #5237's "self-consistency" + "min-stake floor" + "sufficient balance"
 * deliverables). Returns every issue found, not just the first -- the caller
 * decides how to surface them. This is a UX convenience, not the safety
 * boundary: the chain re-validates all of this itself (AmountTooLow,
 * NotEnoughBalanceToStake, SubnetNotExists, ...) and remains authoritative.
 */
export function validateStakeInputs({
  hotkey,
  netuid,
  knownNetuids,
  amountRao,
  minStakeRao,
  availableBalanceRao,
}: ValidateStakeInputsParams): StakeValidationIssue[] {
  const issues: StakeValidationIssue[] = [];
  if (!isValidSs58(hotkey)) issues.push({ code: "invalid_hotkey" });
  if (!knownNetuids.includes(netuid)) issues.push({ code: "invalid_netuid" });
  if (amountRao <= 0n) {
    issues.push({ code: "amount_not_positive" });
  } else {
    if (amountRao < minStakeRao) issues.push({ code: "below_min_stake", minStakeRao });
    if (availableBalanceRao !== undefined && amountRao > availableBalanceRao) {
      issues.push({ code: "insufficient_balance", availableRao: availableBalanceRao });
    }
  }
  return issues;
}

/** Human-readable copy for a validation issue, for the pre-sign confirmation screen (#5239). */
export function describeStakeValidationIssue(issue: StakeValidationIssue): string {
  switch (issue.code) {
    case "invalid_hotkey":
      return "Not a valid hotkey address.";
    case "invalid_netuid":
      return "This subnet isn't currently active.";
    case "amount_not_positive":
      return "Enter an amount greater than zero.";
    case "below_min_stake":
      return `Amount is below the network minimum of ${raoToTao(issue.minStakeRao)} TAO.`;
    case "insufficient_balance":
      return `Amount exceeds your available balance of ${raoToTao(issue.availableRao)} TAO.`;
  }
}
