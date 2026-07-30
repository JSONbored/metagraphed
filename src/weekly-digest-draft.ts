// #8705 PR2: turn a week's feed items into a digest draft.
//
// The draft is produced DETERMINISTICALLY from the items, not written by a
// model. That is a deliberate reading of the issue's first requirement
// ("grounding is absolute ... the generator's input is the feed window and
// NOTHING else"): a generator that can only count and date the items it was
// given cannot invent a claim, so grounding stops being a property the
// pipeline has to police after the fact and becomes one it has by
// construction. validateGrounding still runs over the result — a generator
// asserting its own correctness is not evidence — but it should never fail,
// and a test asserts exactly that.
//
// This also keeps the seam open. buildWeeklyDigest takes a DigestDraft, not a
// generator, so swapping this producer for a model-written draft later is a
// one-call change that leaves the routes, templates, and validators untouched.
//
// The prose is OURS, never the source's. A sentence says how many things of a
// kind happened and when; the item's own title appears only in the sources
// footer, as link text. That is not a style preference — findUngroundedLanguage
// rejects a draft containing "promising" or "exciting", and those are ordinary
// words in a real GitHub release name. Echoing source prose into the digest
// body would let an upstream marketing headline silently block a subnet's week
// from ever publishing.

import {
  type DigestDraft,
  type DigestSentence,
  type DigestSourceItem,
  SUBSTANTIVE_TAGS,
} from "./weekly-digest.ts";

/**
 * How each substantive tag is described in prose.
 *
 * Keyed by the tag itself so this table and SUBSTANTIVE_TAGS cannot drift apart
 * silently — a test asserts every substantive tag has an entry. The wording is
 * flat and countable on purpose: "recorded two hyperparameter changes" is a
 * claim the items support, "saw significant hyperparameter activity" is not.
 */
const TAG_PHRASES: Record<string, { one: string; many: string }> = {
  release: { one: "release", many: "releases" },
  hyperparam: { one: "hyperparameter change", many: "hyperparameter changes" },
  ownership: { one: "ownership change", many: "ownership changes" },
  lease: { one: "lease event", many: "lease events" },
  governance: { one: "governance action", many: "governance actions" },
  incident: { one: "operational incident", many: "operational incidents" },
  subnet: { one: "registry change", many: "registry changes" },
  upgrade: { one: "runtime upgrade", many: "runtime upgrades" },
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/**
 * The category an item is counted under, or null when it is not substantive.
 *
 * An item routinely carries several tags (`chain`, `hyperparam`, `sn5`), so the
 * category is the FIRST match in SUBSTANTIVE_TAGS order. Picking one and only
 * one matters for citation integrity: an item counted under two sentences would
 * make the digest claim more happened than did, while still passing grounding —
 * every citation would resolve.
 *
 * This is isSubstantive's own condition, resolved to WHICH tag matched rather
 * than whether one did. The two are asserted to agree in the tests rather than
 * one calling the other, so neither can quietly answer a different question.
 */
export function categoryForItem(
  item: DigestSourceItem | null | undefined,
): string | null {
  const tags = item?.tags;
  if (!Array.isArray(tags)) return null;
  return SUBSTANTIVE_TAGS.find((tag) => tags.includes(tag)) ?? null;
}

/** `28 July` — UTC, and spelled out so no locale or timezone can change it. */
function formatDay(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]}`;
}

/** `two` up to ten, then `11` — small counts read as prose, large ones as data. */
function countWord(count: number): string {
  return count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
}

/**
 * The "on 28 July" / "between 26 and 30 July" clause for a group of items.
 *
 * Returns an empty string when no item carries a parseable timestamp, so the
 * sentence degrades to the bare count rather than to "on Invalid Date". A
 * digest that says less is fine; one that says something false is not.
 */
function whenClause(items: readonly DigestSourceItem[]): string {
  const days = items
    .map((item) => ({ day: formatDay(item.timestamp), ts: item.timestamp }))
    .filter((entry): entry is { day: string; ts: string } => entry.day !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (days.length === 0) return "";
  const first = days[0].day;
  const last = days[days.length - 1].day;
  return first === last ? ` on ${first}` : ` between ${first} and ${last}`;
}

/**
 * One sentence per category of thing that happened, citing exactly its items.
 *
 * Ordered by SUBSTANTIVE_TAGS rather than by count or recency so the same week
 * always produces the same prose in the same order — a published digest must
 * not change because the window was assembled differently.
 */
export function buildDigestDraft(input: {
  netuid: number | null;
  year: number;
  week: number;
  items: readonly DigestSourceItem[];
}): DigestDraft {
  const items = Array.isArray(input.items) ? input.items : [];
  const byCategory = new Map<string, DigestSourceItem[]>();
  for (const item of items) {
    const category = categoryForItem(item);
    if (category === null) continue;
    const bucket = byCategory.get(category);
    if (bucket) {
      bucket.push(item);
    } else {
      byCategory.set(category, [item]);
    }
  }

  const sentences: DigestSentence[] = [];
  for (const tag of SUBSTANTIVE_TAGS) {
    const group = byCategory.get(tag);
    if (!group || group.length === 0) continue;
    const phrase =
      group.length === 1 ? TAG_PHRASES[tag].one : TAG_PHRASES[tag].many;
    const subject =
      input.netuid === null ? "The network" : `Subnet ${input.netuid}`;
    sentences.push({
      text: `${subject} recorded ${countWord(group.length)} ${phrase}${whenClause(group)}.`,
      citations: group.map((item) => item.id),
    });
  }

  return {
    netuid: input.netuid,
    year: input.year,
    week: input.week,
    sentences,
  };
}
