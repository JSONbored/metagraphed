import { describe, it, expect } from "vitest";
import { APIS_HUB_PAGE_STEP, ensureIndexVisible } from "./list-page-window";

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
