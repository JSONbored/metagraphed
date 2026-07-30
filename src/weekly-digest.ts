// Grounded weekly digests (#8705, PR 1 of 3): the generator's spine — ISO week
// windowing, the publication threshold, and the grounding validator.
//
// ── WHY GROUNDING IS STRUCTURAL, NOT SEMANTIC ───────────────────────────────
//
// The issue's rule is absolute: every sentence must be traceable to a feed
// item, and a digest containing one uncited claim must not ship. There are two
// ways to enforce that, and only one of them works.
//
// Checking an LLM's prose for truthfulness after the fact is not a solvable
// problem — you cannot mechanically decide whether "registration reopened"
// follows from a set of items. So this module does not try. Instead the digest
// FORMAT carries citations: a sentence is a `{ text, citations }` pair, and a
// sentence with no resolvable citation is rejected before anything is written.
// The generator (any generator, LLM or template) must emit citations or its
// output is refused. That turns an unenforceable semantic promise into a
// mechanical one.
//
// This still cannot stop a generator from citing a real item and writing a
// sentence that misdescribes it. Nothing can, short of a human. What it DOES
// guarantee is the property the reader actually needs: every claim points at a
// primary source they can open in one click and check. That is the honest
// version of "grounded", and it is why the UI footer requirement in the issue
// (#8705 req 5) is part of the same mechanism rather than decoration.
//
// ── WHY A THRESHOLD ────────────────────────────────────────────────────────
//
// A digest of one item is a worse version of the subnet page, and publishing
// hundreds of them dilutes the site's index — the exact thin-content pattern
// the issue exists to avoid. Below the threshold there is no page at all,
// rather than a page marked noindex: an unpublished week costs nothing, while a
// noindex page still has to be built, stored, and kept correct forever.

/** A feed item, as produced by src/feeds.ts / src/subnet-news.ts. */
export interface DigestSourceItem {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
}

/**
 * Minimum substantive items before a week is worth a page.
 *
 * Three, and the reasoning is about what the page adds rather than a tuning
 * knob: with one or two items the digest restates what the subnet page already
 * shows above the fold, so it is a duplicate with a different URL. At three the
 * page starts doing something the subnet page does not — telling a reader what
 * happened over a bounded window, in order, with sources. Raise it and real
 * weeks go unpublished; lower it and the index fills with pages nobody needs.
 */
export const MIN_SUBSTANTIVE_ITEMS = 3;

/**
 * Tags that make an item substantive — a real change to the subject.
 *
 * An allowlist. `artifact` items (a file we regenerated) and `coverage` items
 * (our own registry completeness moving) are activity in OUR pipeline, not the
 * subnet's, and a week whose only "news" is that we republished a JSON file is
 * precisely the thin page the threshold exists to prevent.
 */
export const SUBSTANTIVE_TAGS: readonly string[] = [
  "release",
  "hyperparam",
  "ownership",
  "lease",
  "governance",
  "incident",
  "subnet",
  "upgrade",
];

export function isSubstantive(
  item: DigestSourceItem | null | undefined,
): boolean {
  if (!item || !Array.isArray(item.tags)) return false;
  return item.tags.some((tag) => SUBSTANTIVE_TAGS.includes(tag));
}

// ── ISO week windowing ──────────────────────────────────────────────────────

/**
 * The ISO-8601 week containing an instant, as `{ year, week }`.
 *
 * ISO weeks are NOT "week of the calendar year": week 1 is the week containing
 * the first Thursday, weeks start Monday, and a date in early January can
 * belong to the previous ISO year (2027-01-01 is 2026-W53). Getting this wrong
 * would put a digest under a URL that disagrees with its own contents once a
 * year, every year, so it is computed properly and tested against the turn.
 */
export function isoWeek(instant: Date | string | number): {
  year: number;
  week: number;
} | null {
  const date =
    instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  // Work in UTC on a copy, shifted to the Thursday of this week: the ISO year
  // is by definition the calendar year of that Thursday.
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay(): Sunday=0. ISO treats Monday=1..Sunday=7.
  const isoDay = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - isoDay);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIsoDay =
    firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstIsoDay);
  const week =
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
  return { year: isoYear, week };
}

