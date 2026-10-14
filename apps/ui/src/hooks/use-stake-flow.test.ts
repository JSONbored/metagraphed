import { describe, expect, it } from "vitest";
import { alphaToRawAlpha, taoToRao } from "@/lib/metagraphed/units";
import type { AccountPosition } from "@/lib/metagraphed/types";
import {
  deriveStakeFlowPhase,
  canCloseStakeFlow,
  computeUnstakeAlphaCandidate,
  resolveStakeMaxRao,
  resolveUnstakeMaxAmountInput,
  isMaxUnavailableForNetuid,
  buildStakeCallParams,
  resolveUnstakeValidationAmountRao,
  DEFAULT_TOLERANCE_PCT,
} from "./use-stake-flow";

const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("deriveStakeFlowPhase", () => {
  it("is 'connect' whenever the wallet isn't connected, regardless of confirmed/txStatus", () => {
    expect(deriveStakeFlowPhase("idle", false, "idle")).toBe("connect");
    expect(deriveStakeFlowPhase("connecting", true, "finalized")).toBe("connect");
    expect(deriveStakeFlowPhase("no-extension", true, "signing")).toBe("connect");
  });

  it("is 'amount' whenever not yet confirmed, once connected", () => {
    expect(deriveStakeFlowPhase("connected", false, "idle")).toBe("amount");
    expect(deriveStakeFlowPhase("connected", false, "finalized")).toBe("amount");
  });

  it("is 'confirm' once confirmed with an idle tx", () => {
    expect(deriveStakeFlowPhase("connected", true, "idle")).toBe("confirm");
  });

  it("is 'signing' while the extension is prompting for a signature", () => {
    expect(deriveStakeFlowPhase("connected", true, "signing")).toBe("signing");
  });

  it("is 'failed' for a decoded on-chain failure or a rejected/pre-dispatch submission", () => {
    expect(deriveStakeFlowPhase("connected", true, "failed")).toBe("failed");
    expect(deriveStakeFlowPhase("connected", true, "submit-error")).toBe("failed");
  });

  it("is 'done' once finalized", () => {
    expect(deriveStakeFlowPhase("connected", true, "finalized")).toBe("done");
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
      expect(deriveStakeFlowPhase("connected", true, status)).toBe("broadcasting");
    }
  });
});

describe("canCloseStakeFlow", () => {
  it("allows closing from idle, failed, submit-error, and finalized", () => {
    expect(canCloseStakeFlow("idle")).toBe(true);
    expect(canCloseStakeFlow("failed")).toBe(true);
    expect(canCloseStakeFlow("submit-error")).toBe(true);
    expect(canCloseStakeFlow("finalized")).toBe(true);
  });

  it("blocks closing while signing or mid-broadcast", () => {
    expect(canCloseStakeFlow("signing")).toBe(false);
    expect(canCloseStakeFlow("broadcast")).toBe(false);
    expect(canCloseStakeFlow("in-block")).toBe(false);
    expect(canCloseStakeFlow("future")).toBe(false);
  });
});

describe("computeUnstakeAlphaCandidate", () => {
  it("divides the TAO target by the spot price, rounded to 9 decimals", () => {
    expect(computeUnstakeAlphaCandidate("10", 2)).toBe("5.000000000");
    expect(computeUnstakeAlphaCandidate("1", 3)).toBe("0.333333333");
  });

  it("is a 1:1 passthrough at spot price 1 (the root-subnet case)", () => {
    expect(computeUnstakeAlphaCandidate("42.5", 1)).toBe("42.500000000");
  });

  it("returns '0' for a non-positive or non-finite TAO target", () => {
    expect(computeUnstakeAlphaCandidate("0", 2)).toBe("0");
    expect(computeUnstakeAlphaCandidate("-5", 2)).toBe("0");
    expect(computeUnstakeAlphaCandidate("", 2)).toBe("0");
    expect(computeUnstakeAlphaCandidate("abc", 2)).toBe("0");
  });

  it("returns '0' for a non-positive or non-finite spot price rather than dividing by it", () => {
    expect(computeUnstakeAlphaCandidate("10", 0)).toBe("0");
    expect(computeUnstakeAlphaCandidate("10", -1)).toBe("0");
    expect(computeUnstakeAlphaCandidate("10", NaN)).toBe("0");
  });
});

