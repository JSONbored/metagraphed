// The account summary card's aggregate leg, served from a SHARDED PROJECTION
// artifact instead of scanning the lakehouse per request (#11131).
//
// WHAT THIS REPLACES. `/api/v1/accounts/{ss58}` asks its aggregate leg for
// per-(event_kind, netuid) totals over one account's whole history, which is
// `(hotkey = X OR coldkey = X)` against 455M rows in 51 files. An account value
// is scattered across every file, so statistics cannot prune it and the engine
// opens all of them: measured against production 2026-08-14, 4,374 MB and ~14s
// PER REQUEST, and it is the read that aborts at the 15s r2-sql ceiling.
//
// #11141 bounded every FEED on that table -- a page went 1,068.9 MB -> 3.0 MB --
// but a lifetime aggregate has no window that answers it. Proving an account has
// fewer than N events means reading its whole history, so the scan has to
// happen; the only question is once per request or once per day. This is once
// per day, in the infra container that already runs the sibling rollups
// (metagraphed-infra#557).
//
// WHY SHARDED R2 AND NOT ANOTHER LAKEHOUSE TABLE. Because `account` would be a
// scattered key there too -- a rollup keyed on it opens most of its own files
// for a point lookup exactly as the source does, which shrinks the table ~5x and
// cures nothing. #11133 measured that bucketing on a scattered key trades bytes
// for R2 requests at a bad rate. This route is a POINT LOOKUP by a
// high-cardinality key, and ~1.2M accounts over 256 objects is one GET.
//
// WHY NOT `chain.account_events_daily`, which already exists. Its rule is
// `hotkey IS NOT NULL AND netuid IS NOT NULL`, deliberately, so Transfer and
// Deposit (coldkey, no netuid) and WeightsSet (no hotkey) are absent. For
// 5EYCAe5jLQhn6ofDSvqF... it holds no row on any day against 1,343,321
// both-side events on 2026-07-10 alone. Reading it here would have published a
// 284x undercount.
//
// THE PUBLISH IS ATOMIC, which is why this reads a POINTER first. 16,384 PUTs
// are not a transaction: a producer run that dies partway would otherwise leave
// half the fleet on today's aggregates and half on yesterday's -- and no
// freshness bound can catch that, because the stale half is not old, it is one
// day old. The producer writes each generation to a directory nothing reads and
// flips `current.json` only once every shard has landed, so a failed run leaves
// the previous generation whole. Stale-but-COHERENT is detectable; half-updated
// is not.
//
// The pointer also DECLARES the fan-out, which retires a constant that lived in
// two repositories with nothing able to enforce the pair -- no CI can diff a
// python function against a typescript one. The producer owns the number now
// and this reads it.
//
// THE FALLBACK IS THE POINT. A missing shard, an unparseable body, an account
// the projection has not seen -- every one of them returns null, and the caller
// runs exactly the lakehouse query it runs today. So this can only make the
// route faster, never wrong, and shipping it before the producer has backfilled
// is safe by construction.

import { ACCOUNT_EVENT_SUMMARY_SCAN_CAP } from "./account-events.ts";
import {
  type AccountSummaryRecentEvent,
  AccountSummaryGroupsSchema,
  AccountSummaryPointerSchema,
  AccountSummaryRecentMapSchema,
  AccountSummaryRecentSchema,
} from "../schemas-src/artifacts/account-summary-projection.ts";
import type { R2SqlEnv } from "./r2-sql.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";

/** Objects the producer writes, one per shard. Contract with
 * metagraphed-infra's `services/indexer-rs/account_summary_r2.py`. */
export const ACCOUNT_SUMMARY_PROJECTION_PREFIX =
  "metagraph/projections/account-summary";

/** Names the generation currently readable, and the fan-out it was built with. */
export const ACCOUNT_SUMMARY_POINTER_KEY = `${ACCOUNT_SUMMARY_PROJECTION_PREFIX}/current.json`;