/** Canonical slug for a week, e.g. "2026-w31". Zero-padded so slugs sort. */
export function weekSlug(year: number, week: number): string {
  return `${year}-w${String(week).padStart(2, "0")}`;
}

/** Parse a week slug back to its parts, or null when malformed. */
export function parseWeekSlug(
  slug: unknown,
): { year: number; week: number } | null {
  if (typeof slug !== "string") return null;
  const match = /^(\d{4})-w(\d{2})$/.exec(slug.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  // ISO years have 52 or 53 weeks; week 0 and week 54+ are never valid.
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * The items belonging to one ISO week.
 *
 * Filtered by the item's own timestamp rather than by capture time, so an item
 * captured late still lands in the week it actually happened — a release
 * published Sunday and captured Monday belongs to Sunday's week.
 */
export function itemsForWeek(
  items: readonly DigestSourceItem[] | null | undefined,
  year: number,
  week: number,
): DigestSourceItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => {
      const at = isoWeek(item?.timestamp);
      return at != null && at.year === year && at.week === week;
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// ── publication threshold ───────────────────────────────────────────────────

export interface ThresholdVerdict {
  publish: boolean;
  substantive_count: number;
  reason: string;
}

/**
 * Whether a week earns a page.
 *
 * Returns the count and a reason rather than a bare boolean, because the
 * publish pipeline logs skipped weeks and "skipped: 2 substantive items" is
 * debuggable where `false` is not.
 */
export function evaluateThreshold(
  items: readonly DigestSourceItem[] | null | undefined,
  minimum = MIN_SUBSTANTIVE_ITEMS,
): ThresholdVerdict {
  const list = Array.isArray(items) ? items : [];
  const substantive = list.filter(isSubstantive);
  // Dedupe on id: the same change reaching a feed twice must not buy its way
  // past the threshold.
  const unique = new Set(substantive.map((item) => item?.id).filter(Boolean));
  const count = unique.size;
  return {
    publish: count >= minimum,
    substantive_count: count,
    reason:
      count >= minimum
        ? `${count} substantive item(s)`
        : `below threshold: ${count} substantive item(s), need ${minimum}`,
  };
}

// ── grounding ───────────────────────────────────────────────────────────────

/** One sentence of a digest, with the items it rests on. */
export interface DigestSentence {
  text: string;
  /** Item ids. At least one, and every one must resolve. */
  citations: string[];
}

export interface DigestDraft {
  /** null for the network-wide digest. */
  netuid: number | null;
  year: number;
  week: number;
  sentences: DigestSentence[];
}

export interface GroundingResult {
  ok: boolean;
  errors: string[];
}

/**
 * Reject a draft whose prose is not fully cited.
 *
 * Every failure mode here is a REJECTION, never a repair: silently dropping an
 * uncited sentence would publish a digest that reads as complete while having
 * quietly lost a claim, which is worse than not publishing.
 */
export function validateGrounding(
  draft: DigestDraft | null | undefined,
  items: readonly DigestSourceItem[] | null | undefined,
): GroundingResult {
  const errors: string[] = [];
  const known = new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => item?.id)
      .filter((id): id is string => typeof id === "string" && id !== ""),
  );
  const sentences = Array.isArray(draft?.sentences) ? draft.sentences : [];
  if (sentences.length === 0) {
    errors.push("digest has no sentences");
  }
  sentences.forEach((sentence, index) => {
    const text = typeof sentence?.text === "string" ? sentence.text.trim() : "";
    if (text === "") {
      errors.push(`sentence ${index}: empty text`);
      return;
    }
    const citations = Array.isArray(sentence?.citations)
      ? sentence.citations
      : [];
    if (citations.length === 0) {
      errors.push(`sentence ${index}: no citation — "${clampText(text)}"`);
      return;
    }
    for (const citation of citations) {
      if (typeof citation !== "string" || !known.has(citation)) {
        errors.push(
          `sentence ${index}: citation "${String(citation)}" does not resolve to a source item`,
        );
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

function clampText(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Vocabulary a grounded digest must not use.
 *
 * These are the words that show up when a generator starts narrating instead of
 * reporting — momentum, sentiment, and price commentary, all of which are
 * claims no feed item can support. Checked as whole words so "surged" is caught
 * while "insurge" (or any legitimate substring) is not.
 */
export const UNGROUNDED_TERMS: readonly string[] = [
  "surged",
  "plummeted",
  "rally",
  "rallied",
  "bullish",
  "bearish",
  "momentum",
  "sentiment",
  "outperform",
  "undervalued",
  "overvalued",
  "poised",
  "promising",
  "exciting",
  "likely will",
  "expected to",
  "we believe",
];

/**
 * Flag speculative or promotional language.
 *
 * Separate from citation checking on purpose: a sentence can be perfectly cited
 * and still say "SN8 is poised for growth", which no item supports. Returns the
 * matched terms so the pipeline's error names the exact word to remove.
 */
export function findUngroundedLanguage(
  draft: DigestDraft | null | undefined,
): string[] {
  const found = new Set<string>();
  for (const sentence of Array.isArray(draft?.sentences)
    ? draft.sentences
    : []) {
    const text = typeof sentence?.text === "string" ? sentence.text : "";
    const lowered = text.toLowerCase();
    for (const term of UNGROUNDED_TERMS) {
      // Word-boundary match so a term inside a longer word does not fire.
      const pattern = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`);
      if (pattern.test(lowered)) found.add(term);
    }
  }
  return [...found].sort();
}

// ── the published shape ─────────────────────────────────────────────────────

export interface WeeklyDigest {
  schema_version: 1;
  netuid: number | null;
  year: number;
  week: number;
  slug: string;
  /** ISO instant the digest was generated. A revision gets a new one. */
  generated_at: string;
  sentences: DigestSentence[];
  /** Every item any sentence cites, in feed order — the audit footer (#8705 req 5). */
  sources: DigestSourceItem[];
  substantive_count: number;
}

export interface BuildDigestResult {
  digest: WeeklyDigest | null;
  /** Why nothing was published, when digest is null. */
  skipped: string | null;
  errors: string[];
}

/**
 * Assemble a publishable digest, or refuse.
 *
 * The single entry point, so there is no way to write a digest that skipped a
 * check. Order matters: threshold first (cheapest, and a quiet week should not
 * cost a grounding pass), then grounding, then language.
 *
 * `sources` carries only the items actually cited, not the whole window — the
 * footer's promise is "these are the sources for what you just read", and
 * padding it with uncited items would make that false. It is sorted newest
 * first here, so the published footer does not depend on caller ordering.
 */
export function buildWeeklyDigest(input: {
  draft: DigestDraft;
  items: readonly DigestSourceItem[];
  generatedAt: string;
  minimum?: number;
}): BuildDigestResult {
  const { draft, items, generatedAt } = input;
  const windowItems = Array.isArray(items) ? items : [];

  const threshold = evaluateThreshold(windowItems, input.minimum);
  if (!threshold.publish) {
    return { digest: null, skipped: threshold.reason, errors: [] };
  }

  const grounding = validateGrounding(draft, windowItems);
  if (!grounding.ok) {
    return { digest: null, skipped: null, errors: grounding.errors };
  }

  const ungrounded = findUngroundedLanguage(draft);
  if (ungrounded.length > 0) {
    return {
      digest: null,
      skipped: null,
      errors: ungrounded.map(
        (term) =>
          `speculative language: "${term}" is not supported by any item`,
      ),
    };
  }

  const citedIds = new Set(
    draft.sentences.flatMap((sentence) => sentence.citations),
  );
  // Newest first, and sorted HERE rather than inherited from the caller's
  // array order: the footer is published output, so it must be identical for
  // the same week no matter how the window was assembled.
  const sources = windowItems
    .filter((item) => citedIds.has(item.id))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  return {
    digest: {
      schema_version: 1,
      netuid: draft.netuid,
      year: draft.year,
      week: draft.week,
      slug: weekSlug(draft.year, draft.week),
      generated_at: generatedAt,
      sentences: draft.sentences,
      sources,
      substantive_count: threshold.substantive_count,
    },
    skipped: null,
    errors: [],
  };
}
