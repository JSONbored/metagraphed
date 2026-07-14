// Chain error decoding for stake/unstake/move transactions (#5240,
// native-staking epic #5229). Every entry below is verified against the live
// opentensor/subtensor source (read 2026-07-14), not carried over from the
// issue's own research unchecked -- that cross-check caught real drift worth
// recording:
//
//   - `InsufficientBalance`, `PriceLimitExceeded`, `ReservesTooLow`, and
//     `SubtokenDisabled` (note: lowercase "k" in "token" -- the issue's own
//     text had "SubTokenDisabled") are real errors, but they belong to the
//     SEPARATE `swap` pallet (pallets/swap/src/pallet/mod.rs), not
//     `subtensorModule` -- stake_utils.rs's `stake_into_subnet` calls into
//     the swap pallet's AMM internally, so a slippage/liquidity failure
//     during add_stake_limit/remove_stake_limit/swap_stake_limit surfaces as
//     a `swap.*` DispatchError, not a `subtensorModule.*` one. Decoding by
//     section matters: guessing the wrong pallet for a real error name would
//     silently fail to match here and fall through to the generic "unknown"
//     message.
//   - `BalanceLow` does not exist anywhere in either pallet's error enum --
//     dropped, not carried forward as a guess.
//   - The five numeric tx-pool codes the issue cited (1, 6, 7, 8, 25) were
//     independently verified against common/src/transaction_error.rs's own
//     `CustomTransactionError -> u8` mapping and are all correct; the rest of
//     that file's ~28 variants are included below too, filtered to the ones
//     relevant to staking/unstaking/moving (this epic's actual scope) --
//     IP/port/EVM-association/shielded-tx codes etc. are out of scope and
//     deliberately omitted, falling through to the generic "unknown" path
//     rather than a curated (and inevitably incomplete) attempt at full
//     pallet-wide coverage.
//
// Two genuinely different failure classes, decoded differently:
//   - A DispatchError (decodeModuleError) means the call executed on-chain
//     and failed inside the pallet logic -- the extrinsic IS in a block.
//   - A Custom(N) InvalidTransaction (decodeCustomTxError) means the
//     transaction pool rejected it before it ever reached a block -- no fee
//     was paid, no nonce was consumed.

export type TxErrorCategory =
  | "insufficient_balance"
  | "insufficient_liquidity"
  | "not_registered"
  | "not_authorized"
  | "rate_limited"
  | "invalid_argument"
  | "disabled"
  | "unknown";

export interface DecodedTxError {
  category: TxErrorCategory;
  message: string;
  /** For support/debugging -- "subtensorModule.AmountTooLow" or "Custom(8)". */
  source: string;
}

interface ErrorEntry {
  category: TxErrorCategory;
  message: string;
}

// Keyed by "<pallet>.<ErrorName>", using the runtime's own metadata-resolved
// names (from api.registry.findMetaError(dispatchError.asModule).section/
// .name) -- correct across runtime upgrades that renumber error indices, as
// long as the name itself is stable.
const MODULE_ERRORS: Record<string, ErrorEntry> = {
  // subtensorModule -- balance/stake-amount failures
  "subtensorModule.NotEnoughBalanceToStake": {
    category: "insufficient_balance",
    message: "Not enough balance in your wallet to stake this amount.",
  },
  "subtensorModule.NotEnoughStake": {
    category: "insufficient_balance",
    message: "Not enough stake on this hotkey for this action.",
  },
  "subtensorModule.NotEnoughStakeToWithdraw": {
    category: "insufficient_balance",
    message: "You're trying to unstake more than you have staked.",
  },
  "subtensorModule.StakeTooLowForRoot": {
    category: "insufficient_balance",
    message: "This stake amount is too low to join the root subnet.",
  },
  "subtensorModule.BalanceWithdrawalError": {
    category: "insufficient_balance",
    message: "Your wallet balance couldn't be withdrawn for this stake.",
  },
  "subtensorModule.AmountTooLow": {
    category: "invalid_argument",
    message: "This amount is below the network's minimum stake.",
  },
  // subtensorModule -- registration / identity
  "subtensorModule.HotKeyNotRegisteredInNetwork": {
    category: "not_registered",
    message: "This hotkey isn't registered on any subnet.",
  },
  "subtensorModule.HotKeyNotRegisteredInSubNet": {
    category: "not_registered",
    message: "This hotkey isn't registered on this subnet.",
  },
  "subtensorModule.HotKeyAccountNotExists": {
    category: "not_registered",
    message: "This hotkey doesn't exist on-chain.",
  },
  "subtensorModule.SubnetNotExists": {
    category: "invalid_argument",
    message: "This subnet doesn't exist.",
  },
  // subtensorModule -- authorization
  "subtensorModule.NonAssociatedColdKey": {
    category: "not_authorized",
    message: "Your wallet isn't the owner of this hotkey.",
  },
  "subtensorModule.BeneficiaryDoesNotOwnHotkey": {
    category: "not_authorized",
    message: "The destination account doesn't own this hotkey.",
  },
  // subtensorModule -- rate limits
  "subtensorModule.StakingRateLimitExceeded": {
    category: "rate_limited",
    message: "Too many staking transactions too quickly -- wait a moment and try again.",
  },
  "subtensorModule.DelegateTxRateLimitExceeded": {
    category: "rate_limited",
    message: "Too many delegate transactions too quickly -- wait a moment and try again.",
  },
  "subtensorModule.TxChildkeyTakeRateLimitExceeded": {
    category: "rate_limited",
    message: "Too many childkey-take changes too quickly -- wait a moment and try again.",
  },
  "subtensorModule.TxRateLimitExceeded": {
    category: "rate_limited",
    message: "Too many transactions too quickly -- wait a moment and try again.",
  },
  "subtensorModule.AddStakeBurnRateLimitExceeded": {
    category: "rate_limited",
    message: "Too many stake transactions too quickly -- wait a moment and try again.",
  },
  // subtensorModule -- other invalid-argument cases relevant to staking
  "subtensorModule.DelegateTakeTooHigh": {
    category: "invalid_argument",
    message: "This validator's take is set too high to accept.",
  },
  "subtensorModule.DelegateTakeTooLow": {
    category: "invalid_argument",
    message: "This validator's take is set too low to accept.",
  },
  "subtensorModule.SameNetuid": {
    category: "invalid_argument",
    message: "Origin and destination subnets must be different.",
  },
  "subtensorModule.InvalidChildkeyTake": {
    category: "invalid_argument",
    message: "Invalid childkey take value.",
  },
  "subtensorModule.TransferDisallowed": {
    category: "disabled",
    message: "Transfers are disabled on this subnet.",
  },
  // swap pallet -- the AMM stake_into_subnet/remove_stake routes through
  // internally; a slippage/liquidity failure here, not subtensorModule.
  "swap.InsufficientLiquidity": {
    category: "insufficient_liquidity",
    message: "Not enough liquidity in this subnet's pool for this trade size.",
  },
  "swap.SlippageTooHigh": {
    category: "insufficient_liquidity",
    message: "Price moved beyond your slippage tolerance -- try again or widen the tolerance.",
  },
  "swap.PriceLimitExceeded": {
    category: "insufficient_liquidity",
    message: "The trade would cross your price limit.",
  },
  "swap.ReservesTooLow": {
    category: "insufficient_liquidity",
    message: "This subnet's pool reserves are too low for this trade.",
  },
  "swap.InsufficientBalance": {
    category: "insufficient_balance",
    message: "Not enough balance for this swap.",
  },
  "swap.SubtokenDisabled": {
    category: "disabled",
    message: "This subnet's token isn't enabled for trading yet.",
  },
};

