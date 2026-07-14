import { describe, it, expect } from "vitest";
import { taoToRao, alphaToRawAlpha } from "./units";
import {
  computeLimitPrice,
  buildAddStakeLimitParams,
  buildRemoveStakeLimitParams,
  buildSwapStakeLimitParams,
  buildMoveStakeParams,
  validateStakeInputs,
  describeStakeValidationIssue,
} from "./stake-extrinsics";

const HOTKEY_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("computeLimitPrice", () => {
  it("adds tolerance above spot price when adding stake (willing to pay up to)", () => {
    const limit = computeLimitPrice({ spotPriceTao: 10, tolerancePct: 5, direction: "add" });
    expect(limit).toBe(taoToRao("10.5"));
  });

  it("subtracts tolerance below spot price when removing stake (willing to accept down to)", () => {
    const limit = computeLimitPrice({ spotPriceTao: 10, tolerancePct: 5, direction: "remove" });
    expect(limit).toBe(taoToRao("9.5"));
  });

  it("handles the root subnet's fixed 1.0 spot price the same way", () => {
    expect(computeLimitPrice({ spotPriceTao: 1, tolerancePct: 5, direction: "add" })).toBe(
      taoToRao("1.05"),
    );
  });

  it("supports a zero tolerance (exact spot price as the limit)", () => {
    expect(computeLimitPrice({ spotPriceTao: 10, tolerancePct: 0, direction: "add" })).toBe(
      taoToRao("10"),
    );
  });

  it("rejects a non-positive spot price", () => {
    expect(() => computeLimitPrice({ spotPriceTao: 0, tolerancePct: 5, direction: "add" })).toThrow(
      /invalid spot price/i,
    );
    expect(() =>
      computeLimitPrice({ spotPriceTao: -1, tolerancePct: 5, direction: "add" }),
    ).toThrow(/invalid spot price/i);
  });

  it("rejects a negative tolerance", () => {
    expect(() =>
      computeLimitPrice({ spotPriceTao: 10, tolerancePct: -1, direction: "add" }),
    ).toThrow(/invalid tolerance/i);
  });

  it("rejects a remove-side tolerance so large it would produce a non-positive limit price", () => {
    expect(() =>
      computeLimitPrice({ spotPriceTao: 10, tolerancePct: 100, direction: "remove" }),
    ).toThrow(/tolerance too large/i);
  });
});

describe("buildAddStakeLimitParams", () => {
  it("builds the exact params add_stake_limit expects, in order", () => {
    const params = buildAddStakeLimitParams({
      hotkey: HOTKEY_A,
      netuid: 4,
      amountStaked: taoToRao("10"),
      limitPrice: taoToRao("1.05"),
      allowPartial: true,
    });
    expect(params).toEqual({
      call: "add_stake_limit",
      hotkey: HOTKEY_A,
      netuid: 4,
      amountStaked: taoToRao("10"),
      limitPrice: taoToRao("1.05"),
      allowPartial: true,
    });
  });

  it("rejects a non-positive amount or limit price", () => {
    expect(() =>
      buildAddStakeLimitParams({
        hotkey: HOTKEY_A,
        netuid: 4,
        amountStaked: taoToRao("0"),
        limitPrice: taoToRao("1"),
        allowPartial: false,
      }),
    ).toThrow(/amountStaked/);
    expect(() =>
      buildAddStakeLimitParams({
        hotkey: HOTKEY_A,
        netuid: 4,
        amountStaked: taoToRao("10"),
        limitPrice: taoToRao("0"),
        allowPartial: false,
      }),
    ).toThrow(/limitPrice/);
  });
});

describe("buildRemoveStakeLimitParams", () => {
  it("builds params with amountUnstaked denominated in alpha, not tao", () => {
    const params = buildRemoveStakeLimitParams({
      hotkey: HOTKEY_A,
      netuid: 4,
      amountUnstaked: alphaToRawAlpha("5"),
      limitPrice: taoToRao("9.5"),
      allowPartial: false,
    });
    expect(params.call).toBe("remove_stake_limit");
    expect(params.amountUnstaked).toBe(alphaToRawAlpha("5"));
  });
});

describe("buildSwapStakeLimitParams", () => {
  it("builds params for a cross-subnet swap", () => {
    const params = buildSwapStakeLimitParams({
      hotkey: HOTKEY_A,
      originNetuid: 4,
      destinationNetuid: 7,
      alphaAmount: alphaToRawAlpha("2"),
      limitPrice: taoToRao("9.5"),
      allowPartial: true,
    });
    expect(params).toEqual({
      call: "swap_stake_limit",
      hotkey: HOTKEY_A,
      originNetuid: 4,
      destinationNetuid: 7,
      alphaAmount: alphaToRawAlpha("2"),
      limitPrice: taoToRao("9.5"),
      allowPartial: true,
    });
  });

  it("rejects identical origin/destination netuids", () => {
    expect(() =>
      buildSwapStakeLimitParams({
        hotkey: HOTKEY_A,
        originNetuid: 4,
        destinationNetuid: 4,
        alphaAmount: alphaToRawAlpha("2"),
        limitPrice: taoToRao("9.5"),
        allowPartial: true,
      }),
    ).toThrow(/distinct origin\/destination/);
  });
});

