// Tests for src/weekly-digest.ts (#8705 PR 1).
//
// The ISO-week cases below are real calendar facts, verified against the
// definition (week 1 contains the first Thursday; weeks run Monday–Sunday),
// not invented: 2027-01-01 is a Friday and belongs to 2026-W53, and
// 2026-01-01 is a Thursday so it belongs to 2026-W01. A digest URL that
// disagrees with its own contents once a year is exactly what this prevents.

import { describe, expect, it } from "vitest";
import {
  buildWeeklyDigest,
  evaluateThreshold,
  findUngroundedLanguage,
  isoWeek,
  isSubstantive,
  itemsForWeek,
  MIN_SUBSTANTIVE_ITEMS,
  parseWeekSlug,
  validateGrounding,
  weekSlug,
  type DigestSourceItem,
} from "../src/weekly-digest.ts";

function item(
  id: string,
  timestamp: string,
  tags: string[] = ["chain", "release"],
): DigestSourceItem {
  return {
    id,
    url: `https://metagraph.sh/x/${id}`,
    title: `Item ${id}`,
    summary: `Summary ${id}`,
    timestamp,
    tags,
  };
}

const WEEK_ITEMS = [
  item("a", "2026-07-27T10:00:00.000Z"),
  item("b", "2026-07-28T10:00:00.000Z", ["chain", "hyperparam"]),
  item("c", "2026-07-29T10:00:00.000Z", ["chain", "governance", "ownership"]),
];

describe("isoWeek", () => {
  it("puts a date in the ISO year of its own Thursday", () => {
    // 2027-01-01 is a Friday; its week's Thursday is 2026-12-31, so the ISO
    // year is 2026 even though the calendar year is 2027.
    expect(isoWeek("2027-01-01T00:00:00.000Z")).toEqual({
      year: 2026,
      week: 53,
    });
    // 2026-01-01 is a Thursday, so it is in week 1 of 2026.
    expect(isoWeek("2026-01-01T00:00:00.000Z")).toEqual({
      year: 2026,
      week: 1,
    });
  });

  it("treats Sunday as the last day of its week, not the first", () => {
    // 2026-07-26 is a Sunday and 2026-07-27 a Monday: different weeks.
    const sunday = isoWeek("2026-07-26T23:59:59.000Z");
    const monday = isoWeek("2026-07-27T00:00:00.000Z");
    expect(sunday?.week).toBe((monday?.week ?? 0) - 1);
  });

  it("accepts a Date, an epoch, and an ISO string alike", () => {
    const expected = { year: 2026, week: 31 };
    expect(isoWeek(new Date("2026-07-29T00:00:00.000Z"))).toEqual(expected);
    expect(isoWeek(Date.parse("2026-07-29T00:00:00.000Z"))).toEqual(expected);
    expect(isoWeek("2026-07-29T00:00:00.000Z")).toEqual(expected);
  });

  it("handles a year whose 4 January falls on a Sunday", () => {
    // 2032-01-04 is a Sunday — the branch where the ISO day must be read as 7
    // rather than 0. That year's week 1 runs 2031-12-29 to 2032-01-04.
    expect(isoWeek("2032-01-04T00:00:00.000Z")).toEqual({
      year: 2032,
      week: 1,
    });
    expect(isoWeek("2032-01-05T00:00:00.000Z")).toEqual({
      year: 2032,
      week: 2,
    });
  });

  it("handles a year whose 4 January is a weekday", () => {
    // The mirror of the case above: 2027-01-04 is a Monday, so the ISO-day
    // normalisation takes its other branch. Both 2026 and 2032 happen to have
    // 4 January on a Sunday, so without a year like this one half of that
    // normalisation is never exercised.
    expect(isoWeek("2027-01-04T00:00:00.000Z")).toEqual({
      year: 2027,
      week: 1,
    });
    expect(isoWeek("2027-06-01T00:00:00.000Z")).toEqual({
      year: 2027,
      week: 22,
    });
  });

  it("returns null for anything undatable", () => {
    expect(isoWeek("not-a-date")).toBeNull();
    expect(isoWeek(Number.NaN)).toBeNull();
    expect(isoWeek("")).toBeNull();
  });
});

