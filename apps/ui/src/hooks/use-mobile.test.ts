import { describe, expect, it } from "vitest";

import { isMobileWidth } from "./use-mobile";

describe("isMobileWidth", () => {
  it("is mobile below the default 768px breakpoint", () => {
    expect(isMobileWidth(767)).toBe(true);
  });

  it("is not mobile at the default 768px breakpoint", () => {
    expect(isMobileWidth(768)).toBe(false);
  });

  it("is not mobile above the default 768px breakpoint", () => {
    expect(isMobileWidth(1280)).toBe(false);
  });

  it("honors a custom breakpoint", () => {
    expect(isMobileWidth(1023, 1024)).toBe(true);
    expect(isMobileWidth(1024, 1024)).toBe(false);
  });
});
