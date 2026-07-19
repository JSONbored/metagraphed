import { describe, expect, it } from "vitest";

import { contestGap } from "./conviction-contest";
import type { SubnetConvictionEntry } from "./types";

function entry(hotkey: string, conviction: number, isOwner = false): SubnetConvictionEntry {
  return { hotkey, is_owner: isOwner, locked_mass: conviction, conviction };
}

describe("contestGap", () => {
  it("is secure with a null gap for an empty leaderboard", () => {
    expect(contestGap([], null)).toEqual({ status: "secure", gapPct: null });
  });

  it("is secure with a null gap when there's no challenger (single entry)", () => {
    const king = entry("5King", 1_000, true);
    expect(contestGap([king], "5King")).toEqual({ status: "secure", gapPct: null });
  });

  it("is takeover-imminent for a close contest (gap below 5%)", () => {
    const king = entry("5King", 1_000, true);
    const challenger = entry("5Chal", 960);
    const result = contestGap([king, challenger], "5King");
    expect(result.status).toBe("takeover-imminent");
    expect(result.gapPct).toBeCloseTo(4, 5);
  });

  it("is contested for a mid-range gap (5-20%)", () => {
    const king = entry("5King", 1_000, true);
    const challenger = entry("5Chal", 850);
    const result = contestGap([king, challenger], "5King");
    expect(result.status).toBe("contested");
    expect(result.gapPct).toBeCloseTo(15, 5);
  });

  it("is secure for a wide gap (>= 20%)", () => {
    const king = entry("5King", 1_000, true);
    const challenger = entry("5Chal", 500);
    const result = contestGap([king, challenger], "5King");
    expect(result.status).toBe("secure");
    expect(result.gapPct).toBeCloseTo(50, 5);
  });

  it("compares the king against the highest non-king entry, not just leaderboard[1]", () => {
    const king = entry("5King", 1_000, true);
    const weak = entry("5Weak", 100);
    const strong = entry("5Strong", 980);
    const result = contestGap([king, weak, strong], "5King");
    expect(result.status).toBe("takeover-imminent");
    expect(result.gapPct).toBeCloseTo(2, 5);
  });

  it("falls back to the highest-conviction entry when king doesn't match any hotkey", () => {
    const top = entry("5Top", 1_000);
    const runnerUp = entry("5Runner", 500);
    const result = contestGap([top, runnerUp], "5Unknown");
    expect(result.status).toBe("secure");
    expect(result.gapPct).toBeCloseTo(50, 5);
  });

  it("is secure with a null gap when the king's conviction is 0", () => {
    const king = entry("5King", 0, true);
    const challenger = entry("5Chal", 0);
    expect(contestGap([king, challenger], "5King")).toEqual({ status: "secure", gapPct: null });
  });
});