/** The payload shape this reader understands. A producer that changes a field's
 * MEANING bumps it, and this declines rather than misreading the new one. */
export const ACCOUNT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * How old a published generation may be before this stops trusting it.
 *
 * Three days against a producer whose own floor is 20 hours: it clears a missed
 * run, an overrunning one and a container redeploy, while still catching a dead
 * lane in days rather than never. Past it the route returns to the lakehouse
 * read it used before the projection existed -- slower, correct, and
 * self-healing the moment the producer recovers.
 */
export const ACCOUNT_SUMMARY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * FNV-1a over the address, mod the fan-out the POINTER declares.
 *
 * `Math.imul` and `>>> 0` are not decoration: javascript numbers are doubles, so
 * a plain `h * 0x01000193` loses the low bits past 2^53 and yields a different
 * hash from the producer's python. Tests pin three known values against it.
 */
export function accountShard(account: string, shards: number): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(account)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first millisecond of `observed_at` the projection does NOT describe.
 *
 * `through` is the last COMPLETE day the producer folded, so the recent list
 * covers everything up to the end of that day and nothing after it. The head
 * probe must start exactly there, and the arithmetic is the whole reason
 * `through` is published rather than inferred.
 *
 * NOT `generated_at`, which is the trap. A run that folds through 2026-08-14
 * and finishes at 2026-08-15T06:26Z has a `generated_at` SIX HOURS LATER than
 * the data it describes -- so a probe floored at `generated_at` would skip
 * every event between midnight and 06:26 and the card would silently lose them.
 * The two halves have to meet at the data's edge, not at the run's.
 *
 * Returns null for anything not a plain `YYYY-MM-DD`. A pointer without a
 * usable `through` cannot place the floor, and a floor that is a guess is worse
 * than the lakehouse read it would replace.
 */
export function recentFloorMs(through: string | undefined): number | null {
  if (!through || !/^\d{4}-\d{2}-\d{2}$/.test(through)) return null;
  const midnight = Date.parse(`${through}T00:00:00.000Z`);
  return Number.isFinite(midnight) ? midnight + DAY_MS : null;
}

/** What this reader answers with when the projection can serve the account. */
export interface AccountSummaryProjectionRead {
  /** The (kind, netuid) groups -- the card's aggregate leg. */
  groups: Record<string, unknown>[];
  /**
   * The account's newest published events and where the probe resumes, or null
   * when this generation carries no usable recent map for it. Null is not "no
   * events" -- it means the caller reads that leg from the lakehouse, exactly
   * as it did before #575.
   *
   * ONE OBJECT, NOT TWO FIELDS, and that is the point. The rows are unusable
   * without the floor -- serving them alone would freeze the feed at the last
   * complete day the producer folded -- so a shape that let one exist without
   * the other put an invariant in the caller's hands and left it with a guard
   * no test could ever fail. Here the type carries it.
   *
   * THE PARSED ROW TYPE, carried out of `safeParse` rather than widened back
   * to a bag of unknowns. The rows go straight into the feed the card
   * publishes, so the one place that knows their shape is the one that
   * validated them.
   */
  recent: { rows: AccountSummaryRecentEvent[]; floorMs: number } | null;
  /**
   * WHERE THIS ACCOUNT'S FOLDED EVENTS LIE, from the groups' own first/last
   * observed columns, plus the first millisecond the fold does not cover.
   *
   * The weaker half of `recent`, and the one that works TODAY. `recent` needs a
   * producer publishing the map from metagraphed-infra#575; every generation in
   * production carries groups and no map, so that leg declines for every
   * account and the feed goes back to an unbounded lifetime scan. These three
   * numbers come out of groups the producer has always written.
   *
   * WHAT MAKES IT A BOUND rather than a hint: the groups are a LIFETIME
   * aggregate (the read above declines anything over the scan cap rather than
   * publishing a windowed subtotal), so every event at or before the fold sits
   * inside `[firstMs, lastMs]` by construction. Nothing older than `firstMs`
   * exists to miss, and everything newer than `lastMs` is above `foldFloorMs`.
   * The two ranges therefore MEET rather than overlapping or leaving a gap --
   * the same edge argument `recentFloorMs` makes for `recent`.
   *
   * Null when the generation left any of the three unreadable: a partial bound
   * is not a bound, and guessing one would drop events off the end of a feed.
   */
  span: { firstMs: number; lastMs: number; foldFloorMs: number } | null;
  /** Never set on a read that FOUND the account. The discriminant against
   * `AccountSummaryProjectionAbsent`, so a caller cannot confuse "here are the
   * account's groups" with "this account has no history before `floorMs`". */
  absent?: false;
}

