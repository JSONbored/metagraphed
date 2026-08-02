// Account-identity reads served from the lakehouse when the Postgres tier
// misses. Same posture as the sibling cold tiers: rows feed the SAME
// formatters the Postgres tier feeds (src/account-identity.ts and
// src/account-identity-history.ts), filters decline rather than degrade, and
// the history timeline pages on data-api's exact cursor token.
//
// Latest-only is a frozen snapshot (the refresh workflow wrote through the
// box), so captured_at tells the caller exactly how current the identity is.
// That is the honest trade: an identity most accounts set once and never
// touch again is far better served stale than degraded to "no identity".

import { buildAccountIdentity, IDENTITY_FIELDS } from "./account-identity.ts";
import { buildAccountIdentityHistory } from "./account-identity-history.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber, safeSs58Literal } from "./r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "./r2-sql-blocks.ts";

// Both SELECT lists are derived from the same exported field set data-api's
// reads are built on: latest-only is account + the 7 identity fields +
// captured_at; history swaps the account/captured_at frame for id/observed_at
// and the diff hash. Restating either by hand is how tiers drift apart.
const LATEST_COLUMNS = `account, ${IDENTITY_FIELDS.join(", ")}, captured_at`;
const HISTORY_COLUMNS = `id, observed_at, ${IDENTITY_FIELDS.join(", ")}, identity_hash`;

/** The (observed_at, id) pair the history feed pages on, mirroring data-api. */
const CURSOR_ARITY = 2;

/**
 * One account's latest-only identity. Returns null when the lakehouse cannot
 * answer, so the caller keeps its schema-stable "no identity" fallback.
 */
export async function loadAccountIdentityColdTier(
  env: Env | null | undefined,
  ss58: string,
): Promise<ReturnType<typeof buildAccountIdentity> | null> {
  // An unusable address is a decline, not an unfiltered scan: it reaches a
  // string-built query (R2 SQL has no bound parameters), so it must pass the
  // SS58 guard -- refused rather than escaped.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${LATEST_COLUMNS} FROM chain.account_identity WHERE account = '${addr}'`,
  );
  if (rows === null) return null;
  // A confirmed absence is an ANSWER: has_identity:false is the same payload
  // the Postgres tier produces for the (common) never-set-identity case.
  return buildAccountIdentity(rows[0] ?? null, ss58);
}

/**
 * One account's identity-change timeline, newest first -- data-api's exact
 * order, columns, cursor token, and OFFSET-only-without-cursor rule.
 */
export async function loadAccountIdentityHistoryColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildAccountIdentityHistory> | null> {
  const addr = safeSs58Literal(ss58);
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (addr === null || limit === null || offset === null || limit <= 0)
    return null;
  // R2 SQL has no OFFSET; past this depth the over-fetch stops being a
  // reasonable trade and declining beats serving a page that is quietly wrong.
  if (offset > OFFSET_EMULATION_CAP) return null;

  const where = [`account = '${addr}'`];
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // data-api's exact 2-part tuple seek; an invalid token means page 1,
    // exactly as data-api treats it.
    where.push(`(observed_at, id) < (${cursor[0]}, ${cursor[1]})`);
  }
  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;

  const rows = await r2SqlQuery(
    env,
    `SELECT ${HISTORY_COLUMNS} FROM chain.account_identity_history` +
      ` WHERE ${where.join(" AND ")}` +
      ` ORDER BY observed_at DESC, id DESC LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so paging survives a
  // tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.id),
      ])
    : null;
  return buildAccountIdentityHistory(page, ss58, { limit, offset, nextCursor });
}
