// The two objects the account-summary projection publishes to R2, and which no
// REST route serves (metagraphed-infra#580):
//
//   metagraph/projections/account-summary/current.json      -> pointer
//   metagraph/projections/account-summary/{gen}/{shard}.json -> shard payload
//
// See the sibling surface-aliases.ts header for why these live under
// artifacts/ rather than routes/.
//
// WHY THEY ARE DECLARED HERE RATHER THAN READ FIELD-BY-FIELD. The reader used
// to index the pointer directly -- `pointer["shard_count"]`, `Number(...)`,
// `typeof stamp === "string"` -- and it was careful, which is exactly what made
// it worth replacing: the care lived in one function and could not be reused,
// audited, or drift-checked against the producer. Producer and reader sit in
// different REPOSITORIES here, so a shape nobody has written down is a shape
// nothing can compare.
//
// THE CARE IS PRESERVED, NOT DISCARDED. Two of the reader's checks encode real
// incidents and are kept as schema rules rather than comments:
//
//   * `generated_at` must be a STRING. `Date.parse(String(12345))` is a valid
//     date -- the year 12345 -- so a numeric field would read as fresh forever
//     and the staleness bound would never fire. `z.string()` refuses the
//     coercion that `Number` would have allowed.
//   * `shard_count` must be a positive integer. The reader derives an object
//     key from it (`shard_of(account) % shard_count`), so a zero or a float
//     does not fail loudly -- it addresses an object that does not exist, which
//     reads as "this account has no events".
import { z } from "zod";

// THE TABLE'S OWN DECLARATION, extended rather than restated. A second copy of
// this vocabulary drifts by one side gaining a column, and the narrower one
// then accepts what it does not describe -- which `validate:schema-shape-
// duplicates` refuses, and rightly: the reader merges these rows with rows
// selected straight out of the same table.
import { AccountEventsRowSchema } from "../lakehouse.ts";

/**
 * `current.json` -- names the generation that is currently readable.
 *
 * `through` is OPTIONAL because it was added after the first generations were
 * published (metagraphed-infra#580) and a pointer written before it is still
 * valid to read. It is the producer's own bookkeeping -- the last complete day
 * folded into the totals these shards were built from -- and the reader does
 * not consult it; declaring it here is what stops it being an undeclared field
 * on a published object, which is the defect #9831 was filed about.
 */
export const AccountSummaryPointerSchema = z.object({
  schema_version: z.number().int(),
  generation: z.string().min(1),
  shard_count: z.number().int().positive(),
  generated_at: z.string().min(1),
  account_count: z.number().int().nonnegative(),
  through: z.string().min(1).optional(),
  /**
   * How many events per account the shards carry in their `recent` map
   * (metagraphed-infra#575), when they carry one at all.
   *
   * THE LIMIT TRAVELS WITH THE DATA. `ACCOUNT_SUMMARY_RECENT_LIMIT` lives in
   * this repository and the producer lives in another, so a reader that
   * assumed the published N matched its own would serve a short feed the
   * moment the two diverged -- and no CI here could see it. Declaring the N
   * actually written lets the reader DECLINE when the artifact carries fewer
   * than it needs, exactly as `shard_count` already travels rather than being
   * agreed by convention.
   *
   * OPTIONAL, because every generation published before #575 lacks it, and
   * those pointers are still valid to read for their aggregate leg. Absent
   * means "no recent map" -- not "some unknown number" -- so the reader falls
   * back to the lakehouse for that leg alone.
   */
  recent_limit: z.number().int().positive().optional(),
  /**
   * The earliest day the recent lists cover, as the producer states it.
   *
   * DECLARED BECAUSE IT IS PUBLISHED, which is #9831's rule -- but it was
   * declared LATE, and the cost is the whole reason `.strict()` is gone from
   * this object. See below.
   *
   * The producer seeds the lists by walking history backward, so at any
   * moment they describe a suffix of time; this names where that suffix
   * starts. The reader does not consult it -- `readRecent` settles
   * completeness per account against the groups' lifetime count, which is
   * exact where a global watermark is conservative.
   */
  recent_from: z.string().min(1).optional(),
});

/**
 * WHY THIS ONE OBJECT IS NOT `.strict()`, unlike everything around it.
 *
 * It was, and on 2026-08-16T17:30Z that took the entire account family's hot
 * tier down in production, silently. The account-summary lane recovered after
 * two days out (metagraphed-infra#599, #601) and its first generation published
 * a field this schema did not declare:
 *
 *   {"generation":"20260816T173020Z", ... ,"recent_limit":10,
 *    "recent_from":"2026-07-16","through":"2026-08-15"}
 *
 * `.strict()` rejected the whole pointer over `recent_from`. Not the field --
 * the POINTER. `loadAccountSummaryProjection` returned null for every account,
 * so the card lost its projection, `readRecent` never ran, and
 * `accountHistoryFloorMs` returned null -- which made every scan floor #11425
 * had just added INERT. Measured: `/events?limit=5` back to 21s. Nothing
 * failed; every route quietly took its slow path.
 *
 * THE PRODUCER IS IN ANOTHER REPOSITORY AND DEPLOYS INDEPENDENTLY. That is the
 * whole argument, and it is the same one `container-lane-status.ts` makes for
 * the five status objects. Weigh the two failure modes:
 *
 *   strict + a field the producer ADDED  -> total, silent loss of the hot tier
 *                                           for every account. Happened.
 *   strip  + a field the producer TYPO'D -> that one field reads as absent, the
 *                                           reader declines that leg alone and
 *                                           falls back. Slow, and correct.
 *
 * The second is strictly better, and this reader is built for it: every
 * optional field's absence already means "fall back to the lakehouse", so
 * stripping degrades along a path that is tested rather than into a hole.
 *
 * NOT `.passthrough()`, which the no-passthrough gate bans and which would be
 * the wrong tool anyway: zod's default STRIPS what it does not describe rather
 * than carrying it onward, so nothing undeclared reaches a caller. The
 * declared fields are validated exactly as strictly as before.
 */

