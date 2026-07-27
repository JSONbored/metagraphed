import { describe, expect, it } from "vitest";
import { chainActivityTodayUtc, splitChainActivityToday } from "./hero-feature-row";
import type { ChainActivityDay } from "@/lib/metagraphed/types";

function day(d: string, block_count: number): ChainActivityDay {
  return {
    day: d,
    block_count,
    extrinsic_count: 0,
    event_count: 0,
    successful_extrinsics: 0,
    success_rate: null,
    unique_signers: 0,
  };
}

describe("chainActivityTodayUtc", () => {
  it("derives today from the API's own observed_at, not the client clock", () => {
    expect(chainActivityTodayUtc("2026-07-27T16:27:10.973Z")).toBe("2026-07-27");
  });

  it("falls back to the client clock when observed_at is unusable", () => {
    // Not asserting an exact date (that's the client clock, non-deterministic
    // here) -- just that a garbage/missing timestamp never throws or returns
    // an "Invalid Date" string.
    expect(chainActivityTodayUtc("not a date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(chainActivityTodayUtc(null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(chainActivityTodayUtc(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("splitChainActivityToday (#8354)", () => {
  it("excludes today from the drawn series, keeps it for the headline count", () => {
    const oldestFirst = [
      day("2026-07-24", 7180),
      day("2026-07-25", 7201),
      day("2026-07-26", 7194),
      day("2026-07-27", 1853), // today, partial -- far below a full day's count
    ];
    const { fullDayBlockCounts, blocksToday } = splitChainActivityToday(oldestFirst, "2026-07-27");
    // The exact bug: today's low partial count must never appear in the
    // series a chart draws, or it renders as a cliff.
    expect(fullDayBlockCounts).toEqual([7180, 7201, 7194]);
    expect(fullDayBlockCounts).not.toContain(1853);
    expect(blocksToday).toBe(1853);
  });

  it("preserves the input's own order rather than re-sorting", () => {
    // The caller is responsible for ordering (oldest-first for a
    // left-to-right chart); this function must not silently reorder.
    const newestFirst = [day("2026-07-27", 100), day("2026-07-26", 200)];
    const { fullDayBlockCounts } = splitChainActivityToday(newestFirst, "2026-07-27");
    expect(fullDayBlockCounts).toEqual([200]);
  });

  it("returns blocksToday: 0 when today has no row yet, not undefined or NaN", () => {
    const { fullDayBlockCounts, blocksToday } = splitChainActivityToday(
      [day("2026-07-26", 7194)],
      "2026-07-27",
    );
    expect(blocksToday).toBe(0);
    expect(fullDayBlockCounts).toEqual([7194]);
  });

  it("tolerates a null/undefined/empty days list", () => {
    expect(splitChainActivityToday(null, "2026-07-27")).toEqual({
      fullDayBlockCounts: [],
      blocksToday: 0,
    });
    expect(splitChainActivityToday(undefined, "2026-07-27")).toEqual({
      fullDayBlockCounts: [],
      blocksToday: 0,
    });
    expect(splitChainActivityToday([], "2026-07-27")).toEqual({
      fullDayBlockCounts: [],
      blocksToday: 0,
    });
  });

  it("filters out a non-finite block_count from the drawn series", () => {
    const withBadRow = [
      day("2026-07-25", 7180),
      { ...day("2026-07-26", 0), block_count: Number.NaN },
    ];
    const { fullDayBlockCounts } = splitChainActivityToday(withBadRow, "2026-07-27");
    expect(fullDayBlockCounts).toEqual([7180]);
  });
});
