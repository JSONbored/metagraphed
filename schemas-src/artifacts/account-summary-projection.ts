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
export const AccountSummaryPointerSchema = z
  .object({
    schema_version: z.number().int(),
    generation: z.string().min(1),
    shard_count: z.number().int().positive(),
    generated_at: z.string().min(1),
    account_count: z.number().int().nonnegative(),
    through: z.string().min(1).optional(),
  })
  .strict();

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
