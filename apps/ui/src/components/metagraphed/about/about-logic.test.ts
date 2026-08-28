import { describe, expect, it } from "vitest";
import {
  COVERAGE_LEVELS,
  CURATION_LEVELS,
  SCOPE_EXCLUSIONS,
  aboutFacts,
  formatAge,
} from "./about-logic";

describe("formatAge", () => {
  it("keeps sub-90s in seconds", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(45.4)).toBe("45s");
    expect(formatAge(89)).toBe("89s");
  });

  it("switches to minutes at 90s and to hours at 90m", () => {
    expect(formatAge(90)).toBe("2m");
    expect(formatAge(60 * 89)).toBe("89m");
    expect(formatAge(60 * 90)).toBe("2h");
  });

  it("switches to days at 48h", () => {
    expect(formatAge(3600 * 47)).toBe("47h");
    expect(formatAge(3600 * 48)).toBe("2d");
    expect(formatAge(3600 * 24 * 9)).toBe("9d");
  });

  it("refuses a negative or non-finite age rather than printing one", () => {
    expect(formatAge(-1)).toBe("—");
    expect(formatAge(Number.NaN)).toBe("—");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("aboutFacts", () => {
  const full = {
    coverage: { netuids_active: 128, curation_level_counts: { "adapter-backed": 2 } },
    health: { ok: 415, total: 512 },
    freshness: { avg_age_seconds: 240 },
  };

  it("reads all four numbers when every source answered", () => {
    expect(aboutFacts(full).map((f) => [f.label, f.value])).toEqual([
      ["Application subnets", "128"],
      ["Adapter-backed", "2"],
      ["Healthy surfaces", "415/512"],
      ["Avg freshness", "4m"],
    ]);
  });

  it("points each fact at the page that explains it", () => {
    expect(aboutFacts(full).map((f) => f.href)).toEqual([
      "/subnets",
      "/apis/providers",
      "/health",
      "/health",
    ]);
  });

  it("returns null per fact rather than a dash, so the caller can tell pending from absent", () => {
    expect(
      aboutFacts({ coverage: null, health: null, freshness: null }).map((f) => f.value),
    ).toEqual([null, null, null, null]);
    expect(
      aboutFacts({ coverage: undefined, health: undefined, freshness: undefined }),
    ).toHaveLength(4);
  });

  it("reads adapter-backed from curation_level_counts, never a top-level key", () => {
    // coverage.adapter_backed does not exist; a page that read it and fell
    // back to first_party_subnet_count reported 73 under an "adapter-backed"
    // label. Neither key is consulted.
    const facts = aboutFacts({
      coverage: { adapter_backed: 9, first_party_subnet_count: 73 },
      health: null,
      freshness: null,
    });
    expect(facts[1].value).toBeNull();
  });

  it("declines a health ratio with a zero denominator", () => {
    const facts = aboutFacts({ coverage: null, health: { ok: 0, total: 0 }, freshness: null });
    expect(facts[2].value).toBeNull();
  });

  it("reports a zero-of-n health ratio, which is a real answer", () => {
    const facts = aboutFacts({ coverage: null, health: { ok: 0, total: 12 }, freshness: null });
    expect(facts[2].value).toBe("0/12");
  });

  it("rejects a non-numeric value from any source", () => {
    const facts = aboutFacts({
      coverage: { netuids_active: "128", curation_level_counts: { "adapter-backed": "2" } },
      health: { ok: "1", total: 2 },
      freshness: { avg_age_seconds: null },
    });
    expect(facts.map((f) => f.value)).toEqual([null, null, null, null]);
  });

  it("reports a zero count, which is not the same as an absent one", () => {
    const facts = aboutFacts({
      coverage: { netuids_active: 0, curation_level_counts: { "adapter-backed": 0 } },
      health: null,
      freshness: { avg_age_seconds: 0 },
    });
    expect(facts[0].value).toBe("0");
    expect(facts[1].value).toBe("0");
    expect(facts[3].value).toBe("0s");
  });
});

describe("taxonomies", () => {
  it("publishes the five curation levels in ladder order", () => {
    expect(CURATION_LEVELS.map((l) => l.name)).toEqual([
      "native",
      "candidate-discovered",
      "machine-verified",
      "maintainer-reviewed",
      "adapter-backed",
    ]);
  });

  it("publishes the three coverage levels in ladder order", () => {
    expect(COVERAGE_LEVELS.map((l) => l.name)).toEqual(["native-only", "manifested", "probed"]);
  });

  it("gives every level a meaning, since a bare vocabulary explains nothing", () => {
    for (const level of [...CURATION_LEVELS, ...COVERAGE_LEVELS]) {
      expect(level.meaning.length).toBeGreaterThan(20);
      expect(level.meaning.endsWith(".")).toBe(true);
    }
  });

  it("states four exclusions, each a full sentence", () => {
    expect(SCOPE_EXCLUSIONS).toHaveLength(4);
    for (const claim of SCOPE_EXCLUSIONS) {
      expect(claim.endsWith(".")).toBe(true);
    }
  });
});
