// Tests for src/weekly-digest-draft.ts (#8705 PR 2).
//
// The property that matters most here is not the wording — it is that a draft
// this generator produces can never be rejected by the validators it is fed
// into. Two of these tests assert exactly that, including the case that
// motivated the design: a source whose own title contains "promising" or
// "exciting" must not be able to block a subnet's week from publishing.

import { describe, expect, it } from "vitest";
import {
  buildDigestDraft,
  categoryForItem,
} from "../src/weekly-digest-draft.ts";
import {
  buildWeeklyDigest,
  findUngroundedLanguage,
  isSubstantive,
  MIN_SUBSTANTIVE_ITEMS,
  SUBSTANTIVE_TAGS,
  UNGROUNDED_TERMS,
  validateGrounding,
  type DigestSourceItem,
} from "../src/weekly-digest.ts";

function item(
  id: string,
  timestamp: string,
  tags: string[],
  title = `Item ${id}`,
): DigestSourceItem {
  return {
    id,
    url: `https://metagraph.sh/x/${id}`,
    title,
    summary: `Summary ${id}`,
    timestamp,
    tags,
  };
}

describe("category assignment", () => {
  it("counts an item under exactly one category, the first substantive tag", () => {
    // A real per-subnet feed item carries several tags at once.
    const category = categoryForItem(
      item("a", "2026-07-27T10:00:00.000Z", ["chain", "hyperparam", "sn5"]),
    );
    expect(category).toBe("hyperparam");
  });

  it("follows SUBSTANTIVE_TAGS order, not the item's tag order", () => {
    // `release` precedes `incident` in SUBSTANTIVE_TAGS; the item lists them
    // the other way round. Derived from the real constant so the two cannot
    // drift apart.
    const [first, second] = [SUBSTANTIVE_TAGS[0], SUBSTANTIVE_TAGS[5]];
    const category = categoryForItem(
      item("a", "2026-07-27T10:00:00.000Z", [second, first]),
    );
    expect(category).toBe(first);
  });

  it("agrees with isSubstantive on every tag, and on malformed items", () => {
    // categoryForItem resolves isSubstantive's condition to WHICH tag matched.
    // Neither calls the other, so this is what keeps them answering the same
    // question — swept over the real tag list plus the shapes a feed can
    // actually hand us.
    const cases: (DigestSourceItem | null | undefined)[] = [
      ...SUBSTANTIVE_TAGS.map((tag) =>
        item(`s-${tag}`, "2026-07-27T10:00:00.000Z", [tag]),
      ),
      item("none", "2026-07-27T10:00:00.000Z", []),
      item("other", "2026-07-27T10:00:00.000Z", ["artifact", "coverage"]),
      item("mixed", "2026-07-27T10:00:00.000Z", ["artifact", "release"]),
      {
        ...item("notags", "2026-07-27T10:00:00.000Z", []),
        tags: undefined as never,
      },
      null,
      undefined,
    ];
    for (const candidate of cases) {
      expect(categoryForItem(candidate) !== null).toBe(
        isSubstantive(candidate),
      );
    }
  });

  it("returns null for an item no substantive tag covers", () => {
    expect(
      categoryForItem(item("a", "2026-07-27T10:00:00.000Z", ["artifact"])),
    ).toBeNull();
    expect(categoryForItem(null)).toBeNull();
    expect(categoryForItem(undefined)).toBeNull();
  });

  it("has prose for every substantive tag", () => {
    // Asserted against the real constant rather than a copied list: a tag added
    // to SUBSTANTIVE_TAGS with no phrase would otherwise throw at generation
    // time, on a live week, instead of here.
    for (const tag of SUBSTANTIVE_TAGS) {
      const draft = buildDigestDraft({
        netuid: 8,
        year: 2026,
        week: 31,
        items: [item("a", "2026-07-27T10:00:00.000Z", [tag])],
      });
      expect(draft.sentences).toHaveLength(1);
      expect(draft.sentences[0].text).not.toContain("undefined");
    }
  });
});

