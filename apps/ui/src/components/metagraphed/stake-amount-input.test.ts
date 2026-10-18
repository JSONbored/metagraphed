import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubnetStakeQuote } from "@/lib/metagraphed/types";
import { MAX_UNSTAKE_UNAVAILABLE_MESSAGE } from "@/hooks/use-stake-flow";
import {
  unitSymbol,
  shouldShowUnitToggle,
  formatPositionAge,
  describeUnstakeMaxState,
  formatQuoteHint,
  StakeAmountInput,
} from "./stake-amount-input";

describe("unitSymbol", () => {
  it("maps tao to τ and alpha to α", () => {
    expect(unitSymbol("tao")).toBe("τ");
    expect(unitSymbol("alpha")).toBe("α");
  });
});

describe("shouldShowUnitToggle", () => {
  it("is false for stake (TAO is both the mental model and the on-chain unit)", () => {
    expect(shouldShowUnitToggle("stake")).toBe(false);
  });

  it("is true for unstake", () => {
    expect(shouldShowUnitToggle("unstake")).toBe(true);
  });
});

describe("formatPositionAge", () => {
  const NOW = Date.parse("2026-07-14T12:00:00Z");

  it("returns null when there's no captured_at", () => {
    expect(formatPositionAge(null, NOW)).toBeNull();
  });

  it("returns null for an unparseable captured_at", () => {
    expect(formatPositionAge("not-a-date", NOW)).toBeNull();
  });

  it("reports sub-hour ages distinctly", () => {
    const thirtyMinAgo = new Date(NOW - 30 * 60 * 1000).toISOString();
    expect(formatPositionAge(thirtyMinAgo, NOW)).toBe("as of <1h ago");
  });

  it("rounds hour-scale ages", () => {
    const fourteenHoursAgo = new Date(NOW - 14 * 60 * 60 * 1000).toISOString();
    expect(formatPositionAge(fourteenHoursAgo, NOW)).toBe("as of ~14h ago");
  });

  it("switches to day-scale ages past 48h", () => {
    const threeDaysAgo = new Date(NOW - 72 * 60 * 60 * 1000).toISOString();
    expect(formatPositionAge(threeDaysAgo, NOW)).toBe("as of ~3d ago");
  });

  it("treats a future timestamp as 'just now' rather than a negative age", () => {
    const inTheFuture = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(formatPositionAge(inTheFuture, NOW)).toBe("as of just now");
  });
});

describe("describeUnstakeMaxState", () => {
  it("declines snapshot-derived Max on every subnet", () => {
    expect(describeUnstakeMaxState(true, null)).toEqual({
      disabled: true,
      note: MAX_UNSTAKE_UNAVAILABLE_MESSAGE,
    });
    expect(describeUnstakeMaxState(true, "5.0")).toEqual({
      disabled: true,
      note: MAX_UNSTAKE_UNAVAILABLE_MESSAGE,
    });
  });

  it("reports an unavailable estimate without asserting the position is absent", () => {
    expect(describeUnstakeMaxState(false, null)).toEqual({
      disabled: true,
      note: MAX_UNSTAKE_UNAVAILABLE_MESSAGE,
    });
  });

  it("does not re-enable Max from an old cached positive prefill", () => {
    expect(describeUnstakeMaxState(false, "5.0")).toEqual({
      disabled: true,
      note: MAX_UNSTAKE_UNAVAILABLE_MESSAGE,
    });
  });

  it("renders a disabled Max even when legacy props contain a positive amount", () => {
    const html = renderToStaticMarkup(
      createElement(StakeAmountInput, {
        action: "unstake",
        onActionChange: vi.fn(),
        unit: "alpha",
        onUnitChange: vi.fn(),
        amountInput: "",
        onAmountInputChange: vi.fn(),
        maxStakeRao: null,
        onApplyMaxStake: vi.fn(),
        maxUnstakeAmountInput: "999.000000000",
        maxUnstakeUnavailable: false,
        positionCapturedAt: "2026-07-05T00:00:00Z",
        onApplyMaxUnstake: vi.fn(),
        quote: null,
        quoteIsPending: false,
        quoteError: null,
        validationMessages: [],
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\s*Max\s*<\/button>/);
    expect(html).toContain(MAX_UNSTAKE_UNAVAILABLE_MESSAGE);
    expect(html).not.toContain("999");
  });
});

describe("formatQuoteHint", () => {
  const baseQuote: SubnetStakeQuote = {
    schema_version: 1,
    netuid: 4,
    direction: "stake",
    amount: 10,
    expected_out: 5.25,
    expected_out_unit: "alpha",
    spot_price_tao: 2,
    effective_price_tao: 2.01,
    price_impact_pct: 0.42,
    tao_in_pool_tao: 1000,
    alpha_in_pool: 500,
    is_root: false,
  };

  it("returns null for no quote", () => {
    expect(formatQuoteHint(null)).toBeNull();
  });

  it("formats expected output with a price-impact note for a non-root subnet", () => {
    expect(formatQuoteHint(baseQuote)).toBe("≈ 5.25 α · 0.42% price impact");
  });

  it("formats a 1:1 root-subnet note instead of a price-impact percentage", () => {
    expect(
      formatQuoteHint({ ...baseQuote, is_root: true, expected_out_unit: "tao", expected_out: 10 }),
    ).toBe("≈ 10τ · root subnet · 1:1");
  });
});
