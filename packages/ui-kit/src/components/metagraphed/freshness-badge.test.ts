import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freshnessBadgeTimeCopy,
  freshnessDotClass,
  freshnessTierLabel,
} from "./freshness-badge";

describe("freshnessTierLabel", () => {
  it("maps realtime to Live and daily to Daily rollup", () => {
    expect(freshnessTierLabel("realtime")).toBe("Live");
    expect(freshnessTierLabel("daily")).toBe("Daily rollup");
  });
});

describe("freshnessDotClass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns unknown when at is missing", () => {
    expect(freshnessDotClass(null)).toBe("bg-health-unknown");
    expect(freshnessDotClass(undefined)).toBe("bg-health-unknown");
  });

  it("returns ok for a fresh timestamp within the threshold", () => {
    const at = new Date("2026-07-09T17:30:00.000Z").toISOString();
    expect(freshnessDotClass(at, 60 * 60_000)).toBe("bg-health-ok");
  });

  it("returns warn for a stale timestamp beyond the threshold", () => {
    const at = new Date("2026-07-09T10:00:00.000Z").toISOString();
    expect(freshnessDotClass(at, 60 * 60_000)).toBe("bg-health-warn");
  });
});

describe("freshnessBadgeTimeCopy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty strings before mount to avoid hydration mismatch", () => {
    expect(freshnessBadgeTimeCopy("2026-07-09T17:00:00.000Z", false)).toEqual({
      absolutePhrase: null,
      relative: "",
    });
  });

  it("renders both absolute and relative forms from the same timestamp", () => {
    const at = "2026-07-09T17:00:00.000Z";
    const copy = freshnessBadgeTimeCopy(at, true);
    expect(copy.absolutePhrase).toBe(`as of ${new Date(at).toLocaleString()}`);
    expect(copy.relative).toMatch(/1h ago/);
  });

  it("omits the absolute phrase but keeps the relative fallback when at is missing", () => {
    expect(freshnessBadgeTimeCopy(null, true)).toEqual({
      absolutePhrase: null,
      relative: "—",
    });
  });
});
