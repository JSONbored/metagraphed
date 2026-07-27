import { describe, expect, it } from "vitest";
import { accountRole, isDualRoleAccount, isImplausibleTao } from "./account-role";
import type { AccountRegistration } from "./types";

function account(registrations: AccountRegistration[]) {
  return { registrations };
}

const ONE_REGISTRATION: AccountRegistration[] = [{ netuid: 1, uid: 0 }];

describe("accountRole", () => {
  it("is coldkey when there are no registrations", () => {
    expect(accountRole(account([]))).toBe("coldkey");
  });

  it("is hotkey when there is at least one registration", () => {
    expect(accountRole(account(ONE_REGISTRATION))).toBe("hotkey");
  });
});

describe("isDualRoleAccount (#8358)", () => {
  it("is false for a plain hotkey with no wallet balance", () => {
    expect(isDualRoleAccount(account(ONE_REGISTRATION), 0)).toBe(false);
    expect(isDualRoleAccount(account(ONE_REGISTRATION), null)).toBe(false);
    expect(isDualRoleAccount(account(ONE_REGISTRATION), undefined)).toBe(false);
  });

  it("is false for a plain coldkey (no registrations), regardless of balance", () => {
    expect(isDualRoleAccount(account([]), 1000)).toBe(false);
  });

  it("is true only when both a registration AND a positive free balance are present", () => {
    expect(isDualRoleAccount(account(ONE_REGISTRATION), 5)).toBe(true);
  });
});

describe("isImplausibleTao", () => {
  it("flags values over the 21M TAO total issuance", () => {
    expect(isImplausibleTao(21_000_001)).toBe(true);
  });

  it("does not flag values at or under total issuance", () => {
    expect(isImplausibleTao(21_000_000)).toBe(false);
    expect(isImplausibleTao(100)).toBe(false);
    expect(isImplausibleTao(null)).toBe(false);
    expect(isImplausibleTao(undefined)).toBe(false);
  });
});
