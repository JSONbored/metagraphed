import { describe, expect, it } from "vitest";

import {
  CONTESTED_MAX_PCT,
  TAKEOVER_IMMINENT_MAX_PCT,
  rowGapPct,
  summarizeContest,
} from "./conviction-contest";
import type { SubnetConvictionEntry } from "./types";

const entry = (
  over: Partial<SubnetConvictionEntry> & { hotkey: string },
): SubnetConvictionEntry => ({
  is_owner: false,
  locked_mass: 0,
  conviction: 0,
  ...over,
});

describe("summarizeContest", () => {
  it("returns an uncontested summary for an empty leaderboard", () => {
    expect(summarizeContest([], null)).toEqual({
      status: "uncontested",
      king: null,
      challenger: null,
      gapPct: null,
    });
  });

  it("returns an uncontested summary when only the king is present", () => {
    const king = entry({ hotkey: "5A", conviction: 1_000, is_owner: true });
    expect(summarizeContest([king], "5A")).toEqual({
      status: "uncontested",
      king,
      challenger: null,
      gapPct: null,
    });
  });

  it("falls back to the first leaderboard entry when king is not in the list", () => {
    const first = entry({ hotkey: "5A", conviction: 900 });
    const second = entry({ hotkey: "5B", conviction: 100 });
    // king="5Z" absent -> first entry is treated as king; runner-up is second.
    const summary = summarizeContest([first, second], "5Z");
    expect(summary.king).toBe(first);
    expect(summary.challenger).toBe(second);
    expect(summary.status).toBe("secure"); // 89% gap
  });

  it("marks the contest as takeover-imminent when the gap is well within threshold", () => {
    const king = entry({ hotkey: "5A", conviction: 1_000 });
    const challenger = entry({ hotkey: "5B", conviction: 980 });
    const summary = summarizeContest([king, challenger], "5A");
    expect(summary.status).toBe("takeover-imminent");
    expect(summary.gapPct).toBeCloseTo(2);
  });

  it("marks the contest as contested when the gap is between the two thresholds", () => {
    const king = entry({ hotkey: "5A", conviction: 1_000 });
    const challenger = entry({ hotkey: "5B", conviction: 850 });
    const summary = summarizeContest([king, challenger], "5A");
    expect(summary.status).toBe("contested");
    expect(summary.gapPct).toBeCloseTo(15);
  });

  it("marks the contest as secure when the gap is comfortably beyond threshold", () => {
    const king = entry({ hotkey: "5A", conviction: 1_000 });
    const challenger = entry({ hotkey: "5B", conviction: 500 });
    const summary = summarizeContest([king, challenger], "5A");
    expect(summary.status).toBe("secure");
    expect(summary.gapPct).toBeCloseTo(50);
  });

  it("treats an exact takeover threshold as takeover-imminent (inclusive lower band)", () => {
    const king = entry({ hotkey: "5A", conviction: 100 });
    const challenger = entry({ hotkey: "5B", conviction: 100 - TAKEOVER_IMMINENT_MAX_PCT });
    expect(summarizeContest([king, challenger], "5A").status).toBe("takeover-imminent");
  });

  it("treats an exact contested threshold as contested (inclusive upper band)", () => {
    const king = entry({ hotkey: "5A", conviction: 100 });
    const challenger = entry({ hotkey: "5B", conviction: 100 - CONTESTED_MAX_PCT });
    expect(summarizeContest([king, challenger], "5A").status).toBe("contested");
  });

  it("leaves gapPct null and marks contested when the king's conviction is zero", () => {
    const king = entry({ hotkey: "5A", conviction: 0 });
    const challenger = entry({ hotkey: "5B", conviction: 0 });
    const summary = summarizeContest([king, challenger], "5A");
    expect(summary.status).toBe("contested");
    expect(summary.gapPct).toBeNull();
  });

  it("finds the challenger even when the leaderboard is not sorted", () => {
    const challenger = entry({ hotkey: "5B", conviction: 300 });
    const king = entry({ hotkey: "5A", conviction: 1_000 });
    const summary = summarizeContest([challenger, king], "5A");
    expect(summary.king).toBe(king);
    expect(summary.challenger).toBe(challenger);
    expect(summary.status).toBe("secure");
  });
});

describe("rowGapPct", () => {
  const king = entry({ hotkey: "5A", conviction: 1_000 });

  it("returns null for the king row", () => {
    expect(rowGapPct(king, king)).toBeNull();
  });

  it("returns null when there is no king", () => {
    expect(rowGapPct(entry({ hotkey: "5B", conviction: 500 }), null)).toBeNull();
  });

  it("returns null when the king's conviction is zero", () => {
    const zeroKing = entry({ hotkey: "5A", conviction: 0 });
    expect(rowGapPct(entry({ hotkey: "5B", conviction: 0 }), zeroKing)).toBeNull();
  });

  it("returns the percent gap for a challenger below the king", () => {
    expect(rowGapPct(entry({ hotkey: "5B", conviction: 900 }), king)).toBeCloseTo(10);
    expect(rowGapPct(entry({ hotkey: "5C", conviction: 500 }), king)).toBeCloseTo(50);
  });
});
