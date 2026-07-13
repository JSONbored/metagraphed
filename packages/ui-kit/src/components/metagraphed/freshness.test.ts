import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tierFreshnessLabel } from "./freshness";

describe("tierFreshnessLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'No freshness data' when at is missing, for either tier", () => {
    expect(tierFreshnessLabel("realtime", null)).toBe("No freshness data");
    expect(tierFreshnessLabel("daily", undefined)).toBe("No freshness data");
  });

  it("frames realtime data as a live chain read", () => {
    const at = new Date("2026-07-09T17:00:00.000Z").toISOString();
    expect(tierFreshnessLabel("realtime", at)).toMatch(
      /^Live chain read — updated 1h ago$/,
    );
  });

  it("frames daily data as a daily rollup snapshot", () => {
    const at = new Date("2026-07-09T17:00:00.000Z").toISOString();
    expect(tierFreshnessLabel("daily", at)).toMatch(
      /^Daily rollup snapshot — updated 1h ago$/,
    );
  });
});