describe("buildMoveStakeParams", () => {
  it("builds a same-subnet hotkey reassignment (the only supported case)", () => {
    const params = buildMoveStakeParams({
      originHotkey: HOTKEY_A,
      destinationHotkey: HOTKEY_B,
      netuid: 4,
      alphaAmount: alphaToRawAlpha("3"),
    });
    expect(params).toEqual({
      call: "move_stake",
      originHotkey: HOTKEY_A,
      destinationHotkey: HOTKEY_B,
      netuid: 4,
      alphaAmount: alphaToRawAlpha("3"),
    });
  });

  it("has no way to express distinct origin/destination netuids at all", () => {
    // A single `netuid` field (used for both origin and destination on-chain)
    // is the whole safety mechanism here -- there is no parameter through
    // which a caller could accidentally construct the unprotected
    // cross-subnet form. Cross-subnet moves must be composed from
    // buildRemoveStakeLimitParams + buildAddStakeLimitParams instead.
    const params = buildMoveStakeParams({
      originHotkey: HOTKEY_A,
      destinationHotkey: HOTKEY_B,
      netuid: 4,
      alphaAmount: alphaToRawAlpha("3"),
    });
    expect(Object.keys(params)).not.toContain("originNetuid");
    expect(Object.keys(params)).not.toContain("destinationNetuid");
  });
});

describe("validateStakeInputs", () => {
  const base = {
    hotkey: HOTKEY_A,
    netuid: 4,
    knownNetuids: [0, 4, 7],
    minStakeRao: taoToRao("0.002"),
  };

  it("returns no issues for a valid add-stake input", () => {
    expect(
      validateStakeInputs({
        ...base,
        amountRao: taoToRao("1"),
        availableBalanceRao: taoToRao("10"),
      }),
    ).toEqual([]);
  });

  it("flags an invalid hotkey", () => {
    const issues = validateStakeInputs({
      ...base,
      hotkey: "not-a-hotkey",
      amountRao: taoToRao("1"),
    });
    expect(issues).toContainEqual({ code: "invalid_hotkey" });
  });

  it("flags an unknown netuid", () => {
    const issues = validateStakeInputs({ ...base, netuid: 999, amountRao: taoToRao("1") });
    expect(issues).toContainEqual({ code: "invalid_netuid" });
  });

  it("flags a non-positive amount and skips the amount-dependent checks", () => {
    const issues = validateStakeInputs({ ...base, amountRao: taoToRao("0") });
    expect(issues).toEqual([{ code: "amount_not_positive" }]);
  });

  it("flags an amount below the min-stake floor", () => {
    const issues = validateStakeInputs({ ...base, amountRao: taoToRao("0.0005") });
    expect(issues).toContainEqual({ code: "below_min_stake", minStakeRao: base.minStakeRao });
  });

  it("flags an amount exceeding available balance when a balance is supplied", () => {
    const issues = validateStakeInputs({
      ...base,
      amountRao: taoToRao("100"),
      availableBalanceRao: taoToRao("10"),
    });
    expect(issues).toContainEqual({ code: "insufficient_balance", availableRao: taoToRao("10") });
  });

  it("skips the balance check entirely when no balance is supplied (remove/move flows)", () => {
    const issues = validateStakeInputs({ ...base, amountRao: taoToRao("100") });
    expect(issues.some((i) => i.code === "insufficient_balance")).toBe(false);
  });

  it("can return multiple issues at once", () => {
    const issues = validateStakeInputs({
      ...base,
      hotkey: "bogus",
      netuid: 999,
      amountRao: taoToRao("0.0001"),
      availableBalanceRao: taoToRao("0"),
    });
    expect(issues.map((i) => i.code).sort()).toEqual(
      ["below_min_stake", "insufficient_balance", "invalid_hotkey", "invalid_netuid"].sort(),
    );
  });
});

describe("describeStakeValidationIssue", () => {
  it("produces readable copy for every issue code", () => {
    expect(describeStakeValidationIssue({ code: "invalid_hotkey" })).toMatch(/hotkey/i);
    expect(describeStakeValidationIssue({ code: "invalid_netuid" })).toMatch(/subnet/i);
    expect(describeStakeValidationIssue({ code: "amount_not_positive" })).toMatch(/amount/i);
    expect(
      describeStakeValidationIssue({ code: "below_min_stake", minStakeRao: taoToRao("0.002") }),
    ).toContain("0.002");
    expect(
      describeStakeValidationIssue({ code: "insufficient_balance", availableRao: taoToRao("10") }),
    ).toContain("10");
  });
});