describe("draft construction", () => {
  const items = [
    item("r1", "2026-07-27T10:00:00.000Z", ["chain", "release"]),
    item("r2", "2026-07-29T10:00:00.000Z", ["chain", "release"]),
    item("h1", "2026-07-28T10:00:00.000Z", ["chain", "hyperparam"]),
    item("x1", "2026-07-28T11:00:00.000Z", ["artifact"]),
  ];

  it("emits one sentence per category, citing exactly that category's items", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items,
    });
    expect(draft.sentences).toHaveLength(2);
    expect(draft.sentences[0].citations).toEqual(["r1", "r2"]);
    expect(draft.sentences[1].citations).toEqual(["h1"]);
  });

  it("never cites the same item twice", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items,
    });
    const cited = draft.sentences.flatMap((sentence) => sentence.citations);
    expect(new Set(cited).size).toBe(cited.length);
  });

  it("ignores items no substantive tag covers", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items,
    });
    const cited = draft.sentences.flatMap((sentence) => sentence.citations);
    expect(cited).not.toContain("x1");
  });

  it("counts in words up to ten and in digits past it", () => {
    const two = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [
        item("a", "2026-07-27T10:00:00.000Z", ["release"]),
        item("b", "2026-07-27T10:00:00.000Z", ["release"]),
      ],
    });
    expect(two.sentences[0].text).toContain("two releases");

    const eleven = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: Array.from({ length: 11 }, (_, index) =>
        item(`a${index}`, "2026-07-27T10:00:00.000Z", ["release"]),
      ),
    });
    expect(eleven.sentences[0].text).toContain("11 releases");
  });

  it("uses the singular phrase for a single item", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [item("a", "2026-07-27T10:00:00.000Z", ["release"])],
    });
    expect(draft.sentences[0].text).toContain("one release on 27 July.");
  });

  it("gives a date range when the items span days, one date when they do not", () => {
    const spanning = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [
        item("a", "2026-07-27T10:00:00.000Z", ["release"]),
        item("b", "2026-07-30T10:00:00.000Z", ["release"]),
      ],
    });
    expect(spanning.sentences[0].text).toContain("between 27 July and 30 July");

    const sameDay = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [
        item("a", "2026-07-27T10:00:00.000Z", ["release"]),
        item("b", "2026-07-27T18:00:00.000Z", ["release"]),
      ],
    });
    expect(sameDay.sentences[0].text).toContain("on 27 July.");
  });

  it("drops the date clause rather than printing an unparseable one", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [item("a", "not-a-timestamp", ["release"])],
    });
    expect(draft.sentences[0].text).toBe("Subnet 8 recorded one release.");
  });

  it("names the network rather than a subnet for the network-wide digest", () => {
    const draft = buildDigestDraft({
      netuid: null,
      year: 2026,
      week: 31,
      items: [item("a", "2026-07-27T10:00:00.000Z", ["upgrade"])],
    });
    expect(draft.sentences[0].text).toContain("The network recorded");
    expect(draft.netuid).toBeNull();
  });

  it("produces no sentences for a window with nothing substantive in it", () => {
    expect(
      buildDigestDraft({
        netuid: 8,
        year: 2026,
        week: 31,
        items: [item("x", "2026-07-27T10:00:00.000Z", ["artifact"])],
      }).sentences,
    ).toEqual([]);
    expect(
      buildDigestDraft({
        netuid: 8,
        year: 2026,
        week: 31,
        items: undefined as unknown as DigestSourceItem[],
      }).sentences,
    ).toEqual([]);
  });

  it("orders sentences by SUBSTANTIVE_TAGS, not by count or recency", () => {
    // `release` precedes `incident`, even though the incident group is larger
    // and more recent. A published digest must read the same every time.
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: [
        item("i1", "2026-07-30T10:00:00.000Z", ["incident"]),
        item("i2", "2026-07-30T11:00:00.000Z", ["incident"]),
        item("r1", "2026-07-27T10:00:00.000Z", ["release"]),
      ],
    });
    expect(draft.sentences[0].text).toContain("release");
    expect(draft.sentences[1].text).toContain("incident");
  });
});

describe("the generator cannot produce a rejected draft", () => {
  const items = [
    item("r1", "2026-07-27T10:00:00.000Z", ["release"]),
    item("h1", "2026-07-28T10:00:00.000Z", ["hyperparam"]),
    item("i1", "2026-07-29T10:00:00.000Z", ["incident"]),
  ];

  it("is fully grounded — every citation resolves", () => {
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items,
    });
    expect(validateGrounding(draft, items)).toEqual({ ok: true, errors: [] });
  });

  it("uses no speculative language even when the sources do", () => {
    // The reason the prose is ours and the source title stays in the footer:
    // every banned term, planted in real item titles at once.
    const loaded = UNGROUNDED_TERMS.map((term, index) =>
      item(
        `t${index}`,
        "2026-07-27T10:00:00.000Z",
        ["release"],
        `Version 2 — ${term} performance`,
      ),
    );
    const draft = buildDigestDraft({
      netuid: 8,
      year: 2026,
      week: 31,
      items: loaded,
    });
    expect(findUngroundedLanguage(draft)).toEqual([]);
  });

  it("publishes through buildWeeklyDigest when the week clears the threshold", () => {
    expect(items.length).toBeGreaterThanOrEqual(MIN_SUBSTANTIVE_ITEMS);
    const result = buildWeeklyDigest({
      draft: buildDigestDraft({ netuid: 8, year: 2026, week: 31, items }),
      items,
      generatedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBeNull();
    expect(result.digest).not.toBeNull();
    expect(result.digest?.slug).toBe("2026-w31");
    // The footer resolves to exactly the items the prose rests on (#8705 req 5).
    expect(result.digest?.sources.map((source) => source.id).sort()).toEqual([
      "h1",
      "i1",
      "r1",
    ]);
  });

  it("still skips a quiet week — the generator does not override the threshold", () => {
    const quiet = items.slice(0, MIN_SUBSTANTIVE_ITEMS - 1);
    const result = buildWeeklyDigest({
      draft: buildDigestDraft({
        netuid: 8,
        year: 2026,
        week: 31,
        items: quiet,
      }),
      items: quiet,
      generatedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(result.digest).toBeNull();
    expect(result.skipped).not.toBeNull();
  });
});
