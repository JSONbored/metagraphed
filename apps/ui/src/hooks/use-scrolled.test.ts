import { describe, expect, it } from "vitest";

import { isPastScrollThreshold } from "./use-scrolled";

describe("isPastScrollThreshold", () => {
  it("is past only strictly above the default threshold of 4", () => {
    expect(isPastScrollThreshold(0, 4)).toBe(false);
    expect(isPastScrollThreshold(4, 4)).toBe(false);
    expect(isPastScrollThreshold(5, 4)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(isPastScrollThreshold(99, 100)).toBe(false);
    expect(isPastScrollThreshold(100, 100)).toBe(false);
    expect(isPastScrollThreshold(101, 100)).toBe(true);
  });
});
