// Extrinsic reads served from the lakehouse when the Postgres tier misses.
//
// Same posture as src/blocks-cold-tier.ts, and the same reason: with the
// self-hosted box gone these routes would degrade to schema-stable empties,
// which is honest but useless when the rows exist and are verified in R2.
// Every loader here feeds the SAME formatters the Postgres tier feeds
// (src/extrinsics.ts), so a caller cannot tell which tier answered.
//
// ONE HONEST LIMIT, STATED UP FRONT. Verified extrinsics stop at the export
// height. Blocks past it are captured as raw SCALE bytes but not yet decoded,
// so no source can answer for that range -- unlike blocks, there is no D1 leg
// to stitch on. This tier therefore serves history and returns a confirmed
// EMPTY above the seam rather than inventing a partial row. A caller reading
// `observed_at` can see exactly how current the answer is; nothing is
// presented as more recent than it is.
//
// R2 SQL has no bound parameters, so every interpolated value passes a
// literal guard that REFUSES rather than escapes. A filter this tier cannot
// express safely makes the whole query decline -- returning rows that ignore
// a caller's filter would be worse than returning none, because the caller
// cannot tell it happened.

import {
  buildAccountExtrinsics,
  buildBlockExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
} from "./extrinsics.ts";
import { formatAccountEvent } from "./account-events.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
  r2SqlQuery,
  safeBlockNumber,
  safeHexLiteral,
  safeNameLiteral,
  safeSs58Literal,
} from "./r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "./r2-sql-blocks.ts";

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. */
const EXTRINSIC_COLUMNS =
  "block_number, extrinsic_index, extrinsic_hash, signer, call_module, " +
  "call_function, success, fee_tao, tip_tao, call_args, observed_at";

/** Events emitted by one extrinsic, embedded in the detail payload. The
 * column list and the bound match the Postgres tier's embedded-events query
 * exactly, and rows go through the same formatAccountEvent before embedding
 * -- buildExtrinsic embeds what it is given verbatim, so handing it raw rows
 * would leak an unformatted shape into a payload callers already parse. */
const EVENT_COLUMNS =
  "block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, " +
  "netuid, uid, amount_tao, alpha_amount, observed_at";
const MAX_EMBEDDED_EVENTS = 50;

/** EXACTLY the Postgres tier's feed order. The observed_at-leading key is not
 * cosmetic: the public cursor token encodes this composite key, so a tier that
 * ordered differently would emit tokens the other tier mis-seeks on. The two
 * extra columns matter too -- extrinsics share a block, so no prefix of this
 * key is a total order on its own. */
const FEED_ORDER =
  "ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC";

export interface ExtrinsicFeedQuery {
  limit: number;
  offset?: number | null;
  /** The raw ?cursor token. Decoded with the SAME codec and arity the
   * Postgres tier uses, so tokens round-trip across tiers. */
  cursor?: unknown;
  signer?: unknown;
  module?: unknown;
  callFunction?: unknown;
  success?: unknown;
  block?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
  from?: unknown;
  to?: unknown;
}

/** The cursor tuple every extrinsic feed pages on, mirroring data-api. */
const CURSOR_ARITY = 3;