/**
 * The projection was readable and does NOT list this account.
 *
 * That is a MEASUREMENT, not a miss: the producer writes every shard, so an
 * account missing from a shard that exists had no events at or before the
 * generation's `through`. Everything it has ever done therefore sits at or
 * after `floorMs`, which turns a lifetime scan into one bounded read.
 *
 * There are no `groups` because there are none to publish — the caller reads
 * the bounded window instead, and that read is COMPLETE rather than partial,
 * which is what separates this from the `null` decline beside it.
 */
export interface AccountSummaryProjectionAbsent {
  absent: true;
  /** First millisecond the projection does not describe. */
  floorMs: number;
}

/** The R2 key holding this account's groups, within a generation. */
export function accountSummaryShardKey(
  account: string,
  shards: number,
  generation: string,
): string {
  return `${ACCOUNT_SUMMARY_PROJECTION_PREFIX}/${generation}/${accountShard(account, shards)}.json`;
}

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

async function readJson(
  bucket: ArtifactBucket,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const body = await object.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    // Unfetchable or unparseable is not a fault to report: the caller reads the
    // lakehouse and answers correctly, just slower.
    return null;
  }
}

/**
 * One account's aggregate groups, in the column aliases `foldSummaryGroups`
 * already reads -- so the projection feeds the SAME builder the lakehouse query
 * feeds, and nothing downstream learns which one answered.
 *
 * Returns null -- meaning "ask the lakehouse" -- for every condition that is not
 * an answer: no binding, no pointer, a schema this does not understand, a
 * generation too old to trust, a shard that will not parse, or an account the
 * projection has not seen.
 *
 * THE CAP KEEPS ITS MEANING. The caller derives `scanned` from the summed group
 * counts and clamps it, so an account over the cap reports `event_scan_capped`
 * and null `first_*` whichever tier answered. The projection knows the true
 * lifetime total and publishing it would be a better number -- but a route
 * whose meaning depends on its tier is worse than either.
 */
export async function loadAccountSummaryProjection(
  env: R2SqlEnv | null | undefined,
  account: string,
  {
    now = Date.now,
    maxAgeMs = ACCOUNT_SUMMARY_MAX_AGE_MS,
    recentLimit = 0,
  }: {
    now?: () => number;
    maxAgeMs?: number;
    /**
     * How many recent events the caller needs. The recent map is only offered
     * when the pointer declares at least this many, so a producer publishing a
     * shorter list declines that leg instead of serving a short feed. Zero --
     * the default -- asks for the aggregate leg only.
     */
    recentLimit?: number;
  } = {},
): Promise<
  AccountSummaryProjectionRead | AccountSummaryProjectionAbsent | null
> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !account) return null;

  // PARSED, not indexed. The producer is in another repository, so the only
  // thing that can hold the two ends together is a written-down shape --
  // `AccountSummaryPointerSchema` is that, and the rules it encodes (a STRING
  // `generated_at`, a POSITIVE INTEGER `shard_count`) are the two the previous
  // hand-rolled checks existed to enforce. See the schema's header for why each
  // one is load-bearing.
  const parsedPointer = AccountSummaryPointerSchema.safeParse(
    await readJson(bucket, ACCOUNT_SUMMARY_POINTER_KEY),
  );
  if (!parsedPointer.success) return null;
  const pointer = parsedPointer.data;
  if (pointer.schema_version !== ACCOUNT_SUMMARY_SCHEMA_VERSION) return null;
  const shards = pointer.shard_count;
  const generation = pointer.generation;
  const generated = Date.parse(pointer.generated_at);
  if (!Number.isFinite(generated)) return null;
  if (maxAgeMs > 0 && now() - generated > maxAgeMs) return null;

  const payload = await readJson(
    bucket,
    accountSummaryShardKey(account, shards, generation),
  );
  if (!payload) return null;
  const accounts = payload["accounts"];
  if (!accounts || typeof accounts !== "object") return null;

  // POSITIVE ABSENCE IS AN ANSWER, and throwing it away is what made a new
  // account the SLOWEST thing this route serves.
  //
  // The producer writes EVERY shard, empty ones included, precisely so this
  // distinction can be drawn -- see `empty_payload`'s docstring in
  // metagraphed-infra's account_summary_r2.py: "The reader cannot tell 'no such
  // account' from 'this shard was never produced' when the object is absent --
  // and the first is an answer while the second is a decline."
  //
  // The shard is present and does not list this account, so the projection has
  // POSITIVELY ESTABLISHED that the account had no events at or before
  // `through`. Returning a bare null here spent that fact: the caller could not
  // tell it from an unreadable pointer, so it fell back to an unbounded
  // lifetime scan of `chain.account_events` for an account whose entire history
  // is known to sit inside a window a few days wide.
  //
  // Measured on production 2026-08-16: an account registered 2026-08-15T13:53 --
  // one day past the generation's `through` -- took the unbounded path and the
  // route answered `503 account_summary_unavailable` after aborting at the 15s
  // ceiling, on an account with exactly ONE event.
  //
  // The bound still has to be placeable, so a generation with no usable
  // `through` declines exactly as before rather than guessing a floor.
  if ((accounts as Record<string, unknown>)[account] === undefined) {
    const floorMs = recentFloorMs(pointer.through);
    return floorMs === null ? null : { absent: true, floorMs };
  }
  // PARSED PER-ACCOUNT, not per-shard. The envelope is checked structurally
  // above because a shard carries ~1,000 accounts and a request reads one of
  // them -- validating the whole object would spend the saving this tier
  // exists to make. The account's own array is small and bounded, so it is
  // parsed properly.
  //
  // A ROW THAT DOES NOT MATCH IS NOT SKIPPED. The loop this replaced dropped
  // malformed entries silently and coerced a bad `count` to 0, so a producer
  // writing the wrong shape would publish a card that was quietly short some
  // events -- confidently wrong, which is the one outcome this family refuses.
  const parsedGroups = AccountSummaryGroupsSchema.safeParse(
    (accounts as Record<string, unknown>)[account],
  );
  if (!parsedGroups.success) return null;
  const groups: Record<string, unknown>[] = parsedGroups.data.map((entry) => ({
    kind: entry.kind ?? null,
    netuid: entry.netuid ?? null,
    count: entry.count,
    fb: entry.fb ?? null,
    lb: entry.lb ?? null,
    fo: entry.fo ?? null,
    lo: entry.lo ?? null,
  }));
  // An account present with no usable groups is not an answer -- the caller
  // reads the lakehouse rather than publishing an empty card from a shard.
  if (!groups.length) return null;

  // AN ACCOUNT OVER THE CAP IS NOT THIS TIER'S TO ANSWER.
  //
  // The projection aggregates an account's WHOLE history. The live path
  // aggregates the newest ACCOUNT_EVENT_SUMMARY_SCAN_CAP events. Below the cap
  // those are the same set, so the answers are identical -- above it they are
  // not, and the difference is invisible in `event_count` (both clamp to CAP)
  // while `event_kinds` and `subnet_count` silently widen to lifetime.
  //
  // Measured on 5Fv5t8frGG3MKt...: the live path reports 4 kinds across 2
  // subnets, the projection 10 across 3. Same route, different answer depending
  // on which tier served it, which is worse than either answer alone.
  //
  // So this declines above the cap and the lakehouse answers, exactly as it did
  // before the projection existed. That is a small minority of accounts -- the
  // cap is 5,000 lifetime events -- and it costs them nothing they were not
  // already paying.
  const scanned = groups.reduce((n, g) => n + Number(g.count), 0);
  if (scanned > ACCOUNT_EVENT_SUMMARY_SCAN_CAP) return null;

  return {
    groups,
    span: groupsSpan(groups, pointer.through),
    // `scanned` is the account's lifetime event count, already summed above to
    // apply the cap -- reused rather than recomputed so the two decisions
    // cannot disagree about how many events this account has.
    ...readRecent(payload, account, pointer, recentLimit, scanned),
  };
}

