// The network-wide holder leaderboard (#10300).
//
// The route publishes 7d, 30d and 90d net flows because they can disagree: an
// account can be growing over the week and shrinking over the quarter. Showing
// one window as "the" direction is how a short bounce reads as a trend, so the
// panel marks the accounts whose windows do not agree — and that marker has to
// be right in both directions to be worth anything.
import { describe, expect, it } from "vitest";
import { flowsDisagree, flowTooltip } from "./top-holders-panel";
import type { TopHolder } from "@/lib/metagraphed/types";

const holder = (
  net_flow_7d: number | null,
  net_flow_30d: number | null,
  net_flow_90d: number | null,
): TopHolder => ({
  ss58: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  free_tao: 100,
  delegated_tao: 900,
  total_tao: 1000,
  net_flow_7d,
  net_flow_30d,
  net_flow_90d,
});

describe("flowsDisagree", () => {
  it("all three rising is agreement", () => {
    expect(flowsDisagree(holder(10, 20, 30))).toBe(false);
  });

  it("all three falling is agreement", () => {
    expect(flowsDisagree(holder(-10, -20, -30))).toBe(false);
  });

  it("growing on the week, shrinking on the quarter IS a disagreement", () => {
    // The case the marker exists for.
    expect(flowsDisagree(holder(10, 5, -40))).toBe(true);
  });

  it("a MISSING window is not a disagreement", () => {
    // Otherwise every account with a gap in its history gets a caveat marker,
    // and a marker that fires on missing data stops meaning "these disagree".
    expect(flowsDisagree(holder(null, 20, 30))).toBe(false);
    expect(flowsDisagree(holder(null, null, null))).toBe(false);
  });

  it("zero is its own direction, not folded into up", () => {
    // No movement genuinely differs from movement. Treating 0 as positive
    // would hide a real split between a flat week and a falling quarter.
    expect(flowsDisagree(holder(0, 0, 0))).toBe(false);
    expect(flowsDisagree(holder(0, -5, -5))).toBe(true);
  });

  it("a non-finite flow is treated as missing, not as a direction", () => {
    expect(flowsDisagree(holder(Number.NaN, 20, 30))).toBe(false);
  });
});

describe("flowTooltip", () => {
  it("names all three windows, so one number is never read as the direction", () => {
    const tip = flowTooltip(holder(10, -5, -40));
    expect(tip).toContain("7d");
    expect(tip).toContain("30d");
    expect(tip).toContain("90d");
  });

  it("an absent window renders as absent, not as zero", () => {
    // A missing flow is not a flat one — 0 would be a claim about movement.
    expect(flowTooltip(holder(null, 20, 30))).toContain("7d: —");
  });
});
