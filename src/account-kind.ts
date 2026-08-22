// WHICH identity system an `account_id` belongs to (#11573).
//
// ## THE COLLISION THIS EXISTS TO PREVENT
//
// `api_quota_daily`, `api_key_blocks` and `api_key_usage_daily` each key on a
// bare `integer` account_id, with NO foreign key -- so nothing in the database
// says which table those integers come from, and nothing stopped a second id
// space being written into the same column.
//
// There are now two. `rpc_accounts` (ss58/wallet login) and `github_accounts`
// (OAuth) are separate tables with separate `id` sequences and their own
// `tier` columns, both in the same low range today. Without a discriminator,
// `github_accounts.id = 5` and `rpc_accounts.id = 5` share a quota row, a
// blocklist entry and a usage row -- one caller drawing down another's budget,
// and a block on one silently blocking the other.
//
// ## WHY A DISCRIMINATOR RATHER THAN ONE ACCOUNT TABLE
//
// Unifying the two behind a single identity is arguably the better end state,
// but it is a different decision: `rpc_accounts.ss58` is NOT NULL UNIQUE and a
// GitHub user has no ss58, so unification restructures the account model and
// with it how billing attaches. A discriminator is the standard modelling for
// polymorphic ownership, is complete on its own, and does not foreclose that.
//
// ## WHY THE VOCABULARY LIVES HERE
//
// One owner, imported by the writers, the readers and the tests, so the strings
// in the migration's CHECK constraint and the strings in the code cannot drift
// apart. A value that reaches the database outside this union fails the CHECK
// rather than silently creating a third, unqueryable id space -- which is the
// failure mode this whole module exists to end.

/** Every identity system that can own a metered account row. */
export const ACCOUNT_KINDS = ["rpc", "github"] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * `rpc_accounts` -- what every row written before #11573 belongs to.
 *
 * The migration's column default, restated here so a writer that has no kind
 * to hand lands on the same value the database would have chosen rather than
 * on whichever member happens to be first in the union.
 */
export const DEFAULT_ACCOUNT_KIND: AccountKind = "rpc";

/**
 * Narrow an untrusted value to a kind, or null.
 *
 * Null rather than a default on purpose: a caller that cannot say which
 * identity system an id belongs to must not have one guessed for it, because
 * guessing is exactly how two id spaces end up in one column. The one place a
 * default is correct is a row that predates the discriminator, and the
 * database already applies it.
 */
export function asAccountKind(value: unknown): AccountKind | null {
  return typeof value === "string" &&
    (ACCOUNT_KINDS as readonly string[]).includes(value)
    ? (value as AccountKind)
    : null;
}
