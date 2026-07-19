import { describe, expect, it } from "vitest";
import {
  bubbleDomain,
  bubbleRadius,
  layoutBubbles,
  scaleLinear,
  type BubbleInput,
} from "./subnet-bubble-layout";

describe("bubbleDomain", () => {
  it("returns min/max over finite values", () => {
    expect(bubbleDomain([3, 1, 9, 4])).toEqual({ min: 1, max: 9 });
  });

  it("ignores NaN / Infinity and defaults empty input to {0,0}", () => {
    expect(bubbleDomain([NaN, Infinity, 5, -Infinity])).toEqual({ min: 5, max: 5 });
    expect(bubbleDomain([])).toEqual({ min: 0, max: 0 });
  });
});

describe("scaleLinear", () => {
  it("maps the endpoints and midpoint of a domain", () => {
    const d = { min: 0, max: 10 };
    expect(scaleLinear(0, d, 0, 100)).toBe(0);
    expect(scaleLinear(10, d, 0, 100)).toBe(100);
    expect(scaleLinear(5, d, 0, 100)).toBe(50);
  });

  it("clamps out-of-range values into the output band", () => {
    const d = { min: 0, max: 10 };
    expect(scaleLinear(-5, d, 0, 100)).toBe(0);
    expect(scaleLinear(20, d, 0, 100)).toBe(100);
  });

  it("centers a zero-width domain instead of dividing by zero", () => {
    expect(scaleLinear(7, { min: 7, max: 7 }, 0, 100)).toBe(50);
  });
});

describe("bubbleRadius", () => {
  it("uses an area (sqrt) scale between min and max radius", () => {
    const d = { min: 0, max: 100 };
    expect(bubbleRadius(0, d, 4, 20)).toBe(4);
    expect(bubbleRadius(100, d, 4, 20)).toBe(20);
    // 25% of the value is 50% of the radius span (sqrt(0.25) = 0.5).
    expect(bubbleRadius(25, d, 4, 20)).toBe(12);
  });

  it("falls back to the min radius for a zero-width domain", () => {
    expect(bubbleRadius(9, { min: 9, max: 9 }, 4, 20)).toBe(4);
  });
});

describe("layoutBubbles", () => {
  const data: BubbleInput[] = [
    { netuid: 1, x: 0, y: 0, size: 0, health: "ok" },
    { netuid: 2, x: 10, y: 10, size: 100, health: "down" },
  ];

  it("flips the y axis so a higher metric sits nearer the top", () => {
    const nodes = layoutBubbles(data, { minR: 4, maxR: 20 });
    const byUid = Object.fromEntries(nodes.map((n) => [n.netuid, n]));
    expect(byUid[1]!.cy).toBe(100); // lowest surfaces -> bottom
    expect(byUid[2]!.cy).toBe(0); // highest surfaces -> top
    expect(byUid[1]!.cx).toBe(0);
    expect(byUid[2]!.cx).toBe(100);
  });

  it("draws the largest bubble first so small outliers stay clickable on top", () => {
    const nodes = layoutBubbles(data, { minR: 4, maxR: 20 });
    expect(nodes[0]!.netuid).toBe(2); // biggest size -> first in paint order
    expect(nodes[nodes.length - 1]!.netuid).toBe(1);
  });
});
