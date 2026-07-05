import { describe, expect, it } from "vitest";

import { resolveInitialDelayedReveal, shouldDelayReveal } from "./use-delayed-reveal";

describe("resolveInitialDelayedReveal", () => {
  it("stays hidden when the reveal gate is off", () => {
    expect(resolveInitialDelayedReveal(false, 120)).toBe(false);
    expect(resolveInitialDelayedReveal(false, 0)).toBe(false);
  });

  it("reveals immediately when delay is zero or negative", () => {
    expect(resolveInitialDelayedReveal(true, 0)).toBe(true);
    expect(resolveInitialDelayedReveal(true, -1)).toBe(true);
  });

  it("starts hidden when a positive delay is configured", () => {
    expect(resolveInitialDelayedReveal(true, 120)).toBe(false);
  });
});

describe("shouldDelayReveal", () => {
  it("arms a timer only for positive delays while the gate is on", () => {
    expect(shouldDelayReveal(true, 120)).toBe(true);
    expect(shouldDelayReveal(true, 1)).toBe(true);
  });

  it("skips the timer when the gate is off or delay is non-positive", () => {
    expect(shouldDelayReveal(false, 120)).toBe(false);
    expect(shouldDelayReveal(true, 0)).toBe(false);
    expect(shouldDelayReveal(true, -5)).toBe(false);
  });
});
