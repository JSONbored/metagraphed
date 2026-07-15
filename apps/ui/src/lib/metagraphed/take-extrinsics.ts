// Validator take (commission) self-service (#5246, native-staking epic
// #5229). Correctness-critical for the same reason stake-extrinsics.ts is:
// a wrong parameter or a unit mixup here directly affects a validator's
// revenue, not a cosmetic display value.
//
// Every claim below is verified against the live subtensor pallet source
// (opentensor/subtensor, pallets/subtensor/src/macros/dispatches.rs +
// staking/increase_take.rs + staking/decrease_take.rs + utils/rate_limiting.rs,
// read 2026-07-15) AND empirically confirmed against the live mainnet RPC:
//
//   - increase_take (call_index 66) / decrease_take (call_index 65) both take
//     exactly (hotkey: AccountId, take: PerU16) -- no netuid. The dispatch
//     doc comments both still mention "for subnet ID" / a `netuid` argument
//     and cite a `NotRegistered` error -- both stale (take is network-wide,
//     not subnet-scoped, in the actual function signature; `NotRegistered`
//     isn't a real variant in the error enum at all). Built from the real
//     `pub fn` signatures, not the doc comments.
//   - PerU16 is parts-per-65535, per the doc comment's own worked example:
//     1% = [0.01 * 65535] = [655.35] = 655.
//   - decrease_take has NO rate-limit check at all (confirmed: no call to
//     exceeds_tx_delegate_take_rate_limit anywhere in do_decrease_take) --
//     "decreases instant/unlimited" is accurate. But it DOES still write the
//     shared last-tx-block-delegate-take timestamp as a side effect, so a
//     decrease still starts the cooldown clock for a SUBSEQUENT increase.
//   - do_decrease_take also enforces `take >= MinDelegateTake::<T>::get()` --
//     a floor bound the issue that spawned this file didn't mention. Both
//     MaxDelegateTake and MinDelegateTake are live StorageValues (not
//     `#[pallet::constant]`s), so -- same rule as getMinStake in
//     chain-connection.ts -- always query live, never hardcode. Confirmed
//     live against mainnet: maxDelegateTake=11796 (=18.0000%, matching the
//     doc comment's "18%"), minDelegateTake=0 (currently no floor, but this
//     is mutable storage, not a guarantee).
//   - txDelegateTakeRateLimit is also a live StorageValue, confirmed live
//     against mainnet at 216000 blocks (=30 days at Bittensor's ~12s block
//     time) -- matches the issue's own "~30 days" claim exactly.
//   - The remaining-cooldown check itself
//     (exceeds_tx_delegate_take_rate_limit) is: blocked when
//     `rate_limit != 0 && prev_tx_block != 0 && (current_block -
//     prev_tx_block) <= rate_limit` -- mirrored exactly by
//     isDelegateTakeRateLimited below, including the two "never blocked"
//     special cases (a disabled rate limit, or a hotkey that has never
//     changed its take before).

import { isValidSs58 } from "./accounts";

/** PerU16's denominator -- take is expressed as parts-per-this-many. */
export const TAKE_PARTS_PER_WHOLE = 65_535;

/** Rounds to the nearest representable PerU16 value, clamped to [0, 65535]. Throws on non-finite/negative/>100 input rather than silently clamping a typo into something valid. */
export function percentToTakeParts(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`Invalid take percentage: ${pct}`);
  }
  return Math.round((pct / 100) * TAKE_PARTS_PER_WHOLE);
}

/** The inverse of percentToTakeParts, for display. */
export function takePartsToPercent(parts: number): number {
  return (parts / TAKE_PARTS_PER_WHOLE) * 100;
}

export type TakeDirection = "increase" | "decrease";

export interface IncreaseTakeParams {
  call: "increase_take";
  hotkey: string;
  take: number;
}

export interface DecreaseTakeParams {
  call: "decrease_take";
  hotkey: string;
  take: number;
}

/** Params for subtensorModule.increaseTake(hotkey, take). Pure parameter packaging -- pallet-side bounds/direction/rate-limit checks are validateTakeInputs' job, not this function's; the chain re-validates all of this regardless. */
export function buildIncreaseTakeParams(input: {
  hotkey: string;
  take: number;
}): IncreaseTakeParams {
  return { call: "increase_take", ...input };
}

/** Params for subtensorModule.decreaseTake(hotkey, take). */
export function buildDecreaseTakeParams(input: {
  hotkey: string;
  take: number;
}): DecreaseTakeParams {
  return { call: "decrease_take", ...input };
}

/**
 * Mirrors exceeds_tx_delegate_take_rate_limit exactly, including its two
 * "never blocked" special cases -- a disabled rate limit (rateLimitBlocks
 * === 0) or a hotkey whose take has never been changed before
 * (lastTxBlock === 0, the ValueQuery default for a never-written storage
 * map entry).
 */
