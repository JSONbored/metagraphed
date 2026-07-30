import type { AccountEvent } from "./types";

// #8366: subnet detail's Recent Activity module showed "five near-identical
// rows" (the audit's own monotony finding) whenever a busy epoch fired the
// same event kind repeatedly. 15 minutes, matching the issue's own worked
// example ("Timelocked weights committed × 7 · last 12m").
export const ACTIVITY_AGGREGATION_WINDOW_MS = 15 * 60_000;

export interface ActivityGroup {
  kind: string | null;
  /** Newest-first, same order as the input -- events[0] is the group's anchor/newest member. */
  events: AccountEvent[];
}

/**
 * Groups CONSECUTIVE same-kind events into one row when they land within
 * `windowMs` of each other -- runs over whatever `events` array the caller
 * already has (live-refreshed or a static snapshot), so the fix applies to
 * both without a second code path.
 *
 * "Consecutive" means adjacent in the given order: a same-kind event that
 * resumes after a DIFFERENT kind interrupts it starts a fresh group rather
 * than retroactively merging into an earlier one -- a busy epoch's weight-
 * setting run collapses to one row, but doesn't silently absorb an
 * unrelated weight-setting event from an hour ago just because the kind
 * matches.
 *
 * Assumes `events` is already newest-first (this app's convention for every
 * activity/recent list) -- each candidate is compared against the group's
 * FIRST (newest) member, so a run spans at most `windowMs` from its most
 * recent event, not its oldest: a slow trickle of the same kind spread
 * across an hour produces several capped groups, not one unbounded one.
 *
 * An event missing `observed_at` never joins a group (including with an
 * otherwise-identical neighbor) -- there is no timestamp to prove the
 * "within 15 minutes" claim, and this app's own convention throughout
 * (registry-ticker's "never a fabricated number", etc.) is to render
 * degraded rather than assert something unverifiable.
 */
export function aggregateActivityEvents(
  events: readonly AccountEvent[],
  windowMs: number = ACTIVITY_AGGREGATION_WINDOW_MS,
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const ev of events) {
    const current = groups[groups.length - 1];
    if (
      current &&
      current.kind === ev.event_kind &&
      withinWindow(current.events[0], ev, windowMs)
    ) {
      current.events.push(ev);
      continue;
    }
    groups.push({ kind: ev.event_kind ?? null, events: [ev] });
  }
  return groups;
}

/**
 * Single group identity for both React row keys and expand/collapse state
 * (#8817). Derived solely from the group's anchor event (`events[0]`) and
 * kind so a live prepend that shifts array indices does not move a row's
 * identity — an index-keyed Set collapses the wrong row on the next
 * firehose frame.
 */
export function activityGroupKey(group: ActivityGroup): string {
  const anchor = group.events[0];
  const kind = group.kind ?? "∅";
  const block = anchor?.block_number ?? "∅";
  const index = anchor?.event_index ?? "∅";
  const observed = anchor?.observed_at ?? "∅";
  return `${kind}-${block}-${index}-${observed}`;
}

function withinWindow(
  anchor: AccountEvent | undefined,
  ev: AccountEvent,
  windowMs: number,
): boolean {
  const a = anchor?.observed_at ? Date.parse(anchor.observed_at) : NaN;
  const b = ev.observed_at ? Date.parse(ev.observed_at) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= windowMs;
}

/**
 * "last 12m" / "last 3m" style span label for a group's own header row --
 * the issue's own worked example format. A single-event group has no span
 * to report (its own timestamp already renders via TimeAgo), so this
 * returns null for a group of one rather than a degenerate "last 0m".
 */
export function activityGroupSpanMinutes(group: ActivityGroup): number | null {
  if (group.events.length < 2) return null;
  const newest = group.events[0]?.observed_at ? Date.parse(group.events[0].observed_at) : NaN;
  const oldest = group.events[group.events.length - 1]?.observed_at
    ? Date.parse(group.events[group.events.length - 1]!.observed_at!)
    : NaN;
  if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return null;
  return Math.max(0, Math.round((newest - oldest) / 60_000));
}
