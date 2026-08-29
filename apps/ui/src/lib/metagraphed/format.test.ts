import { describe, it, expect } from "vitest";
import {
  deltaCell,
  durationLabel,
  formatAmount,
  formatAmountFixed,
  formatCompact,
  formatCompactAmount,
  formatCompactDelta,
  formatCompactUsd,
  formatDecimal,
  formatNumber,
  formatPct,
  formatRelative,
  formatSignedAmount,
  formatSubnetAge,
  formatTao,
  formatUsdApprox,
  formatUsd,
  humaniseSeconds,
  isStaleFreshness,
  isUsableTimestamp,
  relativeFromDiff,
  subnetAgeDays,
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

  // #6019: tiering is by magnitude (|v|), not v itself, so a negative amount
  // gets the same tier a positive one of equal size would.
  it("tiers negative amounts by magnitude, preserving the sign", () => {
    expect(formatTao(-0.48213)).toBe("-0.4821 τ"); // sub-unit
    expect(formatTao(-256.5)).toBe("-256.50 τ"); // whole-unit, 2dp
    expect(formatTao(-1_000)).toBe("-1.0k τ"); // lower boundary of k-tier
    expect(formatTao(-12_345)).toBe("-12.3k τ");
    expect(formatTao(-999_999)).toBe("-1000.0k τ"); // still < 1e6 → k-tier
    expect(formatTao(-1_000_000)).toBe("-1.00M τ"); // lower boundary of M-tier
    expect(formatTao(-2_500_000)).toBe("-2.50M τ");
  });
});

describe("formatUsdApprox", () => {
  it("returns null when tao or price is missing / non-finite", () => {
    expect(formatUsdApprox(null, 10)).toBeNull();
    expect(formatUsdApprox(1, null)).toBeNull();
    expect(formatUsdApprox(Number.NaN, 10)).toBeNull();
    expect(formatUsdApprox(1, Number.NaN)).toBeNull();
    expect(formatUsdApprox(undefined, undefined)).toBeNull();
  });

  it("formats ≥$1 with 2 decimals and dust with 4", () => {
    expect(formatUsdApprox(2, 5)).toBe("$10");
    expect(formatUsdApprox(1, 1.234)).toBe("$1.23");
    expect(formatUsdApprox(0.01, 5)).toBe("$0.05");
    expect(formatUsdApprox(0.001, 1)).toBe("$0.001");
  });
});

describe("formatUsd", () => {
  it("keeps an observed dollar value distinct from a TAO approximation", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(2685.673993)).toBe("$2,685.67");
    expect(formatUsd(1_300_000)).toBe("$1.30M");
  });

  it("preserves useful sub-dollar precision and a negative sign", () => {
    expect(formatUsd(0.0125)).toBe("$0.0125");
    expect(formatUsd(-15.5)).toBe("−$15.5");
    expect(formatUsd(undefined, "unavailable")).toBe("unavailable");
  });
});

describe("formatCompactUsd", () => {
  it("keeps narrow analytical readings complete instead of clipping them", () => {
    expect(formatCompactUsd(null)).toBe("—");
    expect(formatCompactUsd(999.45)).toBe("$999.45");
    expect(formatCompactUsd(14_734.55)).toBe("$14.7k");
    expect(formatCompactUsd(1_250_000)).toBe("$1.3M");
    expect(formatCompactUsd(3_450_000_000)).toBe("$3.5B");
    expect(formatCompactUsd(-14_734.55)).toBe("−$14.7k");
  });
});

describe("subnetAgeDays", () => {
  it("returns null when either input is nullish or non-finite", () => {
    expect(subnetAgeDays(null, 1000)).toBeNull();
    expect(subnetAgeDays(1000, null)).toBeNull();
    expect(subnetAgeDays(undefined, undefined)).toBeNull();
    expect(subnetAgeDays(Number.NaN, 1000)).toBeNull();
    expect(subnetAgeDays(1000, Number.NaN)).toBeNull();
  });

  it("returns null for a negative delta rather than a nonsensical negative age", () => {
    expect(subnetAgeDays(1000, 500)).toBeNull();
  });

  it("returns 0 for a subnet registered within the last day", () => {
    expect(subnetAgeDays(1000, 1000)).toBe(0);
    // 7199 blocks * 12s = 86,388s, still < 86,400s (1 day)
    expect(subnetAgeDays(0, 7199)).toBe(0);
  });

  it("converts a block delta to whole days at ~12s/block", () => {
    // 7200 blocks * 12s = 86,400s = exactly 1 day
    expect(subnetAgeDays(0, 7_200)).toBe(1);
    // 720,000 blocks * 12s = 8,640,000s = 100 days
    expect(subnetAgeDays(0, 720_000)).toBe(100);
  });
});

