import { describe, expect, it } from "vitest";
import {
  convictionContest,
  CONVICTION_CONTESTED_GAP_PCT,
  CONVICTION_TAKEOVER_GAP_PCT,
} from "./conviction-contest";

describe("convictionContest", () => {
  it("treats an empty leaderboard as uncontested (no gap)", () => {
    expect(convictionContest([])).toEqual({ gapPct: null, status: "secure" });
  });

  it("treats a single entry (no challenger) as secure with no gap", () => {
    expect(convictionContest([{ conviction: 1000 }])).toEqual({
      gapPct: null,
      status: "secure",
    });
  });

  it("flags a close contest (<=5% gap) as takeover-imminent", () => {
    // leader 1000, challenger 970 -> 3% gap
    const c = convictionContest([{ conviction: 1000 }, { conviction: 970 }]);
    expect(c.status).toBe("takeover-imminent");
    expect(c.gapPct).toBeCloseTo(3);
  });

  it("flags a meaningful challenger (<=25% gap) as contested", () => {
    // leader 1000, challenger 800 -> 20% gap
    const c = convictionContest([{ conviction: 1000 }, { conviction: 800 }]);
    expect(c.status).toBe("contested");
    expect(c.gapPct).toBeCloseTo(20);
  });

  it("flags a wide lead (>25% gap) as secure", () => {
    // leader 1000, challenger 400 -> 60% gap
    const c = convictionContest([{ conviction: 1000 }, { conviction: 400 }]);
    expect(c.status).toBe("secure");
    expect(c.gapPct).toBeCloseTo(60);
  });

  it("is order-agnostic — ranks by conviction, not array position", () => {
    const c = convictionContest([{ conviction: 400 }, { conviction: 1000 }, { conviction: 970 }]);
    // leader 1000, top challenger 970 -> imminent, regardless of input order
    expect(c.status).toBe("takeover-imminent");
    expect(c.gapPct).toBeCloseTo(3);
  });

  it("treats a non-positive leader as uncontested", () => {
    expect(convictionContest([{ conviction: 0 }, { conviction: 0 }])).toEqual({
      gapPct: null,
      status: "secure",
    });
  });

  it("is NaN-safe (non-finite convictions count as 0)", () => {
    const c = convictionContest([{ conviction: 1000 }, { conviction: NaN }]);
    // challenger treated as 0 -> 100% gap -> secure
    expect(c.status).toBe("secure");
    expect(c.gapPct).toBeCloseTo(100);
  });

  it("exposes the documented thresholds", () => {
    expect(CONVICTION_TAKEOVER_GAP_PCT).toBe(5);
    expect(CONVICTION_CONTESTED_GAP_PCT).toBe(25);
  });
});
