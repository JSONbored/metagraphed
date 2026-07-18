import { describe, expect, it } from "vitest";
import { FINNEY_BLOCK_SECONDS, formatSubnetAge, subnetAgeDays } from "./subnet-age";

// (currentBlock - registeredAtBlock) * 12s / 86400s-per-day, floored.
// 7200 blocks/day at 12s, so N days == N * 7200 blocks.
const BLOCKS_PER_DAY = SECONDS_PER_DAY_BLOCKS();
function SECONDS_PER_DAY_BLOCKS() {
  return 86_400 / FINNEY_BLOCK_SECONDS; // 7200
}

describe("subnetAgeDays", () => {
  it("converts a block delta to whole days at ~12s/block", () => {
    expect(subnetAgeDays(1000, 1000 + BLOCKS_PER_DAY)).toBe(1);
    expect(subnetAgeDays(1000, 1000 + BLOCKS_PER_DAY * 42)).toBe(42);
  });

  it("floors partial days", () => {
    expect(subnetAgeDays(0, BLOCKS_PER_DAY + BLOCKS_PER_DAY / 2)).toBe(1);
    expect(subnetAgeDays(0, BLOCKS_PER_DAY - 1)).toBe(0);
  });

  it("returns 0 for a same-block registration", () => {
    expect(subnetAgeDays(500, 500)).toBe(0);
  });

  it("returns null when the registration block is ahead of the current block", () => {
    expect(subnetAgeDays(2000, 1000)).toBeNull();
  });

  it("returns null for missing or non-finite inputs", () => {
    expect(subnetAgeDays(null, 1000)).toBeNull();
    expect(subnetAgeDays(1000, undefined)).toBeNull();
    expect(subnetAgeDays(NaN, 1000)).toBeNull();
    expect(subnetAgeDays(1000, Infinity)).toBeNull();
  });

  it("honours a custom block time", () => {
    // at 6s/block, a day is 14400 blocks
    expect(subnetAgeDays(0, 14_400, 6)).toBe(1);
  });
});

describe("formatSubnetAge", () => {
  it("formats singular, plural, and sub-day ages", () => {
    expect(formatSubnetAge(0)).toBe("less than a day old");
    expect(formatSubnetAge(1)).toBe("~1 day old");
    expect(formatSubnetAge(42)).toBe("~42 days old");
  });

  it("thousands-separates large ages", () => {
    expect(formatSubnetAge(1234)).toBe("~1,234 days old");
  });

  it("returns null for a null/invalid age so the field can be omitted", () => {
    expect(formatSubnetAge(null)).toBeNull();
    expect(formatSubnetAge(-5)).toBeNull();
    expect(formatSubnetAge(NaN)).toBeNull();
  });
});
