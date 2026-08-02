// Subnet-identity-history reads served from the lakehouse when the Postgres
// tier misses -- both the per-subnet timeline and the network-wide feed read
// the same subnet_identity_history table, so both live here. Same posture as
// the sibling cold tiers: rows feed the SAME formatters the Postgres tier
// feeds, filters decline rather than degrade, and the per-subnet timeline
// pages on data-api's exact cursor token.
//
// The table is append-only and frozen at the export: identity changes after
// the box died are not recorded anywhere, so this tier serves the verified
// history as-is -- observed_at on each entry says how current it is.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "./r2-sql-blocks.ts";
import { buildSubnetIdentityHistory } from "./subnet-identity-history.ts";
import {
  buildChainIdentityHistory,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "./chain-identity-history.ts";

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. The network feed adds netuid up front, exactly as
 * data-api's own network-feed query does. */
const IDENTITY_COLUMNS =
  "id, block_number, observed_at, subnet_name, symbol, description, " +
  "github_repo, subnet_url, discord, logo_url, identity_hash";

/** The (observed_at, id) pair the per-subnet timeline pages on. */
const CURSOR_ARITY = 2;

/**
 * One subnet's identity-change timeline, newest first. Returns null when the
 * lakehouse cannot answer, so the caller keeps its schema-stable empty.
 */
export async function loadSubnetIdentityHistoryColdTier(
  env: Env | null | undefined,
  netuid: unknown,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildSubnetIdentityHistory> | null> {
  // Every interpolated value passes a literal guard -- R2 SQL has no bound
  // parameters, so a value that fails its guard declines the whole query.
  const n = safeBlockNumber(netuid);
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (n === null || limit === null || offset === null || limit <= 0)
    return null;
  // R2 SQL has no OFFSET; past this depth the over-fetch stops being a
  // reasonable trade and declining beats serving a page that is quietly wrong.
  if (offset > OFFSET_EMULATION_CAP) return null;

  const where = [`netuid = ${n}`];
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
    `SELECT ${IDENTITY_COLUMNS} FROM chain.subnet_identity_history` +
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
  return buildSubnetIdentityHistory(page, n, { limit, offset, nextCursor });
}

/**
 * The network-wide identity-change feed: every subnet's rows, most recent
 * first, capped. No cursor and no offset -- the route has neither, matching
 * data-api's own single-shot LIMIT query.
 */
export async function loadChainIdentityHistoryColdTier(
  env: Env | null | undefined,
  query: { limit?: unknown } = {},
): Promise<ReturnType<typeof buildChainIdentityHistory> | null> {
  // An absent limit takes the route default, exactly as data-api resolves it.
  // A present-but-unusable or out-of-range one DECLINES rather than being
  // clamped: the handler has already 400'd anything invalid, so a bad value
  // here is a direct caller this tier must not silently reinterpret.
  const cap =
    query.limit == null
      ? CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT
      : safeBlockNumber(query.limit);
  if (cap === null || cap <= 0 || cap > CHAIN_IDENTITY_HISTORY_LIMIT_MAX)
    return null;

  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, ${IDENTITY_COLUMNS} FROM chain.subnet_identity_history` +
      // data-api's exact feed order: newest block first, netuid as a stable
      // tiebreak, id last so same-block rows keep a total order.
      ` ORDER BY block_number DESC, netuid ASC, id DESC LIMIT ${cap}`,
  );
  if (rows === null) return null;
  return buildChainIdentityHistory(rows, { limit: cap });
}
