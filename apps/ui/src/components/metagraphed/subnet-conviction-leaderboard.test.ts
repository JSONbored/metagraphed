import { describe, expect, it } from "vitest";

import {
  computeConvictionGap,
  convictionUrgencyTone,
  estimateBlocksToOvertake,
  formatBlocksAsDuration,
} from "./subnet-conviction-leaderboard";
import type { SubnetConvictionEntry } from "@/lib/metagraphed/types";

// #6883: gap% + status badge + rough overtake-time estimate on the conviction
// leaderboard, so a subnet's ownership contest reads as "how urgent" not
// just "who's ahead".

const entry = (
  hotkey: string,
  conviction: number,
  lockedMass = conviction,
): SubnetConvictionEntry => ({
  hotkey,
  is_owner: false,
  locked_mass: lockedMass,
  conviction,
});

describe("computeConvictionGap", () => {
  it("returns null for an empty leaderboard", () => {
    expect(computeConvictionGap([], null)).toBeNull();
  });

  it("returns a null gap for a single-entry (uncontested) leaderboard", () => {
    const king = entry("king", 1000);
    const gap = computeConvictionGap([king], "king");
    expect(gap?.kingEntry.hotkey).toBe("king");
    expect(gap?.runnerUp).toBeNull();
    expect(gap?.gapPct).toBeNull();
  });

  it("computes gap% as a fraction of the king's conviction, not the challenger's", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 900);
    const gap = computeConvictionGap([king, challenger], "king");
    expect(gap?.gapPct).toBeCloseTo(10, 5); // (1000-900)/1000 * 100
  });

  it("a close contest yields a small gap%", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 980);
    const gap = computeConvictionGap([king, challenger], "king");
    expect(gap?.gapPct).toBeCloseTo(2, 5);
  });

  it("a wide gap yields a large gap%", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 100);
    const gap = computeConvictionGap([king, challenger], "king");
    expect(gap?.gapPct).toBeCloseTo(90, 5);
  });

  it("falls back to the top-conviction row when `king` doesn't match any entry", () => {
    const a = entry("a", 1000);
    const b = entry("b", 500);
    const gap = computeConvictionGap([b, a], "unknown-hotkey");
    expect(gap?.kingEntry.hotkey).toBe("a");
    expect(gap?.runnerUp?.hotkey).toBe("b");
  });

  it("clamps a negative gap (king disagreeing with the top row) to 0", () => {
    const low = entry("low", 500);
    const high = entry("high", 1000);
    // `king` points at the LOWER-conviction entry -- a data anomaly.
    const gap = computeConvictionGap([low, high], "low");
    expect(gap?.kingEntry.hotkey).toBe("low");
    expect(gap?.gapPct).toBe(0);
  });
});

describe("convictionUrgencyTone", () => {
  it("is Secure for a null gap (uncontested)", () => {
    expect(convictionUrgencyTone(null).label).toBe("Secure");
  });

  it("is Secure for a wide gap", () => {
    expect(convictionUrgencyTone(50).label).toBe("Secure");
  });

  it("is Contested for a moderate gap", () => {
    expect(convictionUrgencyTone(10).label).toBe("Contested");
  });

  it("is Takeover imminent for a narrow gap", () => {
    expect(convictionUrgencyTone(2).label).toBe("Takeover imminent");
  });

  it("is Takeover imminent for a zero gap", () => {
    expect(convictionUrgencyTone(0).label).toBe("Takeover imminent");
  });
});

describe("estimateBlocksToOvertake", () => {
  it("returns null when maturity_rate is unavailable", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 500, 2000);
    expect(estimateBlocksToOvertake(king, challenger, null)).toBeNull();
  });

  it("returns null when the challenger's own ceiling (locked_mass) can never exceed the king", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 500, 800); // ceiling 800 < king's 1000
    expect(estimateBlocksToOvertake(king, challenger, 934_866)).toBeNull();
  });

  it("returns null when the challenger has already fully matured (no headroom left)", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 2000, 2000); // conviction == locked_mass
    expect(estimateBlocksToOvertake(king, challenger, 934_866)).toBeNull();
  });

  it("returns a positive finite block count for a challenger with real headroom", () => {
    const king = entry("king", 1000);
    const challenger = entry("challenger", 500, 2000);
    const blocks = estimateBlocksToOvertake(king, challenger, 934_866);
    expect(blocks).not.toBeNull();
    expect(blocks as number).toBeGreaterThan(0);
    expect(Number.isFinite(blocks as number)).toBe(true);
  });

  it("a challenger closer to its own ceiling needs fewer blocks than one further away", () => {
    const king = entry("king", 1000);
    // Both start below the king; "close" has less remaining headroom to its
    // own ceiling relative to the gap it must close, so it matures faster.
    const closeChallenger = entry("close", 900, 2000);
    const farChallenger = entry("far", 200, 2000);
    const closeBlocks = estimateBlocksToOvertake(king, closeChallenger, 934_866) as number;
    const farBlocks = estimateBlocksToOvertake(king, farChallenger, 934_866) as number;
    expect(closeBlocks).toBeLessThan(farBlocks);
  });
});

describe("formatBlocksAsDuration", () => {
  it("passes through null", () => {
    expect(formatBlocksAsDuration(null)).toBeNull();
  });

  it("formats sub-day durations as '<1 day'", () => {
    expect(formatBlocksAsDuration(10)).toBe("<1 day");
  });

  it("formats single-digit day durations as '~N day(s)'", () => {
    // 5 days * 86400s / 12s-per-block = 36000 blocks
    expect(formatBlocksAsDuration(36_000)).toBe("~5 days");
  });

  it("singularizes '~1 day'", () => {
    // 1 day * 86400 / 12 = 7200 blocks
    expect(formatBlocksAsDuration(7_200)).toBe("~1 day");
  });

  it("formats month-scale durations as '~N months'", () => {
    // 90 days * 86400 / 12 = 648000 blocks
    expect(formatBlocksAsDuration(648_000)).toBe("~3 months");
  });
});
