import { describe, it, expect } from "vitest";
import {
  isUsableTimestamp,
  humaniseSeconds,
  durationLabel,
  formatRelative,
  relativeFromDiff,
  isStaleFreshness,
  formatTao,
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

describe("relativeFromDiff (#6020 shared time-ago core)", () => {
  it("defaults reproduce formatRelative: 1s floor, 24h→days, future shown as 'in'", () => {
    expect(relativeFromDiff(400)).toBe("1s ago"); // sub-second floored to 1s
    expect(relativeFromDiff(30_000)).toBe("30s ago");
    expect(relativeFromDiff(90 * 60_000)).toBe("2h ago");
    expect(relativeFromDiff(25 * 3_600_000)).toBe("1d ago"); // 24h cap → days
    expect(relativeFromDiff(-5 * 60_000)).toBe("in 5m"); // future surfaced
  });

  it("clampFuture collapses a future diff to the zero point (the freshness stamp's behaviour)", () => {
    expect(relativeFromDiff(-5_000, { clampFuture: true, secondsFloor: 0 })).toBe("0s ago");
    expect(relativeFromDiff(-3_600_000, { clampFuture: true, secondsFloor: 0 })).toBe("0s ago");
  });

  it("secondsFloor 0 allows a bare '0s'; hourCapHours 48 keeps hours to 47h", () => {
    expect(relativeFromDiff(0, { secondsFloor: 0 })).toBe("0s ago");
    expect(relativeFromDiff(47 * 3_600_000, { hourCapHours: 48 })).toBe("47h ago");
    expect(relativeFromDiff(48 * 3_600_000, { hourCapHours: 48 })).toBe("2d ago");
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

describe("formatTao", () => {
  it("returns the em-dash fallback for nullish / non-finite input", () => {
    expect(formatTao(undefined)).toBe("—");
    expect(formatTao(null)).toBe("—");
    expect(formatTao(Number.NaN)).toBe("—");
    expect(formatTao(Infinity)).toBe("—");
    expect(formatTao(-Infinity)).toBe("—");
  });

  it("keeps 4 decimals for zero and sub-unit amounts (< 1)", () => {
    expect(formatTao(0)).toBe("0.0000 τ");
    expect(formatTao(0.5)).toBe("0.5000 τ");
    expect(formatTao(0.48213)).toBe("0.4821 τ");
  });

  it("uses 2 decimals for whole-unit amounts in [1, 1e3)", () => {
    expect(formatTao(1)).toBe("1.00 τ"); // lower boundary — 2dp, not k-tier
    expect(formatTao(256.5)).toBe("256.50 τ");
    expect(formatTao(999.994)).toBe("999.99 τ");
  });

  it("switches to the k-tier at 1e3 and the M-tier at 1e6 (inclusive)", () => {
    expect(formatTao(1_000)).toBe("1.0k τ"); // lower boundary of k-tier
    expect(formatTao(12_345)).toBe("12.3k τ");
    expect(formatTao(999_999)).toBe("1000.0k τ"); // still < 1e6 → k-tier
    expect(formatTao(1_000_000)).toBe("1.00M τ"); // lower boundary of M-tier
    expect(formatTao(2_500_000)).toBe("2.50M τ");
  });
});
