import { describe, expect, it } from "vitest";
import { isScrolledPast } from "./use-scrolled";

describe("isScrolledPast", () => {
  it("is false at or below the threshold", () => {
    expect(isScrolledPast(0, 4)).toBe(false);
    expect(isScrolledPast(4, 4)).toBe(false);
  });

  it("is true once past the threshold", () => {
    expect(isScrolledPast(5, 4)).toBe(true);
    expect(isScrolledPast(200, 4)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isScrolledPast(50, 100)).toBe(false);
    expect(isScrolledPast(101, 100)).toBe(true);
  });
});
