import { describe, expect, it } from "vitest";

import { summarizeContest } from "./conviction-contest";
import type { SubnetConvictionEntry } from "./types";

function entry(hotkey: string, conviction: number, isOwner = false): SubnetConvictionEntry {
  return { hotkey, is_owner: isOwner, locked_mass: conviction, conviction };
}

describe("summarizeContest", () => {
  it("returns uncontested with no king/challenger for an empty leaderboard", () => {
    expect(summarizeContest([], null)).toEqual({
      status: "uncontested",
      king: null,
      challenger: null,
      gapPct: null,
    });
  });

  it("returns uncontested when there is only the king (no challenger)", () => {
    const king = entry("5King", 1_000, true);
    const result = summarizeContest([king], "5King");
    expect(result.status).toBe("uncontested");
    expect(result.king).toBe(king);
    expect(result.challenger).toBeNull();
    expect(result.gapPct).toBeNull();
  });

  it("flags takeover-imminent when the gap is below 5%", () => {
    const king = entry("5King", 1_000, true);
    const chal = entry("5Chal", 960);
    const result = summarizeContest([king, chal], "5King");
    expect(result.status).toBe("takeover-imminent");
    expect(result.king).toBe(king);
    expect(result.challenger).toBe(chal);
    expect(result.gapPct).toBeCloseTo(4, 5);
  });

  it("flags contested when the gap is in the 5-20% band", () => {
    const king = entry("5King", 1_000, true);
    const chal = entry("5Chal", 850);
    const result = summarizeContest([king, chal], "5King");
    expect(result.status).toBe("contested");
    expect(result.gapPct).toBeCloseTo(15, 5);
  });

  it("flags secure when the gap is 20% or wider", () => {
    const king = entry("5King", 1_000, true);
    const chal = entry("5Chal", 500);
    const result = summarizeContest([king, chal], "5King");
    expect(result.status).toBe("secure");
    expect(result.gapPct).toBeCloseTo(50, 5);
  });

  it("compares the king against the strongest non-king entry, not just leaderboard[1]", () => {
    const king = entry("5King", 1_000, true);
    const weak = entry("5Weak", 100);
    const strong = entry("5Strong", 980);
    const result = summarizeContest([king, weak, strong], "5King");
    expect(result.status).toBe("takeover-imminent");
    expect(result.challenger).toBe(strong);
    expect(result.gapPct).toBeCloseTo(2, 5);
  });

  it("falls back to the highest-conviction entry when `king` matches no hotkey", () => {
    const top = entry("5Top", 1_000);
    const runnerUp = entry("5Runner", 500);
    const result = summarizeContest([top, runnerUp], "5Unknown");
    expect(result.status).toBe("secure");
    expect(result.king).toBe(top);
    expect(result.challenger).toBe(runnerUp);
    expect(result.gapPct).toBeCloseTo(50, 5);
  });

  it("returns uncontested with a null gap when the king's conviction is 0", () => {
    const king = entry("5King", 0, true);
    const chal = entry("5Chal", 0);
    const result = summarizeContest([king, chal], "5King");
    expect(result.status).toBe("uncontested");
    expect(result.king).toBe(king);
    expect(result.challenger).toBe(chal);
    expect(result.gapPct).toBeNull();
  });
});
