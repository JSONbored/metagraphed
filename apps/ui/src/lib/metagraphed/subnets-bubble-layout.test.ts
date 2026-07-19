import { describe, expect, it } from "vitest";
import {
  BUBBLE_PAD,
  BUBBLE_VB,
  buildBubbleLayout,
  niceMax,
  subnetAgeDays,
} from "./subnets-bubble-layout";
import type { Subnet } from "./types";

// 7200 blocks/day at ~12s/block.
const BLOCKS_PER_DAY = 7200;

function subnet(over: Partial<Subnet>): Subnet {
  return { netuid: 1, ...over };
}

describe("subnetAgeDays", () => {
  it("converts a block delta to whole floored days", () => {
    expect(subnetAgeDays(1000, 1000 + BLOCKS_PER_DAY * 42)).toBe(42);
    expect(subnetAgeDays(0, BLOCKS_PER_DAY + BLOCKS_PER_DAY / 2)).toBe(1);
    expect(subnetAgeDays(500, 500)).toBe(0);
  });

  it("returns null for reg-ahead-of-current / missing / non-finite blocks", () => {
    expect(subnetAgeDays(2000, 1000)).toBeNull();
    expect(subnetAgeDays(undefined, 1000)).toBeNull();
    expect(subnetAgeDays(1000, null)).toBeNull();
    expect(subnetAgeDays(NaN, 1000)).toBeNull();
    expect(subnetAgeDays(1000, Infinity)).toBeNull();
  });
});

describe("niceMax", () => {
  it("rounds up to a nice axis maximum (a multiple of the value's magnitude)", () => {
    expect(niceMax(5)).toBe(5); // magnitude 1 -> next integer
    expect(niceMax(10)).toBe(10);
    expect(niceMax(11)).toBe(20); // magnitude 10
    expect(niceMax(42)).toBe(50);
    expect(niceMax(250)).toBe(300); // magnitude 100
    expect(niceMax(1)).toBe(1);
  });

  it("floors 0 / negative / non-finite to 1 (never divide by 0)", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(NaN)).toBe(1);
    expect(niceMax(Infinity)).toBe(1);
  });
});

describe("buildBubbleLayout", () => {
  const INNER_W = BUBBLE_VB.w - BUBBLE_PAD.left - BUBBLE_PAD.right;
  const INNER_H = BUBBLE_VB.h - BUBBLE_PAD.top - BUBBLE_PAD.bottom;

  it("drops rows without a computable age or participant count", () => {
    const { points } = buildBubbleLayout([
      subnet({ netuid: 1, registered_at_block: 0, block: BLOCKS_PER_DAY, participants: 10 }), // ok
      subnet({ netuid: 2, participants: 10 }), // no blocks -> no age
      subnet({ netuid: 3, registered_at_block: 0, block: BLOCKS_PER_DAY }), // no participants
      subnet({ netuid: 4, registered_at_block: 5000, block: 1000, participants: 10 }), // reg ahead
    ]);
    expect(points.map((p) => p.netuid)).toEqual([1]);
  });

  it("returns an empty layout (no throw) for no plottable rows", () => {
    expect(buildBubbleLayout([])).toEqual({ points: [], xMax: 1, yMax: 1 });
    expect(buildBubbleLayout([subnet({ participants: 10 })]).points).toEqual([]);
  });

  it("places a single row without dividing by zero", () => {
    const { points, xMax, yMax } = buildBubbleLayout([
      subnet({
        netuid: 7,
        name: "Alpha",
        registered_at_block: 0,
        block: BLOCKS_PER_DAY * 5,
        participants: 100,
        surfaces_count: 3,
        health: "ok",
      }),
    ]);
    expect(points).toHaveLength(1);
    const p = points[0]!;
    expect(p.name).toBe("Alpha"); // uses the provided name (left of the ?? fallback)
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Number.isFinite(p.r)).toBe(true);
    // age 5 with a single row -> xMax = niceMax(5) = 5 -> x at the right edge
    expect(p.x).toBeCloseTo(BUBBLE_PAD.left + (5 / xMax) * INNER_W, 5);
    // single row -> participants == pMax -> max radius
    expect(p.r).toBe(15);
    expect(yMax).toBeGreaterThanOrEqual(1);
  });

  it("handles all-zero ages and all-zero surfaces (both axes clamp to 1)", () => {
    const rows = [1, 2, 3].map((n) =>
      subnet({
        netuid: n,
        registered_at_block: 100,
        block: 100,
        participants: 5,
        surfaces_count: 0,
      }),
    );
    const { points, xMax, yMax } = buildBubbleLayout(rows);
    expect(xMax).toBe(1);
    expect(yMax).toBe(1);
    // age 0 -> x at the left axis; surfaces 0 -> y at the bottom (1 - 0 = full innerH)
    for (const p of points) {
      expect(p.x).toBeCloseTo(BUBBLE_PAD.left, 5);
      expect(p.y).toBeCloseTo(BUBBLE_PAD.top + INNER_H, 5);
    }
  });

  it("maps health state to a colour var and defaults missing health to unknown", () => {
    const { points } = buildBubbleLayout([
      subnet({
        netuid: 1,
        registered_at_block: 0,
        block: BLOCKS_PER_DAY,
        participants: 5,
        health: "warn",
      }),
      subnet({ netuid: 2, registered_at_block: 0, block: BLOCKS_PER_DAY, participants: 5 }), // no health
    ]);
    expect(points[0]!.color).toContain("--health-warn");
    expect(points[1]!.health).toBe("unknown");
    expect(points[1]!.color).toContain("--health-unknown");
  });

  it("scales radius between the min and max by participants", () => {
    const { points } = buildBubbleLayout([
      subnet({ netuid: 1, registered_at_block: 0, block: BLOCKS_PER_DAY, participants: 256 }),
      subnet({ netuid: 2, registered_at_block: 0, block: BLOCKS_PER_DAY, participants: 0 }),
    ]);
    const big = points.find((p) => p.netuid === 1)!;
    const small = points.find((p) => p.netuid === 2)!;
    expect(big.r).toBe(15); // pMax
    expect(small.r).toBe(4); // 0 participants -> R_MIN
  });
});
