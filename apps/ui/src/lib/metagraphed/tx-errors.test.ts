import { describe, it, expect } from "vitest";
import { decodeModuleError, decodeCustomTxError, type TxErrorCategory } from "./tx-errors";

// Every module error this file knows about, with its expected category --
// verified against the live pallet source (see tx-errors.ts's header). One
// assertion per entry catches a typo in either the key or the category that
// a single "does it decode at all" smoke test would miss.
const EXPECTED_MODULE_ERRORS: Array<[section: string, name: string, category: TxErrorCategory]> = [
  ["subtensorModule", "NotEnoughBalanceToStake", "insufficient_balance"],
  ["subtensorModule", "NotEnoughStake", "insufficient_balance"],
  ["subtensorModule", "NotEnoughStakeToWithdraw", "insufficient_balance"],
  ["subtensorModule", "StakeTooLowForRoot", "insufficient_balance"],
  ["subtensorModule", "BalanceWithdrawalError", "insufficient_balance"],
  ["subtensorModule", "AmountTooLow", "invalid_argument"],
  ["subtensorModule", "HotKeyNotRegisteredInNetwork", "not_registered"],
  ["subtensorModule", "HotKeyNotRegisteredInSubNet", "not_registered"],
  ["subtensorModule", "HotKeyAccountNotExists", "not_registered"],
  ["subtensorModule", "SubnetNotExists", "invalid_argument"],
  ["subtensorModule", "NonAssociatedColdKey", "not_authorized"],
  ["subtensorModule", "BeneficiaryDoesNotOwnHotkey", "not_authorized"],
  ["subtensorModule", "StakingRateLimitExceeded", "rate_limited"],
  ["subtensorModule", "DelegateTxRateLimitExceeded", "rate_limited"],
  ["subtensorModule", "TxChildkeyTakeRateLimitExceeded", "rate_limited"],
  ["subtensorModule", "TxRateLimitExceeded", "rate_limited"],
  ["subtensorModule", "AddStakeBurnRateLimitExceeded", "rate_limited"],
  ["subtensorModule", "DelegateTakeTooHigh", "invalid_argument"],
  ["subtensorModule", "DelegateTakeTooLow", "invalid_argument"],
  ["subtensorModule", "SameNetuid", "invalid_argument"],
  ["subtensorModule", "InvalidChildkeyTake", "invalid_argument"],
  ["subtensorModule", "TransferDisallowed", "disabled"],
  ["swap", "InsufficientLiquidity", "insufficient_liquidity"],
  ["swap", "PriceLimitExceeded", "insufficient_liquidity"],
  ["swap", "ReservesTooLow", "insufficient_liquidity"],
  ["swap", "InsufficientBalance", "insufficient_balance"],
  ["swap", "SubtokenDisabled", "disabled"],
];

describe("decodeModuleError", () => {
  it.each(EXPECTED_MODULE_ERRORS)("decodes %s.%s as %s", (section, name, category) => {
    const decoded = decodeModuleError(section, name);
    expect(decoded.category).toBe(category);
    expect(decoded.source).toBe(`${section}.${name}`);
    expect(decoded.message.length).toBeGreaterThan(0);
  });

  it("distinguishes the same error name in different pallets (swap.InsufficientBalance vs no subtensorModule.InsufficientBalance)", () => {
    // subtensorModule has NO error literally named InsufficientBalance -- only
    // swap does (verified against source; a naive "match by name only" decoder
    // would get this wrong for a chain that has both).
    expect(decodeModuleError("swap", "InsufficientBalance").category).toBe("insufficient_balance");
    expect(decodeModuleError("subtensorModule", "InsufficientBalance").category).toBe("unknown");
  });

  it("falls back to a generic message for an unrecognized module error, never throwing", () => {
    const decoded = decodeModuleError("someOtherPallet", "SomeWeirdError");
    expect(decoded.category).toBe("unknown");
    expect(decoded.source).toBe("someOtherPallet.SomeWeirdError");
    expect(decoded.message).toContain("someOtherPallet.SomeWeirdError");
  });

  it("falls through to unknown for swap.SlippageTooHigh -- it isn't a real swap-pallet Error<T> variant", () => {
    // Regression: #5251's re-verification pass found this key was never a
    // real variant (pallets/swap/src/pallet/mod.rs has no such name at all)
    // -- swap.PriceLimitExceeded already covers the identical failure mode
    // ("the operation would exceed the price limit"), so removing the dead
    // entry loses no real coverage.
    expect(decodeModuleError("swap", "SlippageTooHigh").category).toBe("unknown");
  });
});

// The five codes issue #5240 itself cited, independently re-verified against
// common/src/transaction_error.rs's real CustomTransactionError -> u8
// mapping (all five turned out correct) plus the rest of the
// staking-relevant subset this file curates.
const EXPECTED_CUSTOM_ERRORS: Array<[code: number, name: string, category: TxErrorCategory]> = [
  [1, "StakeAmountTooLow", "invalid_argument"],
  [2, "BalanceTooLow", "insufficient_balance"],
  [3, "SubnetNotExists", "invalid_argument"],
  [4, "HotkeyAccountDoesntExist", "not_registered"],
  [5, "NotEnoughStakeToWithdraw", "insufficient_balance"],
  [6, "RateLimitExceeded", "rate_limited"],
  [7, "InsufficientLiquidity", "insufficient_liquidity"],
  [8, "SlippageTooHigh", "insufficient_liquidity"],
  [9, "TransferDisallowed", "disabled"],
  [10, "HotKeyNotRegisteredInNetwork", "not_registered"],
  [25, "NonAssociatedColdKey", "not_authorized"],
  [26, "DelegateTakeTooLow", "invalid_argument"],
  [27, "DelegateTakeTooHigh", "invalid_argument"],
];

describe("decodeCustomTxError", () => {
  it.each(EXPECTED_CUSTOM_ERRORS)("decodes code %i (%s) as %s", (code, name, category) => {
    const decoded = decodeCustomTxError(code);
    expect(decoded.category).toBe(category);
    expect(decoded.source).toBe(`Custom(${code}:${name})`);
    expect(decoded.message.length).toBeGreaterThan(0);
  });

  it("falls back to a generic message for an unrecognized code, never throwing", () => {
    const decoded = decodeCustomTxError(999);
    expect(decoded.category).toBe("unknown");
    expect(decoded.source).toBe("Custom(999)");
    expect(decoded.message).toContain("999");
  });

  it("does not confuse a rejected-by-index code outside the staking-relevant subset (e.g. IP/port codes) with a real match", () => {
    // Code 11/12/13 exist in the real enum (InvalidIpAddress/
    // ServingRateLimitExceeded/InvalidPort) but are deliberately not curated
    // here (out of this epic's scope) -- must fall through to "unknown", not
    // silently match something else.
    expect(decodeCustomTxError(11).category).toBe("unknown");
  });
});