/** Decode a DispatchError's module section/name (via api.registry.findMetaError) into human copy. */
export function decodeModuleError(section: string, name: string): DecodedTxError {
  const source = `${section}.${name}`;
  const known = MODULE_ERRORS[source];
  if (known) return { ...known, source };
  return {
    category: "unknown",
    message: `Transaction failed (${source}).`,
    source,
  };
}

interface CustomErrorEntry extends ErrorEntry {
  name: string;
}

// From common/src/transaction_error.rs's CustomTransactionError -> u8 mapping
// (verified live against the exact numeric values, 2026-07-14). Filtered to
// staking/unstaking/moving-relevant codes; the rest of that enum (IP/port
// serving, EVM key association, shielded-tx parsing, commit-reveal) is out of
// this epic's scope and falls through to the generic "unknown" path.
const CUSTOM_TX_ERRORS: Record<number, CustomErrorEntry> = {
  1: {
    name: "StakeAmountTooLow",
    category: "invalid_argument",
    message: "This amount is below the network's minimum stake.",
  },
  2: {
    name: "BalanceTooLow",
    category: "insufficient_balance",
    message: "Not enough balance in your wallet for this transaction.",
  },
  3: {
    name: "SubnetNotExists",
    category: "invalid_argument",
    message: "This subnet doesn't exist.",
  },
  4: {
    name: "HotkeyAccountDoesntExist",
    category: "not_registered",
    message: "This hotkey doesn't exist on-chain.",
  },
  5: {
    name: "NotEnoughStakeToWithdraw",
    category: "insufficient_balance",
    message: "You're trying to unstake more than you have staked.",
  },
  6: {
    name: "RateLimitExceeded",
    category: "rate_limited",
    message: "Too many transactions too quickly -- wait a moment and try again.",
  },
  7: {
    name: "InsufficientLiquidity",
    category: "insufficient_liquidity",
    message: "Not enough liquidity in this subnet's pool for this trade size.",
  },
  8: {
    name: "SlippageTooHigh",
    category: "insufficient_liquidity",
    message: "Price moved beyond your slippage tolerance -- try again or widen the tolerance.",
  },
  9: {
    name: "TransferDisallowed",
    category: "disabled",
    message: "Transfers are disabled on this subnet.",
  },
  10: {
    name: "HotKeyNotRegisteredInNetwork",
    category: "not_registered",
    message: "This hotkey isn't registered on any subnet.",
  },
  25: {
    name: "NonAssociatedColdKey",
    category: "not_authorized",
    message: "Your wallet isn't the owner of this hotkey.",
  },
  26: {
    name: "DelegateTakeTooLow",
    category: "invalid_argument",
    message: "This validator's take is set too low to accept.",
  },
  27: {
    name: "DelegateTakeTooHigh",
    category: "invalid_argument",
    message: "This validator's take is set too high to accept.",
  },
};

/**
 * Decode a transaction-pool rejection (InvalidTransaction::Custom(N)) --
 * the transaction never reached a block, no fee was paid. Distinct from
 * decodeModuleError, which decodes an on-chain, in-block failure.
 */
export function decodeCustomTxError(code: number): DecodedTxError {
  const known = CUSTOM_TX_ERRORS[code];
  const source = known ? `Custom(${code}:${known.name})` : `Custom(${code})`;
  if (known) return { category: known.category, message: known.message, source };
  return {
    category: "unknown",
    message: `Transaction rejected before broadcast (code ${code}).`,
    source,
  };
}
