import { describe, expect, it } from "vitest";
import {
  EXPLORER_LEADERBOARD_IDS,
  EXPLORER_LEADERBOARD_SCROLL_CLASS,
  EXPLORER_LEADERBOARD_TABLE_CLASS,
  EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS,
  explorerLeaderboardScrollClass,
} from "./explorer-leaderboard-layout";

describe("explorer leaderboard layout tokens", () => {
  it("enables horizontal scroll via a dedicated inner wrapper", () => {
    expect(EXPLORER_LEADERBOARD_SCROLL_CLASS).toBe("overflow-x-auto");
  });

  it("keeps the default table full-width inside the scroll shell", () => {
    expect(EXPLORER_LEADERBOARD_TABLE_CLASS).toContain("w-full");
    expect(EXPLORER_LEADERBOARD_TABLE_CLASS).toContain("text-left");
  });

  it("hides the stake-transfer table below md while preserving scroll on tablet+", () => {
    expect(EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS).toContain("hidden");
    expect(EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS).toContain("md:block");
    expect(EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS).toContain("overflow-x-auto");
  });

  it("names all three in-scope leaderboards for stable hooks", () => {
    expect(EXPLORER_LEADERBOARD_IDS).toEqual({
      feePayers: "fee-payers",
      activeAccounts: "active-accounts",
      stakeTransfers: "stake-transfers",
    });
  });

  it("resolves scroll class from visibility mode", () => {
    expect(explorerLeaderboardScrollClass("always")).toBe(EXPLORER_LEADERBOARD_SCROLL_CLASS);
    expect(explorerLeaderboardScrollClass("desktop-only")).toBe(
      EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS,
    );
    expect(explorerLeaderboardScrollClass()).toBe(EXPLORER_LEADERBOARD_SCROLL_CLASS);
  });
});
