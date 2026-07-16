import { describe, expect, it } from "vitest";

import { isMobileWidth } from "./use-mobile";

describe("isMobileWidth", () => {
  it("is mobile strictly below the 768px breakpoint", () => {
    expect(isMobileWidth(0)).toBe(true);
    expect(isMobileWidth(767)).toBe(true);
  });

  it("is not mobile at or above the breakpoint", () => {
    expect(isMobileWidth(768)).toBe(false);
    expect(isMobileWidth(1024)).toBe(false);
  });

  it("honors a custom breakpoint", () => {
    expect(isMobileWidth(500, 480)).toBe(false);
    expect(isMobileWidth(479, 480)).toBe(true);
  });
});
