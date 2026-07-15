import { describe, it, expect } from "vitest";
import {
  TAKE_PARTS_PER_WHOLE,
  percentToTakeParts,
  takePartsToPercent,
  buildIncreaseTakeParams,
  buildDecreaseTakeParams,
  isDelegateTakeRateLimited,
  delegateTakeCooldownRemainingBlocks,
  formatCooldownDuration,
  validateTakeInputs,
  describeTakeValidationIssue,
} from "./take-extrinsics";

const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("percentToTakeParts", () => {
  it("matches the pallet doc comment's own worked example (1% -> 655)", () => {
    expect(percentToTakeParts(1)).toBe(655);
  });

  it("matches the live-confirmed 18% max (11796 parts)", () => {
    expect(percentToTakeParts(18)).toBe(11_796);
  });

  it("rounds to the nearest representable part", () => {
    expect(percentToTakeParts(0)).toBe(0);
    expect(percentToTakeParts(100)).toBe(TAKE_PARTS_PER_WHOLE);
  });

  it("throws on a non-finite, negative, or out-of-range percentage rather than silently clamping", () => {
    expect(() => percentToTakeParts(NaN)).toThrow(/invalid/i);
    expect(() => percentToTakeParts(-1)).toThrow(/invalid/i);
    expect(() => percentToTakeParts(100.001)).toThrow(/invalid/i);
  });
});

describe("takePartsToPercent", () => {
  it("is the inverse of percentToTakeParts at whole-percent boundaries", () => {
    expect(takePartsToPercent(655)).toBeCloseTo(1, 1);
    expect(takePartsToPercent(11_796)).toBeCloseTo(18, 3);
  });
});

describe("buildIncreaseTakeParams / buildDecreaseTakeParams", () => {
  it("packages the call name and inputs untouched", () => {
    expect(buildIncreaseTakeParams({ hotkey: HOTKEY, take: 1000 })).toEqual({
      call: "increase_take",
      hotkey: HOTKEY,
      take: 1000,
    });
    expect(buildDecreaseTakeParams({ hotkey: HOTKEY, take: 500 })).toEqual({
      call: "decrease_take",
      hotkey: HOTKEY,
      take: 500,
    });
  });
});

describe("isDelegateTakeRateLimited", () => {
  // Mirrors exceeds_tx_delegate_take_rate_limit exactly:
  // rate_limit == 0 || prev_tx_block == 0 -> never blocked;
  // otherwise blocked while (current - prev) <= rate_limit.
  it("is never limited when the rate limit itself is disabled (0)", () => {
    expect(isDelegateTakeRateLimited(100, 200, 0)).toBe(false);
  });

  it("is never limited when the hotkey has never changed its take before (lastTxBlock 0)", () => {
    expect(isDelegateTakeRateLimited(0, 216_000, 216_000)).toBe(false);
  });

  it("is limited exactly at the boundary (current - prev == rate_limit)", () => {
    expect(isDelegateTakeRateLimited(1000, 1000 + 216_000, 216_000)).toBe(true);
  });

  it("is limited just inside the window", () => {
    expect(isDelegateTakeRateLimited(1000, 1000 + 100, 216_000)).toBe(true);
  });

  it("is no longer limited just past the window", () => {
    expect(isDelegateTakeRateLimited(1000, 1000 + 216_001, 216_000)).toBe(false);
  });
});

describe("delegateTakeCooldownRemainingBlocks", () => {
  it("is 0 when not currently limited", () => {
    expect(delegateTakeCooldownRemainingBlocks(0, 1000, 216_000)).toBe(0);
    expect(delegateTakeCooldownRemainingBlocks(1000, 1000 + 216_001, 216_000)).toBe(0);
  });

  it("counts down correctly while limited", () => {
    expect(delegateTakeCooldownRemainingBlocks(1000, 1000 + 50_000, 216_000)).toBe(166_000);
  });
});