/**
 * The window the groups prove this account's folded events sit inside.
 *
 * ALL THREE OR NOTHING. A first without a last bounds only one end, and a
 * bound without `foldFloorMs` cannot say where the folded range stops and the
 * live one begins -- so a caller handed two of the three would have to invent
 * the missing edge, which is how a feed silently loses its newest or oldest
 * rows. Returning null sends that caller back to the unbounded read it already
 * knows how to do.
 */
function groupsSpan(
  groups: readonly Record<string, unknown>[],
  through: string | undefined,
): { firstMs: number; lastMs: number; foldFloorMs: number } | null {
  const foldFloorMs = recentFloorMs(through);
  if (foldFloorMs === null) return null;
  // BOTH FINITE BY CONSTRUCTION, so there is no emptiness guard below: the
  // caller returns before this on `!groups.length`, and every group that
  // reaches the loop contributes two numbers or returns null. A
  // `Number.isFinite` check on the result would be a branch nothing can take,
  // which codecov counts and which reads as safety without being any.
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const group of groups) {
    const fo = group.fo;
    const lo = group.lo;
    // A single null makes the span a guess: this group's events are somewhere
    // unknown, so the range no longer provably contains every event.
    if (typeof fo !== "number" || typeof lo !== "number") return null;
    if (fo < firstMs) firstMs = fo;
    if (lo > lastMs) lastMs = lo;
  }
  return { firstMs, lastMs, foldFloorMs };
}

/**
 * The account's published newest events, and where the head probe resumes.
 *
 * SEPARATE FROM THE GROUPS, and failing separately. A generation published
 * before metagraphed-infra#575 carries no recent map at all, and one published
 * after it may still not carry enough for this caller -- in both cases the
 * AGGREGATE leg is perfectly good and only the feed leg goes back to the
 * lakehouse. Folding the two decisions together would throw away the expensive
 * half to fix the cheap one.
 *
 * A MALFORMED LIST DECLINES rather than being repaired. The same rule the
 * groups follow, for the same reason: a card that is quietly short some events
 * is confidently wrong, which costs more than being slow.
 */