describe("formatSubnetAge", () => {
  it("returns the placeholder for null", () => {
    expect(formatSubnetAge(null)).toBe("—");
  });

  it("uses singular phrasing for exactly 1 day", () => {
    expect(formatSubnetAge(1)).toBe("1 day old");
  });

  it("uses plural phrasing for 0 and >1 days", () => {
    expect(formatSubnetAge(0)).toBe("0 days old");
    expect(formatSubnetAge(2)).toBe("2 days old");
    expect(formatSubnetAge(412)).toBe("412 days old");
  });

  it("thousands-separates large day counts via formatNumber", () => {
    expect(formatSubnetAge(1234)).toBe("1,234 days old");
  });
});

describe("formatNumber (#8815)", () => {
  it("returns fallback for nullish / non-finite", () => {
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatNumber(Number.POSITIVE_INFINITY, "n/a")).toBe("n/a");
  });

  it("renders exact zero as 0", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("keeps integers thousands-grouped with no decimal point", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(8739335)).toBe("8,739,335");
  });

  it("allows up to 4 fraction digits for |n| >= 1", () => {
    expect(formatNumber(1234.56789)).toBe("1,234.5679");
    expect(formatNumber(1.2345)).toBe("1.2345");
  });

  it("keeps four significant digits for sub-unit dust so it never collapses to 0", () => {
    expect(formatNumber(0.2985)).toBe("0.2985");
    expect(formatNumber(0.000166248)).toBe("0.0001662");
    expect(formatNumber(0.00003)).toBe("0.00003");
    expect(formatNumber(0.000191022)).toBe("0.000191");
    expect(formatNumber(0.000000001)).toBe("0.000000001");
  });

  it("preserves sign on sub-unit values", () => {
    expect(formatNumber(-0.000166248)).toBe("-0.0001662");
  });

  it("never formats a finite non-zero as the string 0", () => {
    for (const n of [0.000166248, 0.00003, 0.000191022, 0.2985, 1e-12, -1e-9]) {
      expect(formatNumber(n)).not.toBe("0");
    }
  });
});

describe("formatUsdApprox (#8815)", () => {
  it("does not flatten sub-cent USD to $0", () => {
    expect(formatUsdApprox(0.000166248, 1)).not.toBe("$0");
    expect(formatUsdApprox(0.000166248, 1)).toBe("$0.0001662");
  });

  it("keeps 2dp for dollar-scale amounts", () => {
    expect(formatUsdApprox(2.345, 1)).toBe("$2.35");
  });
});

describe("formatPct", () => {
  it("rounds before formatting, so the multiplication's error never reaches the string", () => {
    // 0.57 * 100 === 56.99999999999999 in IEEE-754.
    expect(formatPct(0.57, 2)).toBe("57.00%");
    expect(formatPct(0.57, 1)).toBe("57.0%");
    expect(formatPct(0.57, 0)).toBe("57%");
  });

  it("defaults to one decimal", () => {
    expect(formatPct(0.1234)).toBe("12.3%");
  });

  it("keeps the sign", () => {
    expect(formatPct(-0.045, 1)).toBe("-4.5%");
  });

  it("reports an exact zero rather than the fallback", () => {
    expect(formatPct(0)).toBe("0.0%");
  });

  it("falls back on nullish or non-finite input", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(undefined)).toBe("—");
    expect(formatPct(Number.NaN)).toBe("—");
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatPct(null, 1, "n/a")).toBe("n/a");
  });

  it("handles ratios above 1", () => {
    expect(formatPct(2.5, 0)).toBe("250%");
  });
});

describe("formatCompact", () => {
  it("tiers at a million and at a thousand", () => {
    expect(formatCompact(2_400_000)).toBe("2.40M");
    expect(formatCompact(4_500)).toBe("4.5k");
    expect(formatCompact(812)).toBe("812");
  });

  it("tiers by magnitude, so a negative gets the tier its size deserves", () => {
    expect(formatCompact(-2_000_000)).toBe("-2.00M");
    expect(formatCompact(-4_500)).toBe("-4.5k");
  });

  it("hands sub-thousand values to formatNumber, keeping its grouping", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(0)).toBe("0");
  });

  it("falls back on nullish or non-finite input", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(Number.NaN)).toBe("—");
    expect(formatCompact(undefined, "?")).toBe("?");
  });
});

