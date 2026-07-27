import { describe, it, expect } from "vitest";
import {
  APIS_HUB_PAGE_STEP,
  ensureIndexVisible,
  nextListLimit,
} from "./list-page-window";

describe("ensureIndexVisible", () => {
  it("leaves the limit alone when the index is already covered", () => {
    expect(ensureIndexVisible(25, 0, 25)).toBe(25);
    expect(ensureIndexVisible(25, 24, 25)).toBe(25);
    expect(ensureIndexVisible(50, 40, 25)).toBe(50);
  });

  it("rounds up to the next step boundary when the index is past the window", () => {
    expect(ensureIndexVisible(25, 25, 25)).toBe(50);
    expect(ensureIndexVisible(25, 49, 25)).toBe(50);
    expect(ensureIndexVisible(25, 50, 25)).toBe(75);
  });

  it("ignores negative indexes and non-positive steps", () => {
    expect(ensureIndexVisible(25, -1, 25)).toBe(25);
    expect(ensureIndexVisible(25, 30, 0)).toBe(25);
  });

  it("exposes the APIs hub step used by schemas/providers", () => {
    expect(APIS_HUB_PAGE_STEP).toBe(25);
  });
});

describe("nextListLimit (filter reset vs deep-link)", () => {
  const step = APIS_HUB_PAGE_STEP;

  it("on filter change, floors at step then expands for a deep-link past page 1", () => {
    // Same tick as a filter reset must not leave the linked row clipped.
    expect(
      nextListLimit({ prev: 75, filtersChanged: true, targetIndex: 40, step }),
    ).toBe(50);
  });

  it("on filter change with no deep-link target, resets to the first page", () => {
    expect(
      nextListLimit({ prev: 100, filtersChanged: true, targetIndex: -1, step }),
    ).toBe(25);
  });

  it("without a filter change, preserves Load more while still expanding for a new target", () => {
    expect(
      nextListLimit({ prev: 50, filtersChanged: false, targetIndex: -1, step }),
    ).toBe(50);
    expect(
      nextListLimit({ prev: 50, filtersChanged: false, targetIndex: 60, step }),
    ).toBe(75);
  });

  it("does not clobber an already-expanded window when the target stays in range", () => {
    expect(
      nextListLimit({ prev: 75, filtersChanged: false, targetIndex: 40, step }),
    ).toBe(75);
  });
});