function readRecent(
  payload: Record<string, unknown>,
  account: string,
  pointer: { through?: string; recent_limit?: number },
  need: number,
  lifetimeEvents: number,
): Pick<AccountSummaryProjectionRead, "recent"> {
  const none = { recent: null };
  // Zero asks for the aggregate leg only, and `undefined` is a producer that
  // publishes no recent map. Neither is a failure worth reading further for.
  if (need <= 0) return none;
  const published = pointer.recent_limit;
  if (published === undefined || published < need) return none;

  // The floor before the rows, because a list with nowhere to resume from is
  // unusable: serving it without a probe would freeze the feed at the last
  // complete day the producer folded.
  const floorMs = recentFloorMs(pointer.through);
  if (floorMs === null) return none;

  // PARSED, not indexed. `.record()` is the map's own declaration -- the
  // producer keys it by ss58 and the reader wants one of them -- so a body
  // that is a string, a number or an array is refused here rather than being
  // indexed into and read as "this account has no events".
  const map = AccountSummaryRecentMapSchema.safeParse(payload["recent"]);
  if (!map.success) return none;
  // An account absent from the map has no published events, which for an
  // account that IS in the groups means the producer wrote a partial shard.
  // Declining sends this leg to the lakehouse; it does not zero the feed.
  const parsed = AccountSummaryRecentSchema.safeParse(map.data[account]);
  if (!parsed.success || !parsed.data.length) return none;

  // IS THIS LIST THE NEWEST N, OR MERELY THE NEWEST N THE PRODUCER HAS REACHED?
  //
  // The producer seeds these lists by walking history BACKWARD from the day it
  // folded to, so at any moment they describe a SUFFIX of time. A list built
  // from that suffix is the newest N overall exactly when the suffix already
  // held N of the account's events -- and short of that it is a prefix of the
  // answer, indistinguishable in the payload from an account whose whole
  // history is three events.
  //
  // The shard settles it without another read. `count` on the groups is the
  // account's LIFETIME total (the projection declines above the cap, so these
  // are never a windowed subtotal), so the complete list has exactly
  // `min(published, lifetime)` entries: `published` for an account with more
  // events than that, and every event it has for an account with fewer.
  //
  // DECIDED PER ACCOUNT rather than by a global coverage watermark, which is
  // what the first cut of this did. That version withheld the whole feature
  // until the producer's walk reached SOURCE_FLOOR -- 2,418 days at
  // `batch_days()` of 7, which is 345 passes of a lane throttled to one a day,
  // and it could never have switched itself on. Here every account whose events
  // the walk has already passed is served from the moment they are published,
  // and the rest fall back exactly as they do today.
  if (parsed.data.length < Math.min(published, lifetimeEvents)) return none;
  return { recent: { rows: parsed.data, floorMs } };
}

/**
 * The earliest millisecond this account can have an event, or null.
 *
 * THE ONE BOUND THAT COMPOSES WITH ANYTHING. The account routes carry cursors,
 * offsets and half a dozen optional filters between them, and a windowed read
 * has to agree with all of them. A pure lower bound does not: it removes rows
 * that cannot exist, whatever else is being asked, so every caller can push it
 * into its own `where` and change nothing else.
 *
 * Sound for BOTH answers the projection gives:
 *
 *   ABSENT  the producer writes every shard, so absence from a shard that
 *           exists proves there is nothing at or before `through`.
 *   PRESENT the groups are a LIFETIME aggregate -- the read declines anything
 *           over the scan cap rather than publishing a windowed subtotal -- so
 *           nothing exists before `min(fo)`. Post-fold events sit above
 *           `foldFloorMs`, which is itself above `min(fo)`, so the single floor
 *           still covers the whole history.
 *
 * MAINNET ONLY. The projection describes the default network, so flooring
 * another chain's feed with it would bound that feed against the wrong history
 * -- a wrong answer, where the unbounded walk is merely a slow right one.
 *
 * `recentLimit: 0` on purpose: callers of this want the FLOOR, not the
 * published rows, and asking for rows would read a map it then throws away.
 *
 * AN OPTIMISATION OVER A CORRECT READ, never a precondition for one. Every
 * caller must behave identically when this returns null, which is what makes it
 * safe to add to a route without re-arguing that route's correctness.
 */
export async function accountHistoryFloorMs(
  env: R2SqlEnv | null | undefined,
  account: string,
  network?: ChainNetworkId,
): Promise<number | null> {
  if (network !== undefined && network !== DEFAULT_CHAIN_NETWORK) return null;
  const projected = await loadAccountSummaryProjection(env, account, {
    recentLimit: 0,
  });
  if (projected === null) return null;
  if (projected.absent === true) return projected.floorMs;
  return projected.span?.firstMs ?? null;
}
