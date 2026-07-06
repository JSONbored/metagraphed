import { describe, expect, it } from "vitest";

import { resolveRefetchInterval } from "./use-refetch-interval";

describe("resolveRefetchInterval", () => {
  it("polls at the given interval when enabled and the tab is visible", () => {
    expect(resolveRefetchInterval(30_000, true, true)).toBe(30_000);
    expect(resolveRefetchInterval(60_000, true, true)).toBe(60_000);
  });

  it("pauses (false) when polling is disabled, regardless of visibility", () => {
    expect(resolveRefetchInterval(30_000, false, true)).toBe(false);
    expect(resolveRefetchInterval(30_000, false, false)).toBe(false);
  });

  it("pauses (false) while the tab is hidden, even when enabled", () => {
    expect(resolveRefetchInterval(30_000, true, false)).toBe(false);
  });
});
