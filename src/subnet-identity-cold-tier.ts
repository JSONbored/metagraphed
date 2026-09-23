import { readD1Metadata } from "./d1-metadata-read.ts";
// Subnet identity timelines and the network feed select their current D1
// owner before the archived tier. Both stores share canonical formatters.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import { offsetBeyondEmulationCap } from "./cold-tier-offset.ts";
import { buildSubnetIdentityHistory } from "./subnet-identity-history.ts";
import {
  buildChainIdentityHistory,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "./chain-identity-history.ts";
import type { SubnetIdentityHistoryRow } from "../generated/lakehouse/types.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

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
  env: R2SqlEnv | null | undefined,
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

  const where = [`netuid = ${n}`];
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // data-api's exact 2-part tuple seek; an invalid token means page 1,
    // exactly as data-api treats it.
    where.push(`(observed_at, id) < (${cursor[0]}, ${cursor[1]})`);
  }
  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;

  // `IDENTITY_COLUMNS` is every column of the generated row except `netuid`,
  // and this read is already scoped to one -- so that column would be a
  // constant in every row. `Omit` names which one is missing and why.
  const native = await readD1Metadata<Omit<SubnetIdentityHistoryRow, "netuid">>(
    env,
    "subnet_identity_history",
    `SELECT ${IDENTITY_COLUMNS} FROM subnet_identity_history WHERE netuid = ?` +
      (cursor ? " AND (observed_at, id) < (?, ?)" : "") +
      " ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?",
    [n, ...(cursor ?? []), limit, paged],
  );
  if (native === undefined && offsetBeyondEmulationCap(offset)) return null;
  const rows =
    native !== undefined
      ? native
      : await r2SqlQuery<Omit<SubnetIdentityHistoryRow, "netuid">>(
          env,
          `SELECT ${IDENTITY_COLUMNS} FROM chain.subnet_identity_history` +
            ` WHERE ${where.join(" AND ")}` +
            ` ORDER BY observed_at DESC, id DESC LIMIT ${limit + paged}`,
        );
  if (rows === null) return null;

  const page = native === undefined && paged > 0 ? rows.slice(paged) : rows;
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
  env: R2SqlEnv | null | undefined,
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

  // The network feed puts `netuid` back, so this one is the whole generated
  // row -- the same list, differing by exactly the column the scoped read drops.
  const native = await readD1Metadata<SubnetIdentityHistoryRow>(
    env,
    "subnet_identity_history",
    `SELECT netuid, ${IDENTITY_COLUMNS} FROM subnet_identity_history ORDER BY block_number DESC, netuid ASC, id DESC LIMIT ?`,
    [cap],
  );
  const rows =
    native !== undefined
      ? native
      : await r2SqlQuery<SubnetIdentityHistoryRow>(
          env,
          `SELECT netuid, ${IDENTITY_COLUMNS} FROM chain.subnet_identity_history` +
            // data-api's exact feed order: newest block first, netuid as a stable
            // tiebreak, id last so same-block rows keep a total order.
            ` ORDER BY block_number DESC, netuid ASC, id DESC LIMIT ${cap}`,
        );
  if (rows === null) return null;
  return buildChainIdentityHistory(rows, { limit: cap });
}
