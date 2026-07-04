import { describe, it, expect } from "vitest";
import { relative, formatFreshness, formatFreshnessAbsolute } from "./freshness";

describe("relative", () => {
  it("formats sub-minute spans in seconds, clamping negatives", () => {
    expect(relative(0)).toBe("0s ago");
    expect(relative(5_000)).toBe("5s ago");
    expect(relative(-1000)).toBe("0s ago"); // future clamped to 0
    expect(relative(59_000)).toBe("59s ago");
  });

  it("formats minutes below an hour", () => {
    expect(relative(60_000)).toBe("1m ago");
    expect(relative(59 * 60_000)).toBe("59m ago");
  });

  it("formats hours up to the 48h boundary", () => {
    expect(relative(60 * 60_000)).toBe("1h ago");
    expect(relative(47 * 60 * 60_000)).toBe("47h ago");
  });

  it("switches to days at the 48h boundary", () => {
    // 48h rounds to hr=48 which is NOT < 48, so it falls through to days.
    expect(relative(48 * 60 * 60_000)).toBe("2d ago");
    expect(relative(72 * 60 * 60_000)).toBe("3d ago");
  });
});

describe("formatFreshness", () => {
  it("returns null when nothing is supplied", () => {
    expect(formatFreshness(undefined, undefined)).toBeNull();
    expect(formatFreshness(null, null)).toBeNull();
  });

  it("ignores an unparseable updatedAt but keeps a window label", () => {
    expect(formatFreshness("not-a-date", undefined)).toBeNull();
    expect(formatFreshness("not-a-date", "24h")).toBe("24h window");
  });

  it("emits an 'updated …' clause for a valid timestamp", () => {
    const out = formatFreshness(new Date(Date.now() - 5 * 60_000).toISOString());
    expect(out).toMatch(/^updated \d+m ago$/);
  });

  it("joins the updated clause and the window label", () => {
    const out = formatFreshness(new Date(Date.now() - 30_000).toISOString(), "6h");
    expect(out).toMatch(/^updated \d+s ago · 6h window$/);
  });
});

describe("formatFreshnessAbsolute", () => {
  it("returns null for missing / unparseable input", () => {
    expect(formatFreshnessAbsolute(undefined)).toBeNull();
    expect(formatFreshnessAbsolute("nonsense")).toBeNull();
  });

  it("returns a locale string for a valid timestamp", () => {
    expect(formatFreshnessAbsolute("2024-06-01T12:00:00.000Z")).toBe(
      new Date("2024-06-01T12:00:00.000Z").toLocaleString(),
    );
  });
});