export function isDelegateTakeRateLimited(
  lastTxBlock: number,
  currentBlock: number,
  rateLimitBlocks: number,
): boolean {
  if (rateLimitBlocks === 0 || lastTxBlock === 0) return false;
  return Math.max(currentBlock - lastTxBlock, 0) <= rateLimitBlocks;
}

/** Blocks remaining until an increase_take would clear the cooldown, or 0 if not currently limited. */
export function delegateTakeCooldownRemainingBlocks(
  lastTxBlock: number,
  currentBlock: number,
  rateLimitBlocks: number,
): number {
  if (!isDelegateTakeRateLimited(lastTxBlock, currentBlock, rateLimitBlocks)) return 0;
  return rateLimitBlocks - Math.max(currentBlock - lastTxBlock, 0);
}

/** Display-only estimate (Bittensor's well-known ~12s block time) -- never used for the actual rate-limit gating decision, which always compares raw block counts from a live query. */
const APPROX_SECONDS_PER_BLOCK = 12;

/** A human-readable duration for a remaining-cooldown block count, e.g. "about 30 days". */
export function formatCooldownDuration(remainingBlocks: number): string {
  if (remainingBlocks <= 0) return "no cooldown";
  const seconds = remainingBlocks * APPROX_SECONDS_PER_BLOCK;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  if (days >= 1) return `about ${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"}`;
  if (hours >= 1) return `about ${Math.ceil(hours)} hour${Math.ceil(hours) === 1 ? "" : "s"}`;
  if (minutes >= 1)
    return `about ${Math.ceil(minutes)} minute${Math.ceil(minutes) === 1 ? "" : "s"}`;
  return "less than a minute";
}

export type TakeValidationIssue =
  | { code: "invalid_hotkey" }
  | { code: "not_owner" }
  | { code: "below_min_take"; minTakeParts: number }
  | { code: "above_max_take"; maxTakeParts: number }
  | { code: "not_strictly_increasing" }
  | { code: "not_strictly_decreasing" }
  | { code: "rate_limited"; remainingBlocks: number };

export interface ValidateTakeInputsParams {
  hotkey: string;
  /** Whether the connected wallet is this hotkey's owning coldkey -- the pallet's own NonAssociatedColdKey check, mirrored client-side pre-signature. */
  isOwner: boolean;
  direction: TakeDirection;
  takeParts: number;
  currentTakeParts: number;
  minTakeParts: number;
  maxTakeParts: number;
  /** Only meaningful for "increase" -- decrease_take has no rate limit at all. */
  cooldownRemainingBlocks: number;
}

/**
 * Client-side pre-flight checks run before any signature prompt fires,
 * mirroring stake-extrinsics.ts's validateStakeInputs. Returns every issue
 * found, not just the first. This is a UX convenience, not the safety
 * boundary -- the chain re-validates all of this itself and remains
 * authoritative.
 */
export function validateTakeInputs({
  hotkey,
  isOwner,
  direction,
  takeParts,
  currentTakeParts,
  minTakeParts,
  maxTakeParts,
  cooldownRemainingBlocks,
}: ValidateTakeInputsParams): TakeValidationIssue[] {
  const issues: TakeValidationIssue[] = [];
  if (!isValidSs58(hotkey)) issues.push({ code: "invalid_hotkey" });
  if (!isOwner) issues.push({ code: "not_owner" });
  if (takeParts < minTakeParts) issues.push({ code: "below_min_take", minTakeParts });
  if (takeParts > maxTakeParts) issues.push({ code: "above_max_take", maxTakeParts });
  if (direction === "increase") {
    if (takeParts <= currentTakeParts) issues.push({ code: "not_strictly_increasing" });
    // decrease_take has no rate limit at all -- see this file's header comment.
    if (cooldownRemainingBlocks > 0) {
      issues.push({ code: "rate_limited", remainingBlocks: cooldownRemainingBlocks });
    }
  } else {
    if (takeParts >= currentTakeParts) issues.push({ code: "not_strictly_decreasing" });
  }
  return issues;
}

/** Human-readable copy for a validation issue, for the pre-sign confirmation screen. */
export function describeTakeValidationIssue(issue: TakeValidationIssue): string {
  switch (issue.code) {
    case "invalid_hotkey":
      return "Not a valid hotkey address.";
    case "not_owner":
      return "Your connected wallet doesn't own this hotkey.";
    case "below_min_take":
      return `Take can't go below ${takePartsToPercent(issue.minTakeParts).toFixed(2)}%.`;
    case "above_max_take":
      return `Take can't exceed ${takePartsToPercent(issue.maxTakeParts).toFixed(2)}%.`;
    case "not_strictly_increasing":
      return "The new take must be strictly higher than the current take.";
    case "not_strictly_decreasing":
      return "The new take must be strictly lower than the current take.";
    case "rate_limited":
      return `Take was changed too recently -- try again in ${formatCooldownDuration(issue.remainingBlocks)}.`;
  }
}
