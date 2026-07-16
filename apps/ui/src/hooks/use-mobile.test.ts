import { describe, expect, it } from "vitest";
import { isMobileWidth, MOBILE_BREAKPOINT } from "./use-mobile";

describe("isMobileWidth", () => {
  it("is true below the breakpoint", () => {
    expect(isMobileWidth(MOBILE_BREAKPOINT - 1)).toBe(true);
    expect(isMobileWidth(320)).toBe(true);
  });

  it("is false at or above the breakpoint", () => {
    expect(isMobileWidth(MOBILE_BREAKPOINT)).toBe(false);
    expect(isMobileWidth(1280)).toBe(false);
  });

  it("respects a custom breakpoint", () => {
    expect(isMobileWidth(900, 1024)).toBe(true);
    expect(isMobileWidth(1024, 1024)).toBe(false);
  });
});
