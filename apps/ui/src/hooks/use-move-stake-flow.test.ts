import { describe, expect, it } from "vitest";
import { alphaToRawAlpha, taoToRao } from "@/lib/metagraphed/units";
import {
  deriveMoveStakeFlowPhase,
  canCloseMoveStakeFlow,
  resolveMoveStakeAxis,
  describeMoveStakeAxisIssue,
  resolveMoveStakeMaxAmountInput,
  resolveOriginSpotPriceTao,
  formatSpotValueTao,
  buildMoveStakeCallParams,
  confirmAlphaAmount,
} from "./use-move-stake-flow";

const HOTKEY_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("deriveMoveStakeFlowPhase", () => {
  it("is 'connect' whenever the wallet isn't connected, regardless of confirmed/txStatus", () => {
    expect(deriveMoveStakeFlowPhase("idle", false, "idle")).toBe("connect");
    expect(deriveMoveStakeFlowPhase("connecting", true, "finalized")).toBe("connect");
    expect(deriveMoveStakeFlowPhase("no-extension", true, "signing")).toBe("connect");
  });

  it("is 'amount' whenever not yet confirmed, once connected", () => {
    expect(deriveMoveStakeFlowPhase("connected", false, "idle")).toBe("amount");
    expect(deriveMoveStakeFlowPhase("connected", false, "finalized")).toBe("amount");
  });

  it("is 'confirm' once confirmed with an idle tx", () => {
    expect(deriveMoveStakeFlowPhase("connected", true, "idle")).toBe("confirm");
  });

  it("is 'signing' while the extension is prompting for a signature", () => {
    expect(deriveMoveStakeFlowPhase("connected", true, "signing")).toBe("signing");
  });

  it("is 'failed' for a decoded on-chain failure or a rejected/pre-dispatch submission", () => {
    expect(deriveMoveStakeFlowPhase("connected", true, "failed")).toBe("failed");
    expect(deriveMoveStakeFlowPhase("connected", true, "submit-error")).toBe("failed");
  });

  it("is 'done' once finalized", () => {
    expect(deriveMoveStakeFlowPhase("connected", true, "finalized")).toBe("done");
  });

  it("is 'broadcasting' for every other in-flight broadcast status", () => {
    for (const status of [
      "future",
      "ready",
      "broadcast",
      "in-block",
      "retracted",
      "finality-timeout",
      "usurped",
      "dropped",
      "invalid",
      "error",
    ] as const) {
      expect(deriveMoveStakeFlowPhase("connected", true, status)).toBe("broadcasting");
    }
  });
});

describe("canCloseMoveStakeFlow", () => {
  it("allows closing from idle, failed, submit-error, and finalized", () => {
    expect(canCloseMoveStakeFlow("idle")).toBe(true);
    expect(canCloseMoveStakeFlow("failed")).toBe(true);
    expect(canCloseMoveStakeFlow("submit-error")).toBe(true);
    expect(canCloseMoveStakeFlow("finalized")).toBe(true);
  });

  it("blocks closing while signing or mid-broadcast", () => {
    expect(canCloseMoveStakeFlow("signing")).toBe(false);
    expect(canCloseMoveStakeFlow("broadcast")).toBe(false);
    expect(canCloseMoveStakeFlow("in-block")).toBe(false);
    expect(canCloseMoveStakeFlow("future")).toBe(false);
  });
});

describe("resolveMoveStakeAxis", () => {
  it("is 'hotkey' when only the hotkey differs", () => {
    expect(resolveMoveStakeAxis(HOTKEY_A, 4, HOTKEY_B, 4)).toBe("hotkey");
  });

  it("is 'subnet' when only the netuid differs", () => {
    expect(resolveMoveStakeAxis(HOTKEY_A, 4, HOTKEY_A, 7)).toBe("subnet");
  });

  it("is 'both' when hotkey AND netuid differ", () => {
    expect(resolveMoveStakeAxis(HOTKEY_A, 4, HOTKEY_B, 7)).toBe("both");
  });

  it("is 'unchanged' when neither differs", () => {
    expect(resolveMoveStakeAxis(HOTKEY_A, 4, HOTKEY_A, 4)).toBe("unchanged");
  });

  it("trims whitespace before comparing the hotkey", () => {
    expect(resolveMoveStakeAxis(HOTKEY_A, 4, `  ${HOTKEY_A}  `, 4)).toBe("unchanged");
  });
});

describe("describeMoveStakeAxisIssue", () => {
  it("has distinct copy for 'both' vs 'unchanged'", () => {
    expect(describeMoveStakeAxisIssue("both")).toMatch(/one step, not both/);
    expect(describeMoveStakeAxisIssue("unchanged")).toMatch(/Choose a different/);
  });
});

describe("resolveMoveStakeMaxAmountInput", () => {
  it("uses the position's TAO figure for root (alpha IS TAO, 1:1)", () => {
    expect(resolveMoveStakeMaxAmountInput(true, null, 12.5)).toBe("12.500000000");
  });

  it("returns null for root when the position has no TAO value", () => {
    expect(resolveMoveStakeMaxAmountInput(true, null, 0)).toBeNull();
  });

  it("uses the position's alpha figure for a non-root subnet", () => {
    expect(resolveMoveStakeMaxAmountInput(false, 20, 10)).toBe("20.000000000");
  });

  it("returns null for a non-root subnet when alpha is unknown or non-positive", () => {
    expect(resolveMoveStakeMaxAmountInput(false, null, 10)).toBeNull();
    expect(resolveMoveStakeMaxAmountInput(false, 0, 10)).toBeNull();
  });
});

