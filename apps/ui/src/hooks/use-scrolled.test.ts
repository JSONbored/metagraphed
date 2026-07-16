import { describe, expect, it } from "vitest";

import { isPastScrollThreshold } from "./use-scrolled";

describe("isPastScrollThreshold", () => {
  it("is not past the default 4px threshold below it", () => {
    expect(isPastScrollThreshold(3, 4)).toBe(false);
  });

  it("is not past the default 4px threshold at it", () => {
    expect(isPastScrollThreshold(4, 4)).toBe(false);
  });

  it("is past the default 4px threshold above it", () => {
    expect(isPastScrollThreshold(5, 4)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(isPastScrollThreshold(100, 200)).toBe(false);
    expect(isPastScrollThreshold(200, 200)).toBe(false);
    expect(isPastScrollThreshold(201, 200)).toBe(true);
  });
});
