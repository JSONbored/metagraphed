import { describe, expect, it } from "vitest";
import {
  concentrationTone,
  decentralizationScore,
  fmtCount,
  fmtPct,
  fmtRatio,
  gradeFor,
  scoreSpread,
} from "./decentralization";

describe("concentrationTone", () => {
  it("maps low concentration to ok, mid to warn, high to down", () => {
    expect(concentrationTone(0.2)).toBe("ok");
    expect(concentrationTone(0.5)).toBe("warn");
    expect(concentrationTone(0.9)).toBe("down");
  });
  it("falls back to default on nullish / non-finite input", () => {
    expect(concentrationTone(null)).toBe("default");
    expect(concentrationTone(undefined)).toBe("default");
    expect(concentrationTone(Number.NaN)).toBe("default");
  });
});

describe("scoreSpread", () => {
  it("returns p90 − p10 when both percentiles are present", () => {
    expect(scoreSpread({ p10: 0.2, p90: 0.8 })).toBeCloseTo(0.6);
  });
  it("returns null when a percentile is missing or the distribution is absent", () => {
    expect(scoreSpread({ p10: 0.2 })).toBeNull();
    expect(scoreSpread({ p90: 0.8 })).toBeNull();
    expect(scoreSpread(null)).toBeNull();
    expect(scoreSpread(undefined)).toBeNull();
  });
});

describe("decentralizationScore", () => {
  it("scores a perfectly even distribution at 100", () => {
    const even = { gini: 0, hhi_normalized: 0, top_1pct_share: 0 };
    expect(decentralizationScore(even, even)).toBe(100);
  });
  it("scores a fully concentrated distribution at 0", () => {
    const concentrated = { gini: 1, hhi_normalized: 1, top_1pct_share: 1 };
    expect(decentralizationScore(concentrated, concentrated)).toBe(0);
  });
  it("blends a Nakamoto breadth term normalized by holder count", () => {
    // gini 0.5 → balance 0.5; nakamoto 20 of 100 holders → 20/(100*0.2) = 1.
    expect(decentralizationScore({ gini: 0.5, nakamoto_coefficient: 20, holders: 100 }, null)).toBe(
      75,
    );
  });
  it("ignores a Nakamoto term with no holder base", () => {
    expect(decentralizationScore({ gini: 0.4, nakamoto_coefficient: 5 }, null)).toBe(60);
  });
  it("returns null when no lens carries a usable metric", () => {
    expect(decentralizationScore(null, null)).toBeNull();
    expect(decentralizationScore({}, {})).toBeNull();
    expect(decentralizationScore({ gini: Number.NaN }, undefined)).toBeNull();
  });
});

describe("gradeFor", () => {
  it("maps score bands to letter grades", () => {
    expect(gradeFor(90).letter).toBe("A");
    expect(gradeFor(70).letter).toBe("B");
    expect(gradeFor(55).letter).toBe("C");
    expect(gradeFor(40).letter).toBe("D");
    expect(gradeFor(10).letter).toBe("F");
  });
  it("pairs a health tone with each grade", () => {
    expect(gradeFor(90).tone).toBe("ok");
    expect(gradeFor(55).tone).toBe("warn");
    expect(gradeFor(10).tone).toBe("down");
  });
});

describe("formatters", () => {
  it("formats ratios at fixed precision and dashes on nullish", () => {
    expect(fmtRatio(0.4237)).toBe("0.424");
    expect(fmtRatio(0.5, 2)).toBe("0.50");
    expect(fmtRatio(null)).toBe("—");
    expect(fmtRatio(Number.NaN)).toBe("—");
  });
  it("formats 0–1 shares as percentages", () => {
    expect(fmtPct(0.153)).toBe("15.3%");
    expect(fmtPct(undefined)).toBe("—");
  });
  it("formats counts with separators and dashes on nullish", () => {
    expect(fmtCount(1234)).toBe("1,234");
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(Number.NaN)).toBe("—");
  });
});