describe("resolveStakeMaxRao", () => {
  it("subtracts the buffer from the free balance", () => {
    expect(resolveStakeMaxRao(taoToRao("10"), taoToRao("0.02"))).toBe(taoToRao("9.98"));
  });

  it("floors at zero rather than going negative when the balance is below the buffer", () => {
    expect(resolveStakeMaxRao(taoToRao("0.01"), taoToRao("0.02"))).toBe(0n);
    expect(resolveStakeMaxRao(taoToRao("0"), taoToRao("0.02"))).toBe(0n);
  });

  it("defaults to the standard 0.02 TAO buffer", () => {
    expect(resolveStakeMaxRao(taoToRao("5"))).toBe(taoToRao("4.98"));
  });
});

describe("resolveUnstakeMaxAmountInput", () => {
  const position: AccountPosition = {
    hotkey: HOTKEY,
    netuid: 4,
    share_fraction: 0.5,
    stake_tao: null,
    alpha_rao: "6250000000",
    quantity_status: "qualified_snapshot",
    provenance: {
      network: "finney",
      captured_at: "2026-10-13T00:00:00Z",
      block_number: 9000000,
      block_hash: "0x" + "a".repeat(64),
      genesis_hash: "0x" + "b".repeat(64),
      spec_version: 454,
      code_hash: "0x" + "c".repeat(64),
      metadata_sha256: "d".repeat(64),
    },
  };
  it("keeps Alpha exact and labels a price-based TAO candidate", () => {
    expect(resolveUnstakeMaxAmountInput(position, "tao", 2)).toBe("12.500000000");
    expect(resolveUnstakeMaxAmountInput(position, "alpha", NaN)).toBe("6.25");
    expect(resolveUnstakeMaxAmountInput({ ...position, alpha_rao: "1" }, "alpha", 2)).toBe(
      "0.000000001",
    );
    expect(resolveUnstakeMaxAmountInput({ ...position, alpha_rao: "0" }, "alpha", 2)).toBe("0");
  });
  it("withholds unqualified, Root, malformed and overflowing inputs", () => {
    expect(resolveUnstakeMaxAmountInput(null, "tao", 2)).toBeNull();
    for (const bad of [
      { quantity_status: "unqualified" as const },
      { netuid: 0 },
      { netuid: -1 },
      { provenance: null },
      { alpha_rao: "18446744073709551616" },
      { alpha_rao: "01" },
    ])
      expect(resolveUnstakeMaxAmountInput({ ...position, ...bad }, "alpha", 2)).toBeNull();
    for (const price of [NaN, Infinity, 0, -1, 1e300])
      expect(resolveUnstakeMaxAmountInput(position, "tao", price)).toBeNull();
  });
});

describe("isMaxUnavailableForNetuid", () => {
  it("is true only for root (netuid 0)", () => {
    expect(isMaxUnavailableForNetuid(0)).toBe(true);
    expect(isMaxUnavailableForNetuid(1)).toBe(false);
    expect(isMaxUnavailableForNetuid(4)).toBe(false);
  });
});