/** Build the WHERE terms, or null if any filter cannot be expressed safely. */
function feedPredicates(query: ExtrinsicFeedQuery): string[] | null {
  const where: string[] = [];

  if (query.signer != null) {
    const s = safeSs58Literal(query.signer);
    if (s === null) return null;
    where.push(`signer = '${s}'`);
  }
  for (const [value, column] of [
    [query.module, "call_module"],
    [query.callFunction, "call_function"],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const name = safeNameLiteral(value);
    if (name === null) return null;
    where.push(`${column} = '${name}'`);
  }
  for (const [value, clause] of [
    [query.block, "block_number ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
    [query.from, "observed_at >="],
    [query.to, "observed_at <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  if (query.success != null) {
    // Only a real boolean: coercing a string here would turn "false" into TRUE
    // and silently invert the caller's filter.
    if (typeof query.success !== "boolean") return null;
    where.push(`success = ${query.success ? "TRUE" : "FALSE"}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // The same 3-part tuple seek the Postgres tier issues (tuple comparison
    // verified supported on the live engine, 2026-08-02). An invalid token
    // decodes to null and is treated as NO cursor -- exactly what data-api
    // does -- so both tiers serve the identical page for the identical
    // request, malformed tokens included.
    where.push(
      `(observed_at, block_number, extrinsic_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }
  return where;
}

/** Rows for a feed-shaped query, offset emulated by over-fetch + slice. */
async function feedRows(
  env: Env | null | undefined,
  query: ExtrinsicFeedQuery,
  extraWhere: string[] = [],
): Promise<{
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  nextCursor: string | null;
} | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  // R2 SQL has no OFFSET; past this depth the over-fetch stops being a
  // reasonable trade and declining beats serving a page that is quietly wrong.
  if (offset > OFFSET_EMULATION_CAP) return null;

  const base = feedPredicates(query);
  if (base === null) return null;
  const where = [...base, ...extraWhere];

  // Cursor pages never carry an offset -- the cursor already narrows past
  // prior pages -- mirroring data-api's `OFFSET only when no cursor`.
  const paged = decodeCursor(query.cursor, CURSOR_ARITY) ? 0 : offset;

  const sql =
    `SELECT ${EXTRINSIC_COLUMNS} FROM chain.extrinsics` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ${FEED_ORDER} LIMIT ${limit + paged}`;

  const rows = await r2SqlQuery(env, sql);
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so a client can page
  // seamlessly across a tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.extrinsic_index),
      ])
    : null;
  return { rows: page, limit, offset, nextCursor };
}

/** The recent-extrinsic feed, and the filtered variants built on it. */
export async function loadExtrinsicFeedColdTier(
  env: Env | null | undefined,
  query: ExtrinsicFeedQuery,
): Promise<ReturnType<typeof buildExtrinsicFeed> | null> {
  const page = await feedRows(env, query);
  if (page === null) return null;
  return buildExtrinsicFeed(page.rows, {
    limit: page.limit,
    offset: page.offset,
    nextCursor: page.nextCursor,
  });
}

/** Every extrinsic in one block. `ref` is a height or a block hash. */
export async function loadBlockExtrinsicsColdTier(
  env: Env | null | undefined,
  ref: string,
  page: { limit: number; offset?: number | null },
): Promise<ReturnType<typeof buildBlockExtrinsics> | null> {
  const height = await resolveBlockHeight(env, ref);
  if (height === null) return null;
  const rows = await feedRows(
    env,
    { limit: page.limit, offset: page.offset ?? 0 },
    [`block_number = ${height}`],
  );
  if (rows === null) return null;
  return buildBlockExtrinsics(rows.rows, ref, rows.nextCursor, {
    limit: rows.limit,
    offset: rows.offset,
  });
}

/** One account's extrinsics, newest first. */
export async function loadAccountExtrinsicsColdTier(
  env: Env | null | undefined,
  ss58: string,
  page: {
    limit: number;
    offset?: number | null;
    cursor?: unknown;
    blockStart?: unknown;
    blockEnd?: unknown;
  },
): Promise<ReturnType<typeof buildAccountExtrinsics> | null> {
  // An unusable address is a decline, not an unfiltered scan of every signer.
  if (safeSs58Literal(ss58) === null) return null;
  const rows = await feedRows(env, {
    limit: page.limit,
    offset: page.offset ?? 0,
    cursor: page.cursor,
    signer: ss58,
    blockStart: page.blockStart,
    blockEnd: page.blockEnd,
  });
  if (rows === null) return null;
  return buildAccountExtrinsics(rows.rows, ss58, {
    limit: rows.limit,
    offset: rows.offset,
    nextCursor: rows.nextCursor,
  });
}

/** A block hash resolved to its height, or the height itself. */
async function resolveBlockHeight(
  env: Env | null | undefined,
  ref: string,
): Promise<number | null> {
  const asNumber = safeBlockNumber(ref);
  if (asNumber !== null) return asNumber;
  const asHash = safeHexLiteral(ref);
  if (asHash === null) return null;
  const rows = await r2SqlQuery(
    env,
    `SELECT block_number FROM chain.blocks WHERE block_hash = '${asHash}' LIMIT 1`,
  );
  if (rows === null) return null;
  return safeBlockNumber(rows[0]?.block_number);
}

/**
 * One extrinsic by hash or by the composite `<block>-<index>` id, with the
 * account_events it emitted embedded exactly as the Postgres tier embeds them.
 */
export async function loadExtrinsicColdTier(
  env: Env | null | undefined,
  ref: string,
): Promise<ReturnType<typeof buildExtrinsic> | null> {
  let predicate: string;

  const composite = /^(\d+)-(\d+)$/.exec(String(ref).trim());
  if (composite) {
    const block = safeBlockNumber(composite[1]);
    const index = safeBlockNumber(composite[2]);
    if (block === null || index === null) return null;
    predicate = `block_number = ${block} AND extrinsic_index = ${index}`;
  } else {
    const hash = safeHexLiteral(ref);
    if (hash === null) return null;
    predicate = `extrinsic_hash = '${hash}'`;
  }

  const rows = await r2SqlQuery(
    env,
    `SELECT ${EXTRINSIC_COLUMNS} FROM chain.extrinsics WHERE ${predicate} LIMIT 1`,
  );
  if (rows === null) return null;
  const row = rows[0];
  // A confirmed absence is an ANSWER, and the same schema-stable payload the
  // Postgres tier produces -- not null, which would mean "tier unavailable".
  if (!row) return buildExtrinsic(undefined, ref);

  const block = safeBlockNumber(row.block_number);
  const index = safeBlockNumber(row.extrinsic_index);
  let events: unknown[] = [];
  if (block !== null && index !== null) {
    const found = await r2SqlQuery(
      env,
      `SELECT ${EVENT_COLUMNS} FROM chain.account_events ` +
        `WHERE block_number = ${block} AND extrinsic_index = ${index} ` +
        `ORDER BY event_index LIMIT ${MAX_EMBEDDED_EVENTS}`,
    );
    // Events failing is NOT a reason to withhold the extrinsic: the Postgres
    // tier serves an empty event list for pre-migration rows too, so an empty
    // list here is a shape the caller already handles.
    events = (found ?? []).map(formatAccountEvent).filter(Boolean);
  }
  return buildExtrinsic(row, ref, events);
}
