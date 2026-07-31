import { describe, expect, it } from "vitest";
import { exitTotals, type PositionForTotals, type PositionQuoteState } from "./position-totals";

const pos = (isRoot: boolean, spotTao: number): PositionForTotals => ({ isRoot, spotTao });

describe("exitTotals", () => {
  it("excludes an errored non-root position's spot value from the exit total", () => {
    const positions = [pos(false, 100), pos(false, 50)];
    const quotes: PositionQuoteState[] = [
      { phase: "ready", expectedOut: 98 },
      { phase: "error" },
    ];

    const totals = exitTotals(positions, quotes);

    expect(totals.spot).toBe(150);
    expect(totals.exit).toBe(98);
    expect(totals.excludedError).toBe(1);
    expect(totals.excludedPending).toBe(0);
  });

  it("sums expected_out plus root spot when every quote has resolved", () => {
    const positions = [pos(true, 200), pos(false, 100), pos(false, 50)];
    const quotes: PositionQuoteState[] = [
      { phase: "ready", expectedOut: 200 }, // ignored for root; root sums spotTao directly
      { phase: "ready", expectedOut: 97 },
      { phase: "ready", expectedOut: 49 },
    ];

    const totals = exitTotals(positions, quotes);

    expect(totals.exit).toBe(200 + 97 + 49);
    expect(totals.root).toBe(200);
    expect(totals.alpha).toBe(150);
    expect(totals.excludedError).toBe(0);
    expect(totals.excludedPending).toBe(0);
  });

  it("includes a root position with no quote and counts it in neither exclusion", () => {
    const positions = [pos(true, 200)];
    const quotes: PositionQuoteState[] = [{ phase: "pending" }];

    const totals = exitTotals(positions, quotes);

    expect(totals.exit).toBe(200);
    expect(totals.root).toBe(200);
    expect(totals.excludedError).toBe(0);
    expect(totals.excludedPending).toBe(0);
  });

  it("reports a pending non-root quote as pending, not as an error", () => {
    const positions = [pos(false, 100)];
    const quotes: PositionQuoteState[] = [{ phase: "pending" }];

    const totals = exitTotals(positions, quotes);

    expect(totals.exit).toBe(0);
    expect(totals.excludedPending).toBe(1);
    expect(totals.excludedError).toBe(0);
  });
});