describe("resolveOriginSpotPriceTao", () => {
  it("is fixed at 1.0 for root regardless of the position data", () => {
    expect(resolveOriginSpotPriceTao(true, null, 999)).toBe(1);
  });

  it("derives price = spotTao / alpha for a non-root subnet", () => {
    expect(resolveOriginSpotPriceTao(false, 20, 10)).toBe(0.5);
  });

  it("is null for a non-root subnet when alpha is unknown or non-positive", () => {
    expect(resolveOriginSpotPriceTao(false, null, 10)).toBeNull();
    expect(resolveOriginSpotPriceTao(false, 0, 10)).toBeNull();
    expect(resolveOriginSpotPriceTao(false, -1, 10)).toBeNull();
  });
});

describe("formatSpotValueTao", () => {
  it("multiplies alpha by the spot price, rounded through the standard 9-decimal path", () => {
    expect(formatSpotValueTao(10, 2)).toBe("20");
    expect(formatSpotValueTao(1, 0.333333333)).toBe("0.333333333");
  });

  it("floors at zero rather than a negative display value", () => {
    expect(formatSpotValueTao(-5, 2)).toBe("0");
  });

  it("falls back to zero for non-finite inputs rather than propagating NaN", () => {
    expect(formatSpotValueTao(NaN, 2)).toBe("0");
    expect(formatSpotValueTao(5, NaN)).toBe("0");
  });
});

describe("buildMoveStakeCallParams (#5244's fund-safety-critical seam)", () => {
  it("axis 'hotkey' builds move_stake at the ORIGIN netuid, ignoring destinationNetuid entirely", () => {
    const params = buildMoveStakeCallParams({
      axis: "hotkey",
      originHotkey: HOTKEY_A,
      originNetuid: 4,
      destinationHotkey: HOTKEY_B,
      destinationNetuid: 999, // must be ignored for this axis -- same-subnet only
      alphaAmountInput: "3",
      originSpotPriceTao: null, // move_stake needs no price at all
      tolerancePct: 5,
    });
    expect(params).toEqual({
      call: "move_stake",
      originHotkey: HOTKEY_A,
      destinationHotkey: HOTKEY_B,
      netuid: 4,
      alphaAmount: alphaToRawAlpha("3"),
    });
  });

  it("axis 'subnet' builds swap_stake_limit with limitPrice from the ORIGIN spot price, 'remove' direction", () => {
    const params = buildMoveStakeCallParams({
      axis: "subnet",
      originHotkey: HOTKEY_A,
      originNetuid: 4,
      destinationHotkey: HOTKEY_A,
      destinationNetuid: 7,
      alphaAmountInput: "2",
      originSpotPriceTao: 10,
      tolerancePct: 5,
    });
    expect(params).toEqual({
      call: "swap_stake_limit",
      hotkey: HOTKEY_A,
      originNetuid: 4,
      destinationNetuid: 7,
      alphaAmount: alphaToRawAlpha("2"),
      limitPrice: taoToRao("9.5"), // 10 * (1 - 5/100), same "remove" math as computeLimitPrice elsewhere
      allowPartial: false,
    });
  });

  it("axis 'subnet' returns null when the origin spot price isn't resolved yet, rather than guessing", () => {
    expect(
      buildMoveStakeCallParams({
        axis: "subnet",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_A,
        destinationNetuid: 7,
        alphaAmountInput: "2",
        originSpotPriceTao: null,
        tolerancePct: 5,
      }),
    ).toBeNull();
  });

  it("returns null for a non-positive amount rather than throwing, for either axis", () => {
    expect(
      buildMoveStakeCallParams({
        axis: "hotkey",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_B,
        destinationNetuid: 4,
        alphaAmountInput: "0",
        originSpotPriceTao: null,
        tolerancePct: 5,
      }),
    ).toBeNull();
    expect(
      buildMoveStakeCallParams({
        axis: "subnet",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_A,
        destinationNetuid: 7,
        alphaAmountInput: "-1",
        originSpotPriceTao: 10,
        tolerancePct: 5,
      }),
    ).toBeNull();
  });

  it("returns null for an unparseable amount string rather than throwing", () => {
    expect(
      buildMoveStakeCallParams({
        axis: "hotkey",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_B,
        destinationNetuid: 4,
        alphaAmountInput: "not-a-number",
        originSpotPriceTao: null,
        tolerancePct: 5,
      }),
    ).toBeNull();
  });

  it("returns null for an invalid tolerance on the 'subnet' axis (would otherwise throw inside computeLimitPrice)", () => {
    expect(
      buildMoveStakeCallParams({
        axis: "subnet",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_A,
        destinationNetuid: 7,
        alphaAmountInput: "2",
        originSpotPriceTao: 10,
        tolerancePct: -1,
      }),
    ).toBeNull();
  });

  it("never builds a call with identical origin/destination netuids for the 'subnet' axis (buildSwapStakeLimitParams' own guard)", () => {
    expect(
      buildMoveStakeCallParams({
        axis: "subnet",
        originHotkey: HOTKEY_A,
        originNetuid: 4,
        destinationHotkey: HOTKEY_A,
        destinationNetuid: 4,
        alphaAmountInput: "2",
        originSpotPriceTao: 10,
        tolerancePct: 5,
      }),
    ).toBeNull();
  });
});

describe("confirmAlphaAmount", () => {
  it("reconstructs the exact alpha display from either params shape's alphaAmount field", () => {
    expect(
      confirmAlphaAmount({
        call: "move_stake",
        originHotkey: HOTKEY_A,
        destinationHotkey: HOTKEY_B,
        netuid: 4,
        alphaAmount: alphaToRawAlpha("3"),
      }),
    ).toBe("3");
  });

  it("returns undefined for a null params object", () => {
    expect(confirmAlphaAmount(null)).toBeUndefined();
  });
});