describe("buildStakeCallParams", () => {
  it("builds add_stake_limit for a stake action, ignoring `unit` entirely", () => {
    const params = buildStakeCallParams({
      action: "stake",
      hotkey: HOTKEY,
      netuid: 4,
      amountInput: "10",
      unit: "alpha", // stake has no unit toggle -- must be ignored, not misread as alpha
      spotPriceTao: 2,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
    });
    expect(params).toMatchObject({
      call: "add_stake_limit",
      hotkey: HOTKEY,
      netuid: 4,
      amountStaked: taoToRao("10"),
    });
    // add side: limit price is spot * (1 + tolerance/100).
    expect(params && "limitPrice" in params ? params.limitPrice : null).toBe(taoToRao("2.1"));
  });

  it("builds remove_stake_limit directly from the typed alpha amount in alpha mode", () => {
    const params = buildStakeCallParams({
      action: "unstake",
      hotkey: HOTKEY,
      netuid: 4,
      amountInput: "5",
      unit: "alpha",
      spotPriceTao: 2,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
    });
    expect(params).toMatchObject({
      call: "remove_stake_limit",
      hotkey: HOTKEY,
      netuid: 4,
      amountUnstaked: alphaToRawAlpha("5"),
    });
    // remove side: limit price is spot * (1 - tolerance/100).
    expect(params && "limitPrice" in params ? params.limitPrice : null).toBe(taoToRao("1.9"));
  });

  it("derives the alpha amount from the TAO target via the candidate estimate in TAO mode", () => {
    const params = buildStakeCallParams({
      action: "unstake",
      hotkey: HOTKEY,
      netuid: 4,
      amountInput: "10",
      unit: "tao",
      spotPriceTao: 2,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
    });
    expect(params).toMatchObject({
      call: "remove_stake_limit",
      amountUnstaked: alphaToRawAlpha(computeUnstakeAlphaCandidate("10", 2)),
    });
  });

  it("returns null for a non-positive amount rather than throwing", () => {
    expect(
      buildStakeCallParams({
        action: "stake",
        hotkey: HOTKEY,
        netuid: 4,
        amountInput: "0",
        unit: "tao",
        spotPriceTao: 2,
        tolerancePct: DEFAULT_TOLERANCE_PCT,
      }),
    ).toBeNull();
    expect(
      buildStakeCallParams({
        action: "unstake",
        hotkey: HOTKEY,
        netuid: 4,
        amountInput: "-1",
        unit: "alpha",
        spotPriceTao: 2,
        tolerancePct: DEFAULT_TOLERANCE_PCT,
      }),
    ).toBeNull();
  });

  it("returns null for an unparseable amount string rather than throwing", () => {
    expect(
      buildStakeCallParams({
        action: "stake",
        hotkey: HOTKEY,
        netuid: 4,
        amountInput: "not-a-number",
        unit: "tao",
        spotPriceTao: 2,
        tolerancePct: DEFAULT_TOLERANCE_PCT,
      }),
    ).toBeNull();
  });

  it("returns null for an invalid spot price (would otherwise throw inside computeLimitPrice)", () => {
    expect(
      buildStakeCallParams({
        action: "stake",
        hotkey: HOTKEY,
        netuid: 4,
        amountInput: "10",
        unit: "tao",
        spotPriceTao: 0,
        tolerancePct: DEFAULT_TOLERANCE_PCT,
      }),
    ).toBeNull();
  });

  it("returns null when the tolerance would push the remove-side limit price to zero or below", () => {
    expect(
      buildStakeCallParams({
        action: "unstake",
        hotkey: HOTKEY,
        netuid: 4,
        amountInput: "5",
        unit: "alpha",
        spotPriceTao: 2,
        tolerancePct: 150,
      }),
    ).toBeNull();
  });

  it("is 1:1 for stake and unstake at spot price 1 (the root-subnet case)", () => {
    const stakeParams = buildStakeCallParams({
      action: "stake",
      hotkey: HOTKEY,
      netuid: 0,
      amountInput: "10",
      unit: "tao",
      spotPriceTao: 1,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
    });
    const unstakeParams = buildStakeCallParams({
      action: "unstake",
      hotkey: HOTKEY,
      netuid: 0,
      amountInput: "10",
      unit: "tao",
      spotPriceTao: 1,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
    });
    expect(stakeParams && "amountStaked" in stakeParams ? stakeParams.amountStaked : null).toBe(
      taoToRao("10"),
    );
    expect(
      unstakeParams && "amountUnstaked" in unstakeParams ? unstakeParams.amountUnstaked : null,
    ).toBe(alphaToRawAlpha("10"));
  });
});

describe("resolveUnstakeValidationAmountRao", () => {
  it("rounds an over-precise quote.expected_out to 9 decimals rather than crashing", () => {
    // A real regression: quote.expected_out is a raw API float that routinely
    // carries more than 9 fractional digits, and taoToRao's strict parse
    // throws on that rather than truncating -- this ran unguarded inside a
    // useMemo and took down the whole route on a live quote.
    expect(resolveUnstakeValidationAmountRao(4.997553120472154)).toBe(taoToRao("4.997553120"));
  });

  it("falls back to zero for a non-finite input rather than propagating NaN", () => {
    expect(resolveUnstakeValidationAmountRao(NaN)).toBe(taoToRao("0"));
    expect(resolveUnstakeValidationAmountRao(Infinity)).toBe(taoToRao("0"));
  });

  it("passes a clean, already-short decimal through unchanged", () => {
    expect(resolveUnstakeValidationAmountRao(10)).toBe(taoToRao("10"));
  });
});
