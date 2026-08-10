// Crowdloan settlement state (#10300).
//
// MET THE CAP AND SETTLED ARE INDEPENDENT. A loan can be full and unsettled
// (funds committed, outcome pending) or settled without ever filling. A single
// "done" badge would tell a contributor their money had settled when it has
// not, which is the one thing a crowdloan view must never get wrong.
import { describe, expect, it } from "vitest";
import { settlementLabel, statusHint } from "./crowdloans-panel";
import type { Crowdloan } from "@/lib/metagraphed/types";

const loan = (percent_raised: number | null, finalized: boolean): Crowdloan => ({
  crowdloan_id: 0,
  creator: null,
  cap_tao: 30,
  raised_tao: 30,
  percent_raised,
  contributors_count: 3,
  end: 6989100,
  finalized,
  has_dispatch_call: false,
  target_address: null,
});

describe("settlementLabel", () => {
  it("full AND finalized is settled", () => {
    expect(settlementLabel(loan(100, true))).toBe("settled");
  });

  it("full but NOT finalized is its own state", () => {
    // The case the four-state split exists for: the cap is met, the money is
    // committed, and nothing has settled.
    expect(settlementLabel(loan(100, false))).toBe("full, unsettled");
  });

  it("finalized without filling is settled SHORT, not simply settled", () => {
    expect(settlementLabel(loan(62, true))).toBe("settled short");
  });

  it("neither is still raising", () => {
    expect(settlementLabel(loan(62, false))).toBe("raising");
  });

  it("an unknown percentage is not treated as full", () => {
    // A null percentage is not 100. Defaulting the unknown direction to full
    // would announce a cap met that was never measured.
    expect(settlementLabel(loan(null, false))).toBe("raising");
    expect(settlementLabel(loan(null, true))).toBe("settled short");
  });

  it("over-subscription counts as full", () => {
    expect(settlementLabel(loan(140, false))).toBe("full, unsettled");
  });
});

describe("statusHint", () => {
  it("spells out the committed-but-unsettled case", () => {
    const hint = statusHint(loan(100, false));
    expect(hint).toContain("NOT finalized");
    expect(hint).toContain("not yet settled");
  });

  it("distinguishes finalized-short from finalized-full", () => {
    expect(statusHint(loan(62, true))).toContain("without reaching its cap");
    expect(statusHint(loan(100, true))).toContain("Reached its cap");
  });
});
