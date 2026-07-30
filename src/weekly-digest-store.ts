// #8705 PR3: which weeks may be published, and the rule that a published one
// never changes.
//
// Requirement 3 says a published digest never silently changes and a correction
// is a new dated revision. That is a property of the STORE, not of the
// generator — regenerating every week on every run would quietly rewrite last
// month's page the moment a late feed item landed in its window. So the merge
// here is append-only: a (netuid, week) already in the store is returned
// untouched and is not even regenerated.
//
// The second rule is that an UNFINISHED week is never published. A digest for
// the week still in progress would go out saying "two releases" on Tuesday and
// be wrong by Friday, which is the same broken promise by a different route.
// Only weeks that have ended are candidates.

import {
  buildWeeklyDigest,
  isoWeek,
  weekSlug,
  type DigestSourceItem,
  type WeeklyDigest,
} from "./weekly-digest.ts";
import { buildDigestDraft } from "./weekly-digest-draft.ts";

export interface DigestStore {
  schema_version: 1;
  /** When the store was last written. NOT when any digest was generated. */
  generated_at: string;
  digests: WeeklyDigest[];
}

/**
 * Stable identity for a digest.
 *
 * The network-wide digest has `netuid: null`, which would collide with a subnet
 * under any scheme that stringifies null loosely — hence the explicit
 * "network" token rather than `String(netuid)`.
 */
export function digestKey(netuid: number | null, slug: string): string {
  return `${netuid === null ? "network" : netuid}/${slug}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * UTC midnight on the Monday that starts an ISO week.
 *
 * Derived from the ISO definition rather than a lookup: week 1 is the week
 * containing 4 January, so the Monday of week 1 is 4 January minus its own
 * weekday offset, and every later week is a multiple of 7 days from there.
 * A round-trip test holds this against isoWeek() for a multi-year sweep,
 * including the year boundaries where the two could plausibly disagree.
 */
export function isoWeekStart(year: number, week: number): Date {
  const fourthJan = new Date(Date.UTC(year, 0, 4));
  // getUTCDay is 0 for Sunday; ISO weekdays run Monday=1..Sunday=7.
  const isoWeekday = fourthJan.getUTCDay() === 0 ? 7 : fourthJan.getUTCDay();
  const week1Monday = fourthJan.getTime() - (isoWeekday - 1) * DAY_MS;
  return new Date(week1Monday + (week - 1) * 7 * DAY_MS);
}

/** Has the week ended? Its last instant must be strictly in the past. */
export function isWeekComplete(
  year: number,
  week: number,
  now: Date | string | number,
): boolean {
  const endsAt = isoWeekStart(year, week).getTime() + 7 * DAY_MS;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return false;
  return endsAt <= nowMs;
}

/**
 * Every complete week an item set touches, newest first.
 *
 * Deduped, because a week with forty items is still one candidate.
 */
export function candidateWeeks(
  items: readonly DigestSourceItem[] | null | undefined,
  now: Date | string | number,
): { year: number; week: number }[] {
  const seen = new Map<string, { year: number; week: number }>();
  for (const item of Array.isArray(items) ? items : []) {
    const at = isoWeek(item?.timestamp);
    if (at == null) continue;
    if (!isWeekComplete(at.year, at.week, now)) continue;
    seen.set(weekSlug(at.year, at.week), at);
  }
  return [...seen.values()].sort((a, b) => b.year - a.year || b.week - a.week);
}

export interface DigestGenerationResult {
  digests: WeeklyDigest[];
  /** Weeks that had items but did not clear the threshold, for the run log. */
  skipped: { slug: string; reason: string }[];
}

/**
 * Generate every publishable digest for one subject that is not already stored.
 *
 * `existingKeys` is what makes this append-only: a week already published is
 * skipped before any work happens, so its prose cannot change even if its
 * window has since gained items.
 */
export function generateDigests(input: {
  netuid: number | null;
  items: readonly DigestSourceItem[];
  now: Date | string | number;
  generatedAt: string;
  existingKeys: ReadonlySet<string>;
}): DigestGenerationResult {
  const digests: WeeklyDigest[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  const all = Array.isArray(input.items) ? input.items : [];

  for (const { year, week } of candidateWeeks(all, input.now)) {
    const slug = weekSlug(year, week);
    if (input.existingKeys.has(digestKey(input.netuid, slug))) continue;

    const windowItems = all.filter((item) => {
      const at = isoWeek(item?.timestamp);
      return at != null && at.year === year && at.week === week;
    });
    const result = buildWeeklyDigest({
      draft: buildDigestDraft({
        netuid: input.netuid,
        year,
        week,
        items: windowItems,
      }),
      items: windowItems,
      generatedAt: input.generatedAt,
    });
    if (result.digest) {
      digests.push(result.digest);
      continue;
    }
    skipped.push({
      slug,
      reason: result.skipped ?? result.errors.join("; "),
    });
  }

  return { digests, skipped };
}

/**
 * Fold new digests into the store without touching what is already there.
 *
 * Sorted by subject then week so the committed file's diff shows only what was
 * added, rather than reordering on every run.
 */
export function mergeDigestStore(
  existing: DigestStore | null | undefined,
  incoming: readonly WeeklyDigest[],
  generatedAt: string,
): { store: DigestStore; added: number } {
  const kept = Array.isArray(existing?.digests) ? [...existing.digests] : [];
  const keys = new Set(
    kept.map((digest) => digestKey(digest.netuid, digest.slug)),
  );

  let added = 0;
  for (const digest of incoming) {
    const key = digestKey(digest.netuid, digest.slug);
    if (keys.has(key)) continue;
    keys.add(key);
    kept.push(digest);
    added += 1;
  }

  kept.sort((a, b) =>
    digestKey(a.netuid, a.slug).localeCompare(digestKey(b.netuid, b.slug)),
  );

  return {
    store: { schema_version: 1, generated_at: generatedAt, digests: kept },
    added,
  };
}
