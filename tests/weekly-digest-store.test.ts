// Tests for src/weekly-digest-store.ts (#8705 PR 3).
//
// Two properties carry the issue's requirement 3 ("a published digest never
// silently changes"), and both are asserted directly rather than inferred from
// the merge's shape: a week already in the store is returned byte-identical
// even when its window has since gained items, and a week still in progress is
// never published at all.
//
// isoWeekStart is held against the merged isoWeek() by round-trip over a
// multi-year sweep rather than by a table of dates — the year boundaries are
// exactly where a hand-written table would be wrong and look right.

import { describe, expect, it } from "vitest";
import {
  candidateWeeks,
  digestKey,
  generateDigests,
  isWeekComplete,
  isoWeekStart,
  mergeDigestStore,
  type DigestStore,
} from "../src/weekly-digest-store.ts";
import {
  isoWeek,
  MIN_SUBSTANTIVE_ITEMS,
  weekSlug,
  type DigestSourceItem,
  type WeeklyDigest,
} from "../src/weekly-digest.ts";

function item(
  id: string,
  timestamp: string,
  tags: string[] = ["release"],
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

/** Three items in ISO week 2026-W30 (Mon 20 Jul – Sun 26 Jul 2026). */
const W30 = [
  item("a", "2026-07-20T10:00:00.000Z"),
  item("b", "2026-07-22T10:00:00.000Z", ["hyperparam"]),
  item("c", "2026-07-24T10:00:00.000Z", ["incident"]),
];

const AFTER_W30 = "2026-08-05T00:00:00.000Z";

describe("ISO week boundaries", () => {
  it("round-trips against isoWeek across year boundaries", () => {
    // The property that matters: the Monday isoWeekStart returns must be
    // reported by isoWeek as that same (year, week). Swept rather than tabled.
    for (let year = 2023; year <= 2030; year += 1) {
      for (let week = 1; week <= 52; week += 1) {
        const start = isoWeekStart(year, week);
        expect(isoWeek(start)).toEqual({ year, week });
      }
    }
  });

  it("starts a week on Monday, UTC", () => {
    for (let week = 1; week <= 52; week += 1) {
      // getUTCDay() === 1 is Monday.
      expect(isoWeekStart(2026, week).getUTCDay()).toBe(1);
    }
  });

  it("handles a 53-week ISO year", () => {
    // 2026 has 53 ISO weeks: 2027-01-01 is a Friday, so it belongs to 2026-W53.
    expect(isoWeek("2027-01-01T00:00:00.000Z")).toEqual({
      year: 2026,
      week: 53,
    });
    expect(isoWeek(isoWeekStart(2026, 53))).toEqual({ year: 2026, week: 53 });
  });
});

describe("week completeness", () => {
  it("is complete once the week's last instant has passed", () => {
    // 2026-W30 ends at 2026-07-27T00:00:00Z (the Monday that starts W31).
    expect(isWeekComplete(2026, 30, "2026-07-26T23:59:59.999Z")).toBe(false);
    expect(isWeekComplete(2026, 30, "2026-07-27T00:00:00.000Z")).toBe(true);
    expect(isWeekComplete(2026, 30, "2026-08-01T00:00:00.000Z")).toBe(true);
  });

  it("refuses rather than guesses when now is unparseable", () => {
    expect(isWeekComplete(2026, 30, "not-a-date")).toBe(false);
  });

  it("offers only complete weeks as candidates", () => {
    // Two items, one in a finished week and one in the week containing `now`.
    const items = [
      item("done", "2026-07-22T10:00:00.000Z"),
      item("live", "2026-07-29T10:00:00.000Z"),
    ];
    const weeks = candidateWeeks(items, "2026-07-30T12:00:00.000Z");
    expect(weeks).toEqual([{ year: 2026, week: 30 }]);
  });

  it("dedupes a week no matter how many items it holds", () => {
    expect(candidateWeeks(W30, AFTER_W30)).toEqual([{ year: 2026, week: 30 }]);
  });

  it("orders newest first and tolerates junk input", () => {
    const items = [
      item("older", "2026-07-13T10:00:00.000Z"),
      item("newer", "2026-07-20T10:00:00.000Z"),
      item("bad", "nonsense"),
    ];
    expect(candidateWeeks(items, AFTER_W30)).toEqual([
      { year: 2026, week: 30 },
      { year: 2026, week: 29 },
    ]);
    expect(candidateWeeks(null, AFTER_W30)).toEqual([]);
    expect(candidateWeeks(undefined, AFTER_W30)).toEqual([]);
  });
});

describe("digest identity", () => {
  it("keeps the network digest distinct from any subnet", () => {
    expect(digestKey(null, "2026-w30")).toBe("network/2026-w30");
    expect(digestKey(8, "2026-w30")).toBe("8/2026-w30");
    expect(digestKey(null, "2026-w30")).not.toBe(digestKey(0, "2026-w30"));
  });
});

describe("generation", () => {
  it("publishes a complete week that clears the threshold", () => {
    expect(W30.length).toBeGreaterThanOrEqual(MIN_SUBSTANTIVE_ITEMS);
    const result = generateDigests({
      netuid: 8,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0].slug).toBe(weekSlug(2026, 30));
    expect(result.digests[0].netuid).toBe(8);
    expect(result.skipped).toEqual([]);
  });

  it("skips an already-published week without regenerating it", () => {
    const result = generateDigests({
      netuid: 8,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set([digestKey(8, "2026-w30")]),
    });
    expect(result.digests).toEqual([]);
    // Not reported as skipped either — it was not a candidate at all.
    expect(result.skipped).toEqual([]);
  });

  it("reports a quiet week as skipped rather than publishing it", () => {
    const quiet = W30.slice(0, MIN_SUBSTANTIVE_ITEMS - 1);
    const result = generateDigests({
      netuid: 8,
      items: quiet,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    expect(result.digests).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].slug).toBe("2026-w30");
    expect(result.skipped[0].reason).toBeTruthy();
  });

  it("refuses a week whose items cannot be cited, and says why", () => {
    // A feed item with an empty id is citable by the draft but unresolvable by
    // validateGrounding, so the pipeline rejects the week rather than
    // publishing prose that points at nothing. The reason carries the
    // grounding errors, not a threshold verdict.
    //
    // Three well-formed items plus the malformed one: evaluateThreshold dedupes
    // on id and drops falsy ones, so a bare 2-good-1-empty set would be
    // rejected at the threshold and never reach grounding at all.
    const malformed = [
      item("a", "2026-07-20T10:00:00.000Z"),
      item("b", "2026-07-22T10:00:00.000Z"),
      item("c", "2026-07-23T10:00:00.000Z"),
      { ...item("d", "2026-07-24T10:00:00.000Z"), id: "" },
    ];
    const result = generateDigests({
      netuid: 8,
      items: malformed,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    expect(result.digests).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("does not resolve");
  });

  it("never publishes the week in progress", () => {
    const thisWeek = [
      item("a", "2026-07-27T10:00:00.000Z"),
      item("b", "2026-07-28T10:00:00.000Z", ["hyperparam"]),
      item("c", "2026-07-29T10:00:00.000Z", ["incident"]),
    ];
    const result = generateDigests({
      netuid: 8,
      items: thisWeek,
      now: "2026-07-30T12:00:00.000Z",
      generatedAt: "2026-07-30T12:00:00.000Z",
      existingKeys: new Set(),
    });
    expect(result.digests).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("builds a network-wide digest with a null netuid", () => {
    const result = generateDigests({
      netuid: null,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    expect(result.digests[0].netuid).toBeNull();
  });

  it("tolerates a non-array item set", () => {
    const result = generateDigests({
      netuid: 8,
      items: undefined as unknown as DigestSourceItem[],
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    expect(result.digests).toEqual([]);
  });
});

describe("the store is append-only", () => {
  function published(): WeeklyDigest {
    const result = generateDigests({
      netuid: 8,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    });
    return result.digests[0];
  }

  it("returns an existing digest byte-identical when its window gained items", () => {
    // The requirement, asserted directly: regenerate the same week from a
    // LARGER window and confirm the stored digest is untouched.
    const first = published();
    const store: DigestStore = {
      schema_version: 1,
      generated_at: AFTER_W30,
      digests: [first],
    };
    const laterItems = [...W30, item("late", "2026-07-25T10:00:00.000Z")];
    const regenerated = generateDigests({
      netuid: 8,
      items: laterItems,
      now: AFTER_W30,
      generatedAt: "2026-09-01T00:00:00.000Z",
      existingKeys: new Set(
        store.digests.map((d) => digestKey(d.netuid, d.slug)),
      ),
    });
    const merged = mergeDigestStore(
      store,
      regenerated.digests,
      "2026-09-01T00:00:00.000Z",
    );
    expect(merged.added).toBe(0);
    expect(merged.store.digests).toHaveLength(1);
    expect(merged.store.digests[0]).toEqual(first);
  });

  it("adds a genuinely new week", () => {
    const first = published();
    const other = generateDigests({
      netuid: 9,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    }).digests;
    const merged = mergeDigestStore(
      { schema_version: 1, generated_at: AFTER_W30, digests: [first] },
      other,
      AFTER_W30,
    );
    expect(merged.added).toBe(1);
    expect(merged.store.digests).toHaveLength(2);
  });

  it("ignores a duplicate inside one incoming batch", () => {
    const first = published();
    const merged = mergeDigestStore(null, [first, first], AFTER_W30);
    expect(merged.added).toBe(1);
    expect(merged.store.digests).toHaveLength(1);
  });

  it("sorts stably so a run adds lines rather than reordering them", () => {
    const eight = published();
    const nine = generateDigests({
      netuid: 9,
      items: W30,
      now: AFTER_W30,
      generatedAt: AFTER_W30,
      existingKeys: new Set(),
    }).digests[0];
    const a = mergeDigestStore(null, [nine, eight], AFTER_W30);
    const b = mergeDigestStore(null, [eight, nine], AFTER_W30);
    expect(a.store.digests).toEqual(b.store.digests);
  });

  it("starts from nothing when there is no store yet", () => {
    const merged = mergeDigestStore(undefined, [published()], AFTER_W30);
    expect(merged.added).toBe(1);
    expect(merged.store.schema_version).toBe(1);
    expect(merged.store.generated_at).toBe(AFTER_W30);
    expect(
      mergeDigestStore(
        { schema_version: 1, generated_at: AFTER_W30 } as DigestStore,
        [],
        AFTER_W30,
      ).store.digests,
    ).toEqual([]);
  });
});
