// Subnet-hyperparameter reads served from the lakehouse when the Postgres
// tier misses. Same posture as the sibling cold tiers (blocks, extrinsics,
// events): rows feed the SAME formatters the Postgres tier feeds, filters
// decline rather than degrade, and history pages on data-api's exact cursor
// token so paging survives a tier transition.
//
// THE SNAPSHOT IS FROZEN AT THE EXPORT, and that is fine. subnet_hyperparams
// was refreshed by a box-side poller that died with the box, so this tier
// serves the last verified capture rather than a live read -- captured_at
// says exactly how current the answer is, and serving that beats serving the
// schema-stable null these routes would otherwise degrade to.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "./r2-sql-blocks.ts";
import {
  buildSubnetHyperparams,
  SUBNET_HYPERPARAMS_INSERT_COLUMNS,
} from "./subnet-hyperparams.ts";
import { buildSubnetHyperparamsHistory } from "./subnet-hyperparams-history.ts";

// Both SELECT lists are DERIVED from the same exported column set the write
// path and data-api's reads are built on, rather than restated: 35 columns is
// too many to keep aligned by hand, and a drifted list here would hand the
// shared formatter a different shape than the Postgres tier does.
//
// Latest-only mirrors data-api exactly: every insert column except netuid
// (already known from the WHERE clause). History carries the same parameter
// fields (no netuid/block_number/captured_at -- history has its own
// block_number and observed_at up front) plus id and the diff hash.
const LATEST_COLUMNS = SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1).join(", ");
const HISTORY_COLUMNS = `id, block_number, observed_at, ${SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(
  1,
  -2,
).join(", ")}, hyperparams_hash`;

/** The (observed_at, id) pair the history feed pages on, mirroring data-api. */
const CURSOR_ARITY = 2;

/**
 * One subnet's latest hyperparameters. Returns null when the lakehouse cannot
 * answer, so the caller keeps its existing schema-stable fallback.
 */
export async function loadSubnetHyperparamsColdTier(
  env: Env | null | undefined,
  netuid: unknown,
): Promise<ReturnType<typeof buildSubnetHyperparams> | null> {
  // netuid reaches a string-built query (R2 SQL has no bound parameters), so
  // it must pass the integer guard -- refused rather than escaped.
  const n = safeBlockNumber(netuid);
  if (n === null) return null;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${LATEST_COLUMNS} FROM chain.subnet_hyperparams WHERE netuid = ${n} LIMIT 1`,
  );
  if (rows === null) return null;
  // A confirmed absence is an ANSWER: hyperparameters:null is the same payload
  // the Postgres tier produces for an unknown netuid, not a tier failure.
  return buildSubnetHyperparams(rows[0] ?? null, n);
}

/**
 * One subnet's hyperparameter-change timeline, newest first -- data-api's
 * exact order, columns, cursor token, and OFFSET-only-without-cursor rule.
 */
export async function loadSubnetHyperparamsHistoryColdTier(
  env: Env | null | undefined,
  netuid: unknown,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildSubnetHyperparamsHistory> | null> {
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
    // The same 2-part tuple seek data-api issues for this token. An invalid
    // token decodes to null and means page 1 -- data-api's exact behavior.
    where.push(`(observed_at, id) < (${cursor[0]}, ${cursor[1]})`);
  }
  // Cursor pages never carry an offset (the cursor already narrows past prior
  // pages), mirroring data-api's `OFFSET only when no cursor`.
  const paged = cursor ? 0 : offset;

  const rows = await r2SqlQuery(
    env,
    `SELECT ${HISTORY_COLUMNS} FROM chain.subnet_hyperparams_history` +
      ` WHERE ${where.join(" AND ")}` +
      // EXACTLY data-api's order: the cursor token encodes this composite
      // key, so a different order would mis-seek its tokens.
      ` ORDER BY observed_at DESC, id DESC LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so a client can page
  // seamlessly across a tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.id),
      ])
    : null;
  return buildSubnetHyperparamsHistory(page, n, { limit, offset, nextCursor });
}
