import { describe, it, expect } from "vitest";
import {
  isUsableTimestamp,
  humaniseSeconds,
  durationLabel,
  formatRelative,
  isStaleFreshness,
} from "./format";

describe("isUsableTimestamp", () => {
  it("rejects empty / nullish input", () => {
    expect(isUsableTimestamp(undefined)).toBe(false);
    expect(isUsableTimestamp(null)).toBe(false);
    expect(isUsableTimestamp("")).toBe(false);
  });

  it("rejects unparseable strings", () => {
    expect(isUsableTimestamp("not-a-date")).toBe(false);
  });

  it("rejects the 1970 placeholder and any pre-2000 date", () => {
    expect(isUsableTimestamp("1970-01-01T00:00:00.000Z")).toBe(false);
    expect(isUsableTimestamp("1999-12-31T23:59:59.999Z")).toBe(false);
    // 2000-01-01T00:00:00Z is the cutoff and is NOT > the cutoff (exclusive).
    expect(isUsableTimestamp("2000-01-01T00:00:00.000Z")).toBe(false);
  });

  it("accepts a clearly post-2000 timestamp", () => {
    expect(isUsableTimestamp("2024-06-01T12:00:00.000Z")).toBe(true);
  });
});

describe("humaniseSeconds", () => {
  it("returns the fallback for nullish / non-finite input", () => {
    expect(humaniseSeconds(null)).toBe("—");
    expect(humaniseSeconds(undefined)).toBe("—");
    expect(humaniseSeconds(Number.NaN)).toBe("—");
    expect(humaniseSeconds(Infinity)).toBe("—");
    expect(humaniseSeconds(null, "n/a")).toBe("n/a");
  });

  it("formats sub-minute values in seconds", () => {
    expect(humaniseSeconds(0)).toBe("0s");
    expect(humaniseSeconds(42)).toBe("42s");
    expect(humaniseSeconds(59)).toBe("59s");
    expect(humaniseSeconds(-5)).toBe("0s"); // clamped to 0
  });

  it("formats minutes, adding seconds only below 10m", () => {
    expect(humaniseSeconds(60)).toBe("1m");
    expect(humaniseSeconds(90)).toBe("1m 30s");
    expect(humaniseSeconds(3599)).toBe("59m"); // < 3600 stays in the minutes branch
    expect(humaniseSeconds(630)).toBe("10m"); // >= 10m drops the seconds remainder
  });

  it("formats hours, adding minutes only below 10h", () => {
    expect(humaniseSeconds(3600)).toBe("1h");
    expect(humaniseSeconds(3600 + 39 * 60)).toBe("1h 39m");
    expect(humaniseSeconds(11 * 3600 + 5 * 60)).toBe("11h"); // >= 10h drops minutes
  });

  it("collapses an h-bucket that rounds up to 24h into '1d'", () => {
    // 86399s is < 86400 so enters the hours branch, but rounds to 24h -> "1d".
    expect(humaniseSeconds(86399)).toBe("1d");
  });

  it("formats days, adding hours only below 10d", () => {
    expect(humaniseSeconds(86400)).toBe("1d");
    expect(humaniseSeconds(86400 + 4 * 3600)).toBe("1d 4h");
    expect(humaniseSeconds(11 * 86400 + 5 * 3600)).toBe("11d"); // >= 10d drops hours
  });
});

describe("durationLabel", () => {
  it("returns a dash for missing / unparseable start", () => {
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel("nonsense")).toBe("—");
  });

  it("labels a finite start→end span", () => {
    expect(durationLabel("2024-01-01T00:00:00.000Z", "2024-01-01T00:01:30.000Z")).toBe("1m 30s");
  });

  it("clamps a negative span to zero", () => {
    expect(durationLabel("2024-01-01T00:01:00.000Z", "2024-01-01T00:00:00.000Z")).toBe("0s");
  });

  it("runs to now when end is omitted", () => {
    // ~2s ago start; just assert it produces a seconds-scale label, not a dash.
    const start = new Date(Date.now() - 2000).toISOString();
    expect(durationLabel(start)).toMatch(/^\d+s$/);
  });
});

describe("formatRelative", () => {
  it("returns a dash for unusable timestamps", () => {
    expect(formatRelative(undefined)).toBe("—");
    expect(formatRelative("1970-01-01T00:00:00.000Z")).toBe("—");
  });

  it("labels past timestamps with 'ago' and the right unit", () => {
    expect(formatRelative(new Date(Date.now() - 30_000).toISOString())).toMatch(/^\d+s ago$/);
    expect(formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toMatch(/^\d+m ago$/);
    expect(formatRelative(new Date(Date.now() - 3 * 3_600_000).toISOString())).toMatch(
      /^\d+h ago$/,
    );
    expect(formatRelative(new Date(Date.now() - 2 * 86_400_000).toISOString())).toMatch(
      /^\d+d ago$/,
    );
  });

  it("labels future timestamps with 'in'", () => {
    expect(formatRelative(new Date(Date.now() + 5 * 60_000).toISOString())).toMatch(/^in \d+m$/);
  });
});

describe("isStaleFreshness", () => {
  it("treats unusable timestamps as stale (conservative)", () => {
    expect(isStaleFreshness(undefined)).toBe(true);
    expect(isStaleFreshness("1970-01-01T00:00:00.000Z")).toBe(true);
  });

  it("is fresh within the 12h window and stale past it", () => {
    expect(isStaleFreshness(new Date(Date.now() - 1 * 3_600_000).toISOString())).toBe(false);
    expect(isStaleFreshness(new Date(Date.now() - 11 * 3_600_000).toISOString())).toBe(false);
    expect(isStaleFreshness(new Date(Date.now() - 13 * 3_600_000).toISOString())).toBe(true);
  });

  it("honours a custom threshold", () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(isStaleFreshness(oneHourAgo, 30 * 60_000)).toBe(true);
  });
});
