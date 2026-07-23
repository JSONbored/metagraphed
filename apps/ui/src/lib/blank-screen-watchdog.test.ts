import { describe, it, expect, vi } from "vitest";
import {
  isBlank,
  measureRenderedHeight,
  PRE_HYDRATION_RECOVERY_SCRIPT,
} from "./blank-screen-watchdog";

describe("measureRenderedHeight", () => {
  it("returns zeros when the root is null", () => {
    expect(measureRenderedHeight(null)).toEqual({
      visibleHeight: 0,
      childCount: 0,
      visuallyHidden: true,
    });
  });

  it("reads the bounding rect height and childElementCount", () => {
    const el = {
      getBoundingClientRect: () => ({ height: 120 }) as DOMRect,
      childElementCount: 3,
    } as unknown as Element;
    expect(measureRenderedHeight(el)).toEqual({
      visibleHeight: 120,
      childCount: 3,
      visuallyHidden: false,
    });
  });
});

describe("isBlank", () => {
  it("is true when height is under the threshold", () => {
    expect(isBlank({ visibleHeight: 10, childCount: 5, visuallyHidden: false })).toBe(true);
  });
  it("is true when there are zero children even if height is padding", () => {
    expect(isBlank({ visibleHeight: 500, childCount: 0, visuallyHidden: false })).toBe(true);
  });
  it("is false when height and children are both healthy", () => {
    expect(isBlank({ visibleHeight: 500, childCount: 3, visuallyHidden: false })).toBe(false);
  });
  it("is true when CSS hides an otherwise populated root", () => {
    expect(isBlank({ visibleHeight: 500, childCount: 3, visuallyHidden: true })).toBe(true);
  });
});

// Small smoke check that vi is wired — not exercising the mount fn directly
// because it schedules setTimeout side effects best covered by the Playwright
// script under tests/e2e (out of unit scope).
describe("watchdog module surface", () => {
  it("exports the pure helpers", () => {
    expect(typeof isBlank).toBe("function");
    expect(typeof measureRenderedHeight).toBe("function");
    expect(vi).toBeTruthy();
  });

  it("ships an independent pre-hydration recovery handshake", () => {
    expect(PRE_HYDRATION_RECOVERY_SCRIPT).toContain("__MG_HYDRATED__");
    expect(PRE_HYDRATION_RECOVERY_SCRIPT).toContain("unhandledrejection");
    expect(PRE_HYDRATION_RECOVERY_SCRIPT).toContain("location.reload()");
    expect(PRE_HYDRATION_RECOVERY_SCRIPT).not.toContain("document.body.innerHTML");
  });
});
