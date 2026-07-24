import { afterEach, describe, expect, it } from "vitest";
import { hasIntersectingEntry, hasIntersectionObserverSupport } from "./use-in-view";

describe("hasIntersectionObserverSupport", () => {
  afterEach(() => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it("is false when the runtime has no IntersectionObserver (the SSR/fallback branch)", () => {
    expect(hasIntersectionObserverSupport()).toBe(false);
  });

  it("is true once the runtime provides one", () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
    expect(hasIntersectionObserverSupport()).toBe(true);
  });
});

describe("hasIntersectingEntry", () => {
  it("is false for no entries", () => {
    expect(hasIntersectingEntry([])).toBe(false);
  });

  it("is false when no entry is intersecting", () => {
    expect(hasIntersectingEntry([{ isIntersecting: false }, { isIntersecting: false }])).toBe(
      false,
    );
  });

  it("is true once any entry is intersecting -- the one-shot become-visible trigger", () => {
    expect(hasIntersectingEntry([{ isIntersecting: false }, { isIntersecting: true }])).toBe(true);
  });
});
