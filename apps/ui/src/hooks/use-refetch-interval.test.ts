import { describe, expect, it } from "vitest";

import { computeRefetchInterval } from "./use-refetch-interval";

describe("computeRefetchInterval", () => {
  it("returns the interval when enabled and the tab is visible", () => {
    expect(computeRefetchInterval(true, true, 60_000)).toBe(60_000);
  });

  it("pauses polling when the tab is hidden", () => {
    expect(computeRefetchInterval(true, false, 60_000)).toBe(false);
  });

  it("pauses polling when auto-refresh is disabled", () => {
    expect(computeRefetchInterval(false, true, 30_000)).toBe(false);
    expect(computeRefetchInterval(false, false, 30_000)).toBe(false);
  });
});
