import { describe, expect, it } from "vitest";
import { bubbleRadius, formatShare, packBubbles } from "./subnets-bubble-layout";
import type { Subnet } from "./types";

const R_MIN = 16;
const R_MAX = 90;

function subnet(over: Partial<Subnet>): Subnet {
  return { netuid: 1, ...over };
}

describe("bubbleRadius", () => {
  it("scales area-proportionally (r ∝ sqrt(share)) between the floor and cap", () => {
    expect(bubbleRadius(1, 1)).toBe(R_MAX); // share == max -> cap
    expect(bubbleRadius(0.25, 1)).toBeCloseTo(R_MIN + 0.5 * (R_MAX - R_MIN), 6); // sqrt(0.25)=0.5
    const quarter = bubbleRadius(0.25, 1) - R_MIN;
    const full = bubbleRadius(1, 1) - R_MIN;
    expect(quarter).toBeCloseTo(full / 2, 6); // 4x share -> 2x radius delta -> 4x area
  });

  it("floors non-positive / non-finite share or max to R_MIN (never divide by 0)", () => {
    expect(bubbleRadius(0, 1)).toBe(R_MIN);
    expect(bubbleRadius(-1, 1)).toBe(R_MIN);
    expect(bubbleRadius(NaN, 1)).toBe(R_MIN);
    expect(bubbleRadius(0.5, 0)).toBe(R_MIN);
  });
});

describe("formatShare", () => {
  it("formats a 0..1 fraction as a percent with adaptive precision", () => {
    expect(formatShare(0.0541)).toBe("5.41%"); // <10% -> 2dp
    expect(formatShare(0.1234)).toBe("12.3%"); // >=10% -> 1dp
    expect(formatShare(1)).toBe("100.0%");
  });

  it("renders non-positive / non-finite as 0%", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(-0.2)).toBe("0%");
    expect(formatShare(NaN)).toBe("0%");
    expect(formatShare(Infinity)).toBe("0%");
    expect(formatShare(-Infinity)).toBe("0%");
  });
});

describe("packBubbles", () => {
  it("returns an empty pack (no throw) for no rows", () => {
    expect(packBubbles([])).toEqual({ bubbles: [], width: 0, height: 0 });
  });

  it("sizes bubbles by emission share, biggest first, and packs without overlap", () => {
    const { bubbles, width, height } = packBubbles([
      subnet({ netuid: 1, symbol: "α", name: "One", emission_share: 0.01, health: "ok" }),
      subnet({ netuid: 2, symbol: "β", name: "Two", emission_share: 0.04, health: "warn" }),
      subnet({ netuid: 3, symbol: "γ", name: "Three", emission_share: 0.16, health: "down" }),
    ]);
    // sorted biggest-first by radius (emission share)
    expect(bubbles.map((b) => b.netuid)).toEqual([3, 2, 1]);
    // netuid 3 has the max share -> R_MAX; sqrt scaling gives 2:1 radius deltas
    expect(bubbles[0]!.r).toBe(R_MAX);
    // no two placed bubbles overlap
    for (let i = 0; i < bubbles.length; i += 1) {
      for (let j = i + 1; j < bubbles.length; j += 1) {
        const a = bubbles[i]!;
        const b = bubbles[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1e-6);
      }
    }
    // every bubble lies within the reported 0-origin box
    for (const b of bubbles) {
      expect(b.x - b.r).toBeGreaterThanOrEqual(-1e-6);
      expect(b.y - b.r).toBeGreaterThanOrEqual(-1e-6);
      expect(b.x + b.r).toBeLessThanOrEqual(width + 1e-6);
      expect(b.y + b.r).toBeLessThanOrEqual(height + 1e-6);
    }
  });

  it("places a single row at a valid origin with the max radius", () => {
    const { bubbles, width, height } = packBubbles([
      subnet({ netuid: 7, symbol: "τ", name: "Solo", emission_share: 0.02, health: "ok" }),
    ]);
    expect(bubbles).toHaveLength(1);
    const b = bubbles[0]!;
    expect(b.r).toBe(R_MAX); // sole row -> its share is the max
    expect(b.symbol).toBe("τ");
    expect(b.name).toBe("Solo");
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("falls back for missing symbol/name/health and treats missing share as 0 (R_MIN)", () => {
    const { bubbles } = packBubbles([
      subnet({ netuid: 5, emission_share: 0.03 }), // symbol/name/health missing
    ]);
    const b = bubbles[0]!;
    expect(b.symbol).toBe("#5");
    expect(b.name).toBe("Subnet 5");
    expect(b.health).toBe("unknown");
    expect(b.color).toContain("--health-unknown");
  });

  it("gives zero-emission subnets the floor radius", () => {
    const { bubbles } = packBubbles([
      subnet({ netuid: 1, symbol: "α", emission_share: 0.05, health: "ok" }),
      subnet({ netuid: 2, symbol: "β", emission_share: 0, health: "ok" }),
    ]);
    const zero = bubbles.find((b) => b.netuid === 2)!;
    expect(zero.r).toBe(R_MIN);
  });
});