describe("formatCooldownDuration", () => {
  it("formats a no-cooldown state distinctly", () => {
    expect(formatCooldownDuration(0)).toBe("no cooldown");
    expect(formatCooldownDuration(-5)).toBe("no cooldown");
  });

  it("formats the full 216000-block rate limit as about 30 days", () => {
    expect(formatCooldownDuration(216_000)).toBe("about 30 days");
  });

  it("tiers down to hours and minutes for shorter remainders", () => {
    expect(formatCooldownDuration(300)).toBe("about 1 hour"); // 3600s
    expect(formatCooldownDuration(10)).toBe("about 2 minutes"); // 120s
    expect(formatCooldownDuration(1)).toBe("less than a minute");
  });
});

describe("validateTakeInputs", () => {
  const base = {
    hotkey: HOTKEY,
    isOwner: true,
    minTakeParts: 0,
    maxTakeParts: 11_796,
    cooldownRemainingBlocks: 0,
  };

  it("passes a valid increase with no issues", () => {
    expect(
      validateTakeInputs({
        ...base,
        direction: "increase",
        takeParts: 1000,
        currentTakeParts: 500,
      }),
    ).toEqual([]);
  });

  it("passes a valid decrease with no issues", () => {
    expect(
      validateTakeInputs({
        ...base,
        direction: "decrease",
        takeParts: 200,
        currentTakeParts: 500,
      }),
    ).toEqual([]);
  });

  it("flags an invalid hotkey and a non-owner wallet together", () => {
    const issues = validateTakeInputs({
      ...base,
      hotkey: "not-a-real-address",
      isOwner: false,
      direction: "increase",
      takeParts: 1000,
      currentTakeParts: 500,
    });
    expect(issues).toContainEqual({ code: "invalid_hotkey" });
    expect(issues).toContainEqual({ code: "not_owner" });
  });

  it("flags below-min and above-max take", () => {
    expect(
      validateTakeInputs({ ...base, direction: "decrease", takeParts: -1, currentTakeParts: 500 }),
    ).toContainEqual({ code: "below_min_take", minTakeParts: 0 });
    expect(
      validateTakeInputs({
        ...base,
        direction: "increase",
        takeParts: 20_000,
        currentTakeParts: 500,
      }),
    ).toContainEqual({ code: "above_max_take", maxTakeParts: 11_796 });
  });

  it("flags a non-strictly-increasing increase and a non-strictly-decreasing decrease", () => {
    expect(
      validateTakeInputs({ ...base, direction: "increase", takeParts: 500, currentTakeParts: 500 }),
    ).toContainEqual({ code: "not_strictly_increasing" });
    expect(
      validateTakeInputs({ ...base, direction: "decrease", takeParts: 500, currentTakeParts: 500 }),
    ).toContainEqual({ code: "not_strictly_decreasing" });
  });

  it("flags rate-limiting only for increase, never for decrease (decrease_take has no rate limit at all)", () => {
    const increaseIssues = validateTakeInputs({
      ...base,
      direction: "increase",
      takeParts: 1000,
      currentTakeParts: 500,
      cooldownRemainingBlocks: 100_000,
    });
    expect(increaseIssues).toContainEqual({ code: "rate_limited", remainingBlocks: 100_000 });

    const decreaseIssues = validateTakeInputs({
      ...base,
      direction: "decrease",
      takeParts: 200,
      currentTakeParts: 500,
      cooldownRemainingBlocks: 100_000,
    });
    expect(decreaseIssues.some((i) => i.code === "rate_limited")).toBe(false);
  });
});

describe("describeTakeValidationIssue", () => {
  it("formats every issue code with human-readable, non-empty copy", () => {
    const issues: Parameters<typeof describeTakeValidationIssue>[0][] = [
      { code: "invalid_hotkey" },
      { code: "not_owner" },
      { code: "below_min_take", minTakeParts: 0 },
      { code: "above_max_take", maxTakeParts: 11_796 },
      { code: "not_strictly_increasing" },
      { code: "not_strictly_decreasing" },
      { code: "rate_limited", remainingBlocks: 216_000 },
    ];
    for (const issue of issues) {
      expect(describeTakeValidationIssue(issue).length).toBeGreaterThan(0);
    }
  });

  it("formats the max-take message using the live-confirmed 18% bound", () => {
    expect(describeTakeValidationIssue({ code: "above_max_take", maxTakeParts: 11_796 })).toContain(
      "18.00%",
    );
  });
});
