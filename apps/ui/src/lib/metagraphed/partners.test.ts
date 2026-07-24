import { describe, expect, it } from "vitest";

import {
  PARTNER_VALIDATORS,
  isPartnerHotkey,
  partnerForNetuid,
} from "./partners";

describe("partnerForNetuid", () => {
  it("returns the partner row for a known netuid", () => {
    const known = PARTNER_VALIDATORS[0];
    expect(partnerForNetuid(known.netuid)).toEqual(known);
  });

  it("returns null for an unknown netuid", () => {
    expect(partnerForNetuid(999_999)).toBeNull();
  });

  it("returns null for null/undefined netuid", () => {
    expect(partnerForNetuid(null)).toBeNull();
    expect(partnerForNetuid(undefined)).toBeNull();
  });
});

describe("isPartnerHotkey", () => {
  it("returns true for a configured partner hotkey", () => {
    expect(isPartnerHotkey(PARTNER_VALIDATORS[0].hotkey)).toBe(true);
  });

  it("returns false for a non-partner hotkey", () => {
    expect(isPartnerHotkey("5NotAPartnerHotkey000000000000000000000000000000")).toBe(false);
  });

  it("returns false for null/undefined/empty hotkey", () => {
    expect(isPartnerHotkey(null)).toBe(false);
    expect(isPartnerHotkey(undefined)).toBe(false);
    expect(isPartnerHotkey("")).toBe(false);
  });
});
