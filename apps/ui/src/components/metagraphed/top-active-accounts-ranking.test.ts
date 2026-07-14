import { describe, expect, it } from "vitest";
import {
  TOP_ACTIVE_ACCOUNTS_LIMIT,
  TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS,
  buildTopActiveAccountRows,
  formatTopActiveShare,
} from "./top-active-accounts-ranking";

describe("top-active-accounts ranking (#5315)", () => {
  const sample = [
    { signer: "5AAA", tx_count: 100 },
    { signer: "5BBB", tx_count: 50 },
    { signer: "5CCC", tx_count: 50 },
    { signer: "5DDD", tx_count: 10 },
  ];

  it("exposes the default limit and activity window", () => {
    expect(TOP_ACTIVE_ACCOUNTS_LIMIT).toBe(12);
    expect(TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS).toBe(7);
  });

  it("slices to the requested limit and computes cohort share", () => {
    const rows = buildTopActiveAccountRows(sample, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ ss58: "5AAA", txCount: 100, shareOfTop: 0.5 });
    expect(rows[1].shareOfTop).toBeCloseTo(0.25);
    expect(rows[2].shareOfTop).toBeCloseTo(0.25);
  });

  it("returns an empty list when there are no signers", () => {
    expect(buildTopActiveAccountRows([])).toEqual([]);
  });

  it("clamps a zero limit to an empty slice", () => {
    expect(buildTopActiveAccountRows(sample, 0)).toEqual([]);
  });

  it("formats shares as compact percentages", () => {
    expect(formatTopActiveShare(0)).toBe("0%");
    expect(formatTopActiveShare(0.5)).toBe("50%");
    expect(formatTopActiveShare(1)).toBe("100%");
    expect(formatTopActiveShare(Number.NaN)).toBe("0%");
  });
});