describe("formatDecimal", () => {
  it("fixes the requested number of decimals", () => {
    expect(formatDecimal(1.005, 2)).toBe("1.00");
    expect(formatDecimal(3, 3)).toBe("3.000");
    expect(formatDecimal(2.5)).toBe("2.50");
  });

  it("guards non-numbers rather than rendering NaN", () => {
    expect(formatDecimal(Number.NaN)).toBe("—");
    expect(formatDecimal(null)).toBe("—");
    expect(formatDecimal(undefined)).toBe("—");
    expect(formatDecimal(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  it("reports zero, which is a number", () => {
    expect(formatDecimal(0, 1)).toBe("0.0");
  });
});

describe("formatAmount / formatAmountFixed / formatSignedAmount", () => {
  it("tiers any unit the way formatTao tiers τ", () => {
    expect(formatAmount(2_400_000, "α")).toBe("2.40M α");
    expect(formatAmount(4_500, "α")).toBe("4.5k α");
    expect(formatAmount(12.5, "α")).toBe("12.50 α");
    expect(formatAmount(0.48213, "α")).toBe("0.4821 α");
  });

  it("agrees with formatTao on τ, which is now defined in terms of it", () => {
    for (const v of [0, 0.5, 1, 999.99, 1_000, 2_400_000, -0.48213, -2_000_000]) {
      expect(formatAmount(v, "τ")).toBe(formatTao(v));
    }
  });

  it("formatAmountFixed keeps the caller's precision and unit", () => {
    expect(formatAmountFixed(12.5, 2)).toBe("12.50 τ");
    expect(formatAmountFixed(12.5, 0, "α")).toBe("13 α");
    expect(formatAmountFixed(null)).toBe("—");
  });

  it("formatSignedAmount marks direction with a typographic minus", () => {
    expect(formatSignedAmount(1_000)).toBe("+1.0k τ");
    expect(formatSignedAmount(-1_000)).toBe("−1.0k τ");
    // U+2212, not the ASCII hyphen.
    expect(formatSignedAmount(-1_000)).toContain("−");
  });

  it("formatSignedAmount leaves an exact zero unsigned", () => {
    expect(formatSignedAmount(0)).toBe("0.0000 τ");
    expect(formatSignedAmount(-0)).toBe("0.0000 τ");
  });

  it("falls back on nullish or non-finite input", () => {
    expect(formatAmount(null, "τ")).toBe("—");
    expect(formatSignedAmount(Number.NaN)).toBe("—");
  });
});

describe("formatCompact never leaks precision below a thousand (#11681)", () => {
  it("caps a non-integer at two decimals", () => {
    // The defect: the home page's emission rail rendered "295.2016 α" beside
    // "5.9k α" because this fell through to formatNumber's four.
    expect(formatCompact(295.2016)).toBe("295.20");
    expect(formatCompact(1.005)).toBe("1.00");
    expect(formatCompact(999.999)).toBe("1000.00");
  });

  it("still renders a whole number bare, which is what a count wants", () => {
    expect(formatCompact(812)).toBe("812");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1)).toBe("1");
  });

  it("keeps significant digits below one, so dust does not round to nothing", () => {
    expect(formatCompact(0.0001662)).toBe("0.0001662");
    expect(formatCompact(0)).toBe("0");
  });

  it("agrees with formatCompactAmount wherever a count and an amount agree", () => {
    // The tiers above a thousand, and any non-integer between one and a
    // thousand, are the same number either way.
    for (const v of [295.2016, 4_500, 2_400_000, -47.5001]) {
      expect(formatCompact(v)).toBe(formatCompactAmount(v));
    }
  });

  it("diverges exactly where a count and an amount should disagree", () => {
    // A whole number: a COUNT of 812 is "812"; an AMOUNT of 812 is "812.00",
    // so a column of amounts keeps its decimal point aligned.
    expect(formatCompact(812)).toBe("812");
    expect(formatCompactAmount(812)).toBe("812.00");
    // Below one: a count keeps significant digits so dust stays visible; an
    // amount pads to the four decimals the rest of its column shows.
    expect(formatCompact(0.5)).toBe("0.5");
    expect(formatCompactAmount(0.5)).toBe("0.5000");
  });

  it("never returns more than two decimals for a magnitude at or above one", () => {
    for (const v of [1.23456, 295.2016, 12.999999, -47.5001, 999.9999]) {
      const decimals = (formatCompact(v).split(".")[1] ?? "").length;
      expect(decimals, `formatCompact(${v}) = ${formatCompact(v)}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("formatCompactDelta", () => {
  it("signs movement and keeps microscopic values complete in narrow columns", () => {
    expect(formatCompactDelta(null)).toBe("—");
    expect(formatCompactDelta(0)).toBe("0");
    expect(formatCompactDelta(5_608.831)).toBe("+5.6k");
    expect(formatCompactDelta(0.003252)).toBe("+3.25e−3");
    expect(formatCompactDelta(0.000000482)).toBe("+4.82e−7");
    expect(formatCompactDelta(-0.00004)).toBe("−4e−5");
  });
});

describe("deltaCell", () => {
  it("labels a rise good when high is better and bad when low is", () => {
    expect(deltaCell(0.42)).toEqual({ text: "+42%", tone: "good" });
    expect(deltaCell(0.42, "low")).toEqual({ text: "+42%", tone: "bad" });
    expect(deltaCell(-0.03)).toEqual({ text: "-3.0%", tone: "bad" });
  });

  it("calls a change under a twentieth of a percent flat, with no tone", () => {
    expect(deltaCell(0.0001)).toEqual({ text: "0%", tone: "neutral" });
  });

  it("has no cell at all when there is no change to state", () => {
    expect(deltaCell(null)).toBeUndefined();
    expect(deltaCell(Number.NaN)).toBeUndefined();
  });
});