describe("weekSlug / parseWeekSlug", () => {
  it("zero-pads so slugs sort lexicographically", () => {
    expect(weekSlug(2026, 3)).toBe("2026-w03");
    expect(weekSlug(2026, 31)).toBe("2026-w31");
    expect(["2026-w31", "2026-w03"].sort()).toEqual(["2026-w03", "2026-w31"]);
  });

  it("round-trips", () => {
    expect(parseWeekSlug(weekSlug(2026, 53))).toEqual({ year: 2026, week: 53 });
  });

  it("rejects impossible or malformed weeks", () => {
    // Week 0 and 54+ are never valid in ISO-8601.
    expect(parseWeekSlug("2026-w00")).toBeNull();
    expect(parseWeekSlug("2026-w54")).toBeNull();
    expect(parseWeekSlug("2026-w3")).toBeNull();
    expect(parseWeekSlug("2026-31")).toBeNull();
    expect(parseWeekSlug(null)).toBeNull();
    expect(parseWeekSlug(202631)).toBeNull();
  });
});

describe("itemsForWeek", () => {
  it("selects by the item's own timestamp, newest first", () => {
    const mixed = [...WEEK_ITEMS, item("old", "2026-07-01T10:00:00.000Z")];
    const selected = itemsForWeek(mixed, 2026, 31);
    expect(selected.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("drops undatable items rather than bucketing them arbitrarily", () => {
    expect(
      itemsForWeek([item("x", "nope"), ...WEEK_ITEMS], 2026, 31),
    ).toHaveLength(3);
  });

  it("is total over degenerate input", () => {
    expect(itemsForWeek(null, 2026, 31)).toEqual([]);
    expect(itemsForWeek([], 2026, 31)).toEqual([]);
  });
});

describe("isSubstantive / evaluateThreshold", () => {
  it("counts real changes and ignores our own pipeline churn", () => {
    // An artifact we regenerated is activity in OUR pipeline, not the
    // subnet's — a week whose only news is that is the thin page the
    // threshold exists to prevent.
    expect(isSubstantive(item("r", "2026-07-27T00:00:00Z", ["release"]))).toBe(
      true,
    );
    expect(
      isSubstantive(
        item("a", "2026-07-27T00:00:00Z", ["registry", "artifact"]),
      ),
    ).toBe(false);
    expect(
      isSubstantive(
        item("c", "2026-07-27T00:00:00Z", ["registry", "coverage"]),
      ),
    ).toBe(false);
    expect(isSubstantive(null)).toBe(false);
    expect(
      isSubstantive({
        ...item("x", "2026-07-27T00:00:00Z"),
        tags: null as never,
      }),
    ).toBe(false);
  });

  it("publishes at the threshold and refuses below it", () => {
    expect(evaluateThreshold(WEEK_ITEMS).publish).toBe(true);
    expect(evaluateThreshold(WEEK_ITEMS.slice(0, 2)).publish).toBe(false);
    expect(evaluateThreshold(WEEK_ITEMS.slice(0, 2)).substantive_count).toBe(2);
  });

  it("does not let a duplicated item buy its way past the threshold", () => {
    const dupes = [WEEK_ITEMS[0], { ...WEEK_ITEMS[0] }, { ...WEEK_ITEMS[0] }];
    expect(evaluateThreshold(dupes).publish).toBe(false);
    expect(evaluateThreshold(dupes).substantive_count).toBe(1);
  });

  it("explains itself rather than returning a bare boolean", () => {
    expect(evaluateThreshold(WEEK_ITEMS.slice(0, 1)).reason).toBe(
      `below threshold: 1 substantive item(s), need ${MIN_SUBSTANTIVE_ITEMS}`,
    );
    expect(evaluateThreshold(WEEK_ITEMS).reason).toBe("3 substantive item(s)");
  });

  it("honours an explicit minimum and is total", () => {
    expect(evaluateThreshold(WEEK_ITEMS, 4).publish).toBe(false);
    expect(evaluateThreshold(WEEK_ITEMS, 1).publish).toBe(true);
    expect(evaluateThreshold(null).publish).toBe(false);
  });
});

describe("validateGrounding", () => {
  const draft = {
    netuid: 8,
    year: 2026,
    week: 31,
    sentences: [
      { text: "Subnet 8 published release v1.2.0.", citations: ["a"] },
      { text: "Its tempo changed from 360 to 720.", citations: ["b"] },
    ],
  };

  it("accepts a fully cited draft", () => {
    expect(validateGrounding(draft, WEEK_ITEMS)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects an uncited sentence and names it", () => {
    // The central rule: one uncited claim and the digest does not ship.
    const bad = {
      ...draft,
      sentences: [
        ...draft.sentences,
        { text: "The subnet is growing steadily.", citations: [] },
      ],
    };
    const result = validateGrounding(bad, WEEK_ITEMS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("no citation");
    expect(result.errors[0]).toContain("The subnet is growing steadily.");
  });

  it("rejects a citation that does not resolve", () => {
    // A generator inventing an item id is the failure this catches.
    const bad = {
      ...draft,
      sentences: [{ text: "Something happened.", citations: ["nonexistent"] }],
    };
    const result = validateGrounding(bad, WEEK_ITEMS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("does not resolve");
  });

  it("rejects empty text and an empty draft", () => {
    expect(
      validateGrounding(
        { ...draft, sentences: [{ text: "   ", citations: ["a"] }] },
        WEEK_ITEMS,
      ).errors[0],
    ).toContain("empty text");
    expect(
      validateGrounding({ ...draft, sentences: [] }, WEEK_ITEMS).errors,
    ).toEqual(["digest has no sentences"]);
    expect(validateGrounding(null, WEEK_ITEMS).ok).toBe(false);
  });

  it("rejects a non-string sentence body and a non-array citations field", () => {
    // A generator emitting the wrong shape must be refused, not coerced.
    expect(
      validateGrounding(
        { ...draft, sentences: [{ text: 7 as never, citations: ["a"] }] },
        WEEK_ITEMS,
      ).errors[0],
    ).toContain("empty text");
    expect(
      validateGrounding(
        { ...draft, sentences: [{ text: "x", citations: "a" as never }] },
        WEEK_ITEMS,
      ).errors[0],
    ).toContain("no citation");
  });

  it("rejects a non-string citation", () => {
    const bad = {
      ...draft,
      sentences: [{ text: "Something.", citations: [7 as never] }],
    };
    expect(validateGrounding(bad, WEEK_ITEMS).ok).toBe(false);
  });

  it("truncates a long sentence in the error rather than dumping it", () => {
    const long = "x".repeat(200);
    const errors = validateGrounding(
      { ...draft, sentences: [{ text: long, citations: [] }] },
      WEEK_ITEMS,
    ).errors;
    expect(errors[0].length).toBeLessThan(150);
    expect(errors[0]).toContain("…");
  });

  it("is total when the item list is missing", () => {
    expect(validateGrounding(draft, null).ok).toBe(false);
    expect(
      validateGrounding(
        { ...draft, sentences: [{ text: "x", citations: [] }] },
        [{ ...WEEK_ITEMS[0], id: "" }],
      ).ok,
    ).toBe(false);
  });
});

describe("findUngroundedLanguage", () => {
  it("catches momentum, sentiment and price commentary", () => {
    // A sentence can be perfectly cited and still say something no item
    // supports. This is the separate check for that.
    const found = findUngroundedLanguage({
      netuid: 8,
      year: 2026,
      week: 31,
      sentences: [
        {
          text: "SN8 is poised for growth and looks undervalued.",
          citations: ["a"],
        },
        { text: "Emissions surged this week.", citations: ["b"] },
      ],
    });
    expect(found).toEqual(["poised", "surged", "undervalued"]);
  });

  it("matches whole words only", () => {
    // "rally" must not fire on "rallying point" being absent, nor should a
    // term embedded in a longer word trigger.
    expect(
      findUngroundedLanguage({
        netuid: null,
        year: 2026,
        week: 31,
        sentences: [
          { text: "The registry was insurged nowhere.", citations: ["a"] },
        ],
      }),
    ).toEqual([]);
  });

  it("matches a multi-word term across whitespace", () => {
    expect(
      findUngroundedLanguage({
        netuid: null,
        year: 2026,
        week: 31,
        sentences: [{ text: "It is expected  to ship.", citations: ["a"] }],
      }),
    ).toEqual(["expected to"]);
  });

  it("passes clean reporting prose", () => {
    expect(
      findUngroundedLanguage({
        netuid: 8,
        year: 2026,
        week: 31,
        sentences: [
          {
            text: "Subnet 8 published release v1.2.0 on 27 July.",
            citations: ["a"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("is total over degenerate input", () => {
    expect(findUngroundedLanguage(null)).toEqual([]);
    expect(
      findUngroundedLanguage({
        netuid: null,
        year: 2026,
        week: 31,
        sentences: [{ text: null as never, citations: [] }],
      }),
    ).toEqual([]);
  });
});

describe("buildWeeklyDigest", () => {
  const generatedAt = "2026-08-03T00:00:00.000Z";
  const draft = {
    netuid: 8,
    year: 2026,
    week: 31,
    sentences: [
      { text: "Subnet 8 published a release.", citations: ["a"] },
      { text: "Its tempo changed.", citations: ["b"] },
    ],
  };

  it("publishes a grounded, above-threshold week", () => {
    const result = buildWeeklyDigest({
      draft,
      items: WEEK_ITEMS,
      generatedAt,
    });
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBeNull();
    expect(result.digest?.slug).toBe("2026-w31");
    expect(result.digest?.substantive_count).toBe(3);
  });

  it("produces NO page for a quiet week", () => {
    // The definition-of-done case: a skipped week beats a thin page.
    const result = buildWeeklyDigest({
      draft,
      items: WEEK_ITEMS.slice(0, 1),
      generatedAt,
    });
    expect(result.digest).toBeNull();
    expect(result.skipped).toContain("below threshold");
    // Not an error — a quiet week is a normal outcome, not a failure.
    expect(result.errors).toEqual([]);
  });

  it("refuses to publish a digest with one uncited sentence", () => {
    const result = buildWeeklyDigest({
      draft: {
        ...draft,
        sentences: [
          ...draft.sentences,
          { text: "Adoption is accelerating.", citations: [] },
        ],
      },
      items: WEEK_ITEMS,
      generatedAt,
    });
    expect(result.digest).toBeNull();
    expect(result.errors.some((e) => e.includes("no citation"))).toBe(true);
  });

  it("refuses speculative language even when every sentence is cited", () => {
    const result = buildWeeklyDigest({
      draft: {
        ...draft,
        sentences: [{ text: "SN8 looks bullish.", citations: ["a"] }],
      },
      items: WEEK_ITEMS,
      generatedAt,
    });
    expect(result.digest).toBeNull();
    expect(result.errors[0]).toContain("bullish");
  });

  it("lists only the cited items in the footer", () => {
    // The footer promises "sources for what you just read"; padding it with
    // uncited items from the window would make that false.
    const result = buildWeeklyDigest({
      draft,
      items: WEEK_ITEMS,
      generatedAt,
    });
    expect(result.digest?.sources.map((s) => s.id)).toEqual(["b", "a"]);
    expect(result.digest?.sources.some((s) => s.id === "c")).toBe(false);
  });

  it("every footer source resolves to a real item with a URL", () => {
    const result = buildWeeklyDigest({ draft, items: WEEK_ITEMS, generatedAt });
    for (const source of result.digest?.sources ?? []) {
      expect(() => new URL(source.url)).not.toThrow();
      expect(WEEK_ITEMS.some((i) => i.id === source.id)).toBe(true);
    }
  });

  it("checks the threshold before grounding", () => {
    // A quiet week should not cost a grounding pass, and its verdict must be
    // "skipped", not "invalid" — the two mean different things to the pipeline.
    const result = buildWeeklyDigest({
      draft: { ...draft, sentences: [{ text: "Uncited.", citations: [] }] },
      items: WEEK_ITEMS.slice(0, 1),
      generatedAt,
    });
    expect(result.skipped).toContain("below threshold");
    expect(result.errors).toEqual([]);
  });

  it("stamps the generation time so a revision is distinguishable", () => {
    const result = buildWeeklyDigest({ draft, items: WEEK_ITEMS, generatedAt });
    expect(result.digest?.generated_at).toBe(generatedAt);
  });

  it("supports the network-wide digest (netuid null)", () => {
    const result = buildWeeklyDigest({
      draft: { ...draft, netuid: null },
      items: WEEK_ITEMS,
      generatedAt,
    });
    expect(result.digest?.netuid).toBeNull();
  });

  it("is total when handed a non-array item window", () => {
    const result = buildWeeklyDigest({
      draft,
      items: null as never,
      generatedAt,
    });
    expect(result.digest).toBeNull();
    expect(result.skipped).toContain("below threshold");
  });

  it("honours an explicit minimum", () => {
    expect(
      buildWeeklyDigest({
        draft,
        items: WEEK_ITEMS.slice(0, 2),
        generatedAt,
        minimum: 2,
      }).digest,
    ).not.toBeNull();
  });
});