/**
 * One group row inside a shard: an account's events of one kind on one subnet.
 *
 * `netuid` is NULLABLE and that is load-bearing -- Transfer and Deposit are
 * coldkey balance events with no subnet, and collapsing them into a numbered
 * one would attribute balance movement to a subnet that never saw it.
 */
export const AccountSummaryGroupSchema = z
  .object({
    // `kind` and `count`, NOT the accumulator's `event_kind` and `n`. The
    // producer renames both on the way out (`iter_shards`), so declaring the
    // table's column names here would describe a payload nobody publishes --
    // the exact drift this file exists to make impossible.
    kind: z.string().nullable(),
    netuid: z.number().int().nullable(),
    count: z.number().int().nonnegative(),
    fb: z.number().int().nullable(),
    lb: z.number().int().nullable(),
    fo: z.number().int().nullable(),
    lo: z.number().int().nullable(),
  })
  .strict();

/**
 * One account's groups inside a shard object.
 *
 * PER-ACCOUNT, NOT PER-SHARD, and that is a serving-cost decision rather than
 * an oversight. A shard object carries every account that hashes to it -- on
 * the order of a thousand -- and a request reads exactly ONE of them. Parsing
 * the whole envelope would validate ~1,000 accounts' groups to answer about
 * one, on a path whose entire reason for existing is that the alternative was
 * too expensive. So the envelope is checked structurally and the account's own
 * array is parsed.
 *
 * `{}` for `accounts` is legitimate: every shard is published, including empty
 * ones, because the reader cannot tell an absent object from an account that
 * does not exist -- the first is a decline and the second is an answer.
 */
export const AccountSummaryGroupsSchema = z.array(AccountSummaryGroupSchema);

/**
 * One published event inside a shard's `recent` map (metagraphed-infra#575).
 *
 * THE COLUMNS ARE THE LAKEHOUSE TABLE'S, not a shape invented here. The reader
 * merges these rows with rows the head probe selects straight out of
 * `chain.account_events`, and the two go into the same feed -- so a field named
 * differently on one side would surface as a missing value on half a card
 * rather than as an error. `tests/account-summary-projection.test.ts` pins the
 * key set against the generated `ACCOUNT_EVENTS_COLUMNS`, so a column added to
 * the table fails here rather than being silently dropped from the projection.
 *
 * EVERY VALUE IS NULLABLE except the two that identify the event. `hotkey` is
 * null on WeightsSet, `netuid` on Transfer and Deposit, and the amount columns
 * on anything that is not a balance movement -- nullability here is the table's,
 * not a concession.
 */
export const AccountSummaryRecentEventSchema = AccountEventsRowSchema
  // REQUIRED and CLOSED, which is the whole difference from the table's own
  // declaration. `AccountEventsRowSchema` is partial and open because a READ
  // selects a projection and often an aggregate alias that is not a column at
  // all. This is a PUBLISHED artifact: the producer writes every column of
  // every row, so a missing one is a producer bug and an extra one is a
  // vocabulary the reader would silently drop from half a merged feed.
  .required()
  .extend({
    // The event's identity, and the reason these three cannot be null here
    // while the table permits it: the reader de-duplicates the projection's
    // rows against the head probe's on (block_number, event_index), and sorts
    // the merged page on all three. A null would collapse distinct events onto
    // one key, or sort as zero and bury a real event at the bottom of the card.
    block_number: z.int().nonnegative(),
    event_index: z.int().nonnegative(),
    observed_at: z.int().nonnegative(),
  })
  .strict();

/** One published event, as the reader gets it back from `safeParse`. */
export type AccountSummaryRecentEvent = z.infer<
  typeof AccountSummaryRecentEventSchema
>;

/** One account's published newest events, newest first. */
export const AccountSummaryRecentSchema = z.array(
  AccountSummaryRecentEventSchema,
);

/**
 * A shard's `recent` map, keyed by ss58.
 *
 * LAZY IN ITS VALUES on purpose, exactly as `accounts` is handled: a shard
 * carries ~1,000 accounts and a request reads ONE. Declaring the values as
 * `unknown` checks the ENVELOPE -- that this is a keyed object rather than a
 * string, a number or an array -- and leaves the one account's array to be
 * parsed properly by `AccountSummaryRecentSchema`. Parsing all thousand would
 * spend the saving this whole tier exists to make.
 */
export const AccountSummaryRecentMapSchema = z.record(z.string(), z.unknown());
