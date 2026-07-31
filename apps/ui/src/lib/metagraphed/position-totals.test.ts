import { describe, expect, it } from "vitest";

import { exitTotals, quotePhase } from "./position-totals";

describe("exitTotals", () => {
  // #8819: this is the regression test for the bug -- exit must never fall back to a position's
  // un-slipped spot value when its quote failed (an AMM exit is always <= spot, so padding with
  // spot can only overstate realizable value).
  it("excludes an errored non-root position's spot value from the exit total", () => {
    const positions = [
      { spotTao: 10, isRoot: false },
      { spotTao: 5, isRoot: false },
    ];
    const quoteStates = [
      { phase: "ready" as const, expectedOut: 9.5 },
      { phase: "error" as const, expectedOut: null },
    ];
    const totals = exitTotals(positions, quoteStates);
    expect(totals.exit).toBe(9.5);
    expect(totals.excludedError).toBe(1);
    expect(totals.excludedPending).toBe(0);
  });

  it("sums resolved quotes plus root spot when every quote has resolved", () => {
    const positions = [
      { spotTao: 100, isRoot: true },
      { spotTao: 10, isRoot: false },
      { spotTao: 20, isRoot: false },
    ];
    const quoteStates = [
      { phase: "ready" as const, expectedOut: null }, // root: ignored, spot used instead
      { phase: "ready" as const, expectedOut: 9.5 },
      { phase: "ready" as const, expectedOut: 19.8 },
    ];
    const totals = exitTotals(positions, quoteStates);
    expect(totals.exit).toBe(100 + 9.5 + 19.8);
    expect(totals.excludedError).toBe(0);
    expect(totals.excludedPending).toBe(0);
  });

  it("includes a root position's spot value regardless of its quote state, and never counts it as excluded", () => {
    const positions = [{ spotTao: 42, isRoot: true }];
    const quoteStates = [{ phase: "pending" as const, expectedOut: null }];
    const totals = exitTotals(positions, quoteStates);
    expect(totals.exit).toBe(42);
    expect(totals.root).toBe(42);
    expect(totals.excludedError).toBe(0);
    expect(totals.excludedPending).toBe(0);
  });

  it("reports a pending non-root quote as pending, not as an error", () => {
    const positions = [{ spotTao: 10, isRoot: false }];
    const quoteStates = [{ phase: "pending" as const, expectedOut: null }];
    const totals = exitTotals(positions, quoteStates);
    expect(totals.exit).toBe(0);
    expect(totals.excludedPending).toBe(1);
    expect(totals.excludedError).toBe(0);
  });

  it("keeps spot and alpha behaving exactly as the un-fixed component's own totals did", () => {
    const positions = [
      { spotTao: 100, isRoot: true },
      { spotTao: 10, isRoot: false },
      { spotTao: 20, isRoot: false },
    ];
    const quoteStates = [
      { phase: "ready" as const, expectedOut: null },
      { phase: "error" as const, expectedOut: null },
      { phase: "pending" as const, expectedOut: null },
    ];
    const totals = exitTotals(positions, quoteStates);
    expect(totals.spot).toBe(130);
    expect(totals.root).toBe(100);
    expect(totals.alpha).toBe(30);
  });
});

describe("quotePhase", () => {
  // Regression: a non-root position with an unknown/non-positive alpha price never has its
  // quote query `enabled` (your-positions-panel.tsx), so TanStack Query leaves it `isPending`
  // forever and statPhase() would report "pending" indefinitely -- quotePhase must turn that
  // into "error" so the aggregate tile can't get stuck rendering a skeleton forever.
  it("reports 'error' for a non-root position with no positive alpha, regardless of query phase", () => {
    expect(quotePhase({ isRoot: false, alpha: null }, "pending")).toBe("error");
    expect(quotePhase({ isRoot: false, alpha: 0 }, "pending")).toBe("error");
    expect(quotePhase({ isRoot: false, alpha: -1 }, "pending")).toBe("error");
  });

  it("passes the query phase through unchanged for a quotable non-root position", () => {
    expect(quotePhase({ isRoot: false, alpha: 5 }, "pending")).toBe("pending");
    expect(quotePhase({ isRoot: false, alpha: 5 }, "error")).toBe("error");
    expect(quotePhase({ isRoot: false, alpha: 5 }, "ready")).toBe("ready");
  });

  it("passes the query phase through unchanged for a root position (no alpha, but not unquotable)", () => {
    expect(quotePhase({ isRoot: true, alpha: null }, "pending")).toBe("pending");
    expect(quotePhase({ isRoot: true, alpha: null }, "ready")).toBe("ready");
  });
});
