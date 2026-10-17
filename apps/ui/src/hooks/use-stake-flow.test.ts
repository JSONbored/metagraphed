import { describe, expect, it } from "vitest";
import { alphaToRawAlpha, taoToRao } from "@/lib/metagraphed/units";
import type { SubnetStakeQuote } from "@/lib/metagraphed/types";
import {
  deriveStakeFlowPhase,
  canCloseStakeFlow,
  computeUnstakeAlphaCandidate,
  resolveStakeQuoteAmount,
  stakeQuoteSpotPrice,
  resolveStakeMaxRao,
  buildStakeCallParams,
  createStakeConfirmation,
  stakeConfirmationMatches,
  type StakeFlowIntent,
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

describe("resolveStakeQuoteAmount", () => {
  it("quotes a known alpha input directly and a staking TAO input without a conversion", () => {
    expect(resolveStakeQuoteAmount("unstake", "alpha", "12.5", null)).toBe(12.5);
    expect(resolveStakeQuoteAmount("stake", "tao", "12.5", null)).toBe(12.5);
  });

  it("converts a TAO unstake target only through an observed positive price", () => {
    expect(resolveStakeQuoteAmount("unstake", "tao", "25", 2)).toBe(12.5);
    for (const price of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(resolveStakeQuoteAmount("unstake", "tao", "25", price)).toBeNull();
    }
  });

  it("declines invalid and below-precision inputs rather than producing a zero quote", () => {
    for (const amount of ["", "nope", "0", "-1", "Infinity"]) {
      expect(resolveStakeQuoteAmount("unstake", "alpha", amount, 2)).toBeNull();
    }
    expect(resolveStakeQuoteAmount("unstake", "tao", "0.0000000001", 1)).toBeNull();
  });
});

describe("stakeQuoteSpotPrice", () => {
  it("uses only positive finite prices for the same subnet", () => {
    expect(stakeQuoteSpotPrice({ netuid: 4, spot_price_tao: 2 }, 4)).toBe(2);
    expect(stakeQuoteSpotPrice({ netuid: 5, spot_price_tao: 2 }, 4)).toBeNull();
    expect(stakeQuoteSpotPrice(null, 4)).toBeNull();
    for (const spot_price_tao of [0, -1, NaN, Infinity]) {
      expect(stakeQuoteSpotPrice({ netuid: 4, spot_price_tao }, 4)).toBeNull();
    }
  });
});

describe("quoted stake confirmation", () => {
  const intent: StakeFlowIntent = {
    action: "unstake",
    hotkey: HOTKEY,
    netuid: 4,
    amountInput: "25",
    unit: "tao",
    tolerancePct: 5,
    signerAddress: "5Signer",
  };
  const quote: SubnetStakeQuote = {
    schema_version: 1,
    netuid: 4,
    direction: "unstake",
    amount: 12.5,
    expected_out: 45,
    expected_out_unit: "tao",
    spot_price_tao: 4,
    effective_price_tao: 3.6,
    price_impact_pct: 10,
    tao_in_pool_tao: 1000,
    alpha_in_pool: 250,
    is_root: false,
  };

  it("signs the exact quoted alpha when the returned spot differs from the request estimate", () => {
    const requestedAlpha = resolveStakeQuoteAmount("unstake", "tao", "25", 2);
    const confirmation = createStakeConfirmation(intent, requestedAlpha, quote);
    expect(requestedAlpha).toBe(12.5);
    expect(confirmation?.params).toMatchObject({
      call: "remove_stake_limit",
      hotkey: HOTKEY,
      netuid: 4,
      amountUnstaked: alphaToRawAlpha("12.5"),
      limitPrice: taoToRao("3.8"),
    });
    expect(confirmation?.quote.expected_out).toBe(45);
  });

  it("keeps staking in quoted TAO and direct unstaking in quoted alpha", () => {
    const staking = createStakeConfirmation({ ...intent, action: "stake" }, 25, {
      ...quote,
      direction: "stake",
      amount: 25,
      expected_out: 5,
      expected_out_unit: "alpha",
    });
    expect(staking?.params).toMatchObject({
      call: "add_stake_limit",
      amountStaked: taoToRao("25"),
      limitPrice: taoToRao("4.2"),
    });
    const unstaking = createStakeConfirmation(
      { ...intent, unit: "alpha", amountInput: "12.5" },
      12.5,
      quote,
    );
    expect(unstaking?.params).toMatchObject({
      call: "remove_stake_limit",
      amountUnstaked: alphaToRawAlpha("12.5"),
    });
  });

  it("rejects a quote for another amount, subnet, action, or output unit", () => {
    for (const mismatch of [
      { ...quote, amount: 25 },
      { ...quote, netuid: 5 },
      { ...quote, direction: "stake" as const },
      { ...quote, expected_out_unit: "alpha" as const },
    ]) {
      expect(createStakeConfirmation(intent, 12.5, mismatch)).toBeNull();
    }
    expect(createStakeConfirmation(intent, null, quote)).toBeNull();
    expect(createStakeConfirmation({ ...intent, signerAddress: null }, 12.5, quote)).toBeNull();
    expect(createStakeConfirmation({ ...intent, unit: "alpha" }, 12.5, quote)).toBeNull();
    expect(
      createStakeConfirmation(intent, 1.0000000001, { ...quote, amount: 1.0000000001 }),
    ).toBeNull();
    expect(createStakeConfirmation({ ...intent, amountInput: "1e1" }, 12.5, quote)).toBeNull();
  });

  it("keeps confirmed quote and params stable across later price updates", () => {
    const response = { ...quote };
    const mutableIntent = { ...intent };
    const confirmation = createStakeConfirmation(mutableIntent, 12.5, response);
    if (!confirmation) throw new Error("expected a matching quote");
    response.spot_price_tao = 8;
    response.expected_out = 90;
    mutableIntent.amountInput = "50";
    const next = createStakeConfirmation(intent, 12.5, response);
    expect(next?.params.limitPrice).toBe(taoToRao("7.6"));
    expect(confirmation.params.limitPrice).toBe(taoToRao("3.8"));
    expect(confirmation.quote.spot_price_tao).toBe(4);
    expect(confirmation.quote.expected_out).toBe(45);
    expect(confirmation.intent.amountInput).toBe("25");
    expect(stakeConfirmationMatches(confirmation, { ...intent })).toBe(true);
  });

  it("requires the same signer, hotkey, subnet, action, input unit, amount, and tolerance", () => {
    const confirmation = createStakeConfirmation(intent, 12.5, quote);
    for (const change of [
      { hotkey: "5OtherHotkey" },
      { netuid: 5 },
      { action: "stake" as const },
      { unit: "alpha" as const },
      { amountInput: "50" },
      { tolerancePct: 10 },
      { signerAddress: "5OtherSigner" },
    ]) {
      expect(stakeConfirmationMatches(confirmation, { ...intent, ...change })).toBe(false);
    }
    expect(stakeConfirmationMatches(null, intent)).toBe(false);
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
