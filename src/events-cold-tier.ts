// Account-event reads served from the lakehouse when the Postgres tier
// misses. Third member of the cold-tier family (blocks, extrinsics, now
// events), same posture throughout: rows feed the SAME src/account-events.ts
// formatters the Postgres tier feeds, filters decline rather than degrade,
// and cursors are data-api's own tokens so paging survives a tier transition.
//
// ONE DELIBERATE SIMPLIFICATION, equivalence argued not assumed. data-api
// reads an account's events as TWO scans (hotkey = X, then coldkey = X AND
// hotkey <> X) merged client-side -- an index-shape optimization for
// Postgres. R2 SQL has no indexes to shape around, so this tier issues the
// single disjunction `(hotkey = X OR coldkey = X)`. The row SETS are
// identical: the two-scan form's second branch merely excludes rows the
// first already returned, which a single OR cannot double-count. (OR support
// verified on the live engine, 2026-08-02.)
//
// NO SEAM GATE HERE EITHER, for the reason spelled out at the top of
// src/extrinsics-cold-tier.ts: the seam picks between two sources and this
// family has one, so the lakehouse's own empty answer is more truthful than a
// prediction made from a four-table `min` watermark.
//
// TWO STREAMS, ONE BLOCK. Everything above reads `chain.account_events`, the
// curated projection that names an account. `loadBlockChainEventsColdTier` at
// the bottom reads `chain.chain_events`, the RAW every-event stream, and it
// lives here rather than in a module of its own precisely because the two
// per-block readers must sit side by side: `/blocks/{n}/events` and
// `/blocks/{n}/chain-events` are two views of one block, and #9260 happened
// because one of them had a reader and the other did not. The raw one is the
// larger stream (894M rows against the projection's own count) and its rows go
// through formatChainEvent, the SAME formatter the D1 hot tier feeds -- so a
// caller cannot tell which tier answered, which is the entire point.

import {
  buildAccountEvents,
  buildBlockEvents,
  buildSubnetEvents,
} from "./account-events.ts";
import {
  CHAIN_EVENT_COLUMNS,
  formatChainEvent,
  type ChainEventApi,
} from "./chain-detail-hot-tier.ts";
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
const EVENT_COLUMNS =
  "block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, " +
  "netuid, uid, amount_tao, alpha_amount, observed_at";

/** The 3-part key the account-events feed pages on, mirroring data-api. */
const CURSOR_ARITY = 3;

export interface AccountEventsQuery {
  limit: number;
  offset?: number | null;
  cursor?: unknown;
  kind?: unknown;
  netuid?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

/**
 * One account's events (hotkey OR coldkey side), newest first. Returns null
 * when the lakehouse cannot answer faithfully, so the caller keeps its
 * existing fallback.
 */
export async function loadAccountEventsColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: AccountEventsQuery,
): Promise<ReturnType<typeof buildAccountEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offset > OFFSET_EMULATION_CAP) return null;

  // An unusable address is a decline, not an unfiltered scan of every account.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const where = [`(hotkey = '${addr}' OR coldkey = '${addr}')`];

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
    where.push(`event_kind = '${kind}'`);
  }
  for (const [value, clause] of [
    [query.netuid, "netuid ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // data-api's exact 3-part tuple seek; an invalid token means page 1,
    // exactly as data-api treats it.
    where.push(
      `(observed_at, block_number, event_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }

  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where.join(" AND ")}` +
      ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
      ` LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ])
    : null;
  return buildAccountEvents(page, ss58, { limit, offset, nextCursor });
}

export interface SubnetEventsQuery {
  limit: number;
  offset?: number | null;
  cursor?: unknown;
  kind?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

/**
 * One subnet's events, newest first.
 *
 * NOT A PORT OF A POSTGRES QUERY — there was nothing to port. data-api never
 * registered `/api/v1/subnets/:netuid/events`, so this route's
 * tryPostgresTier call has always missed and the handler has always fallen
 * through to buildSubnetEvents([]) — the feed read empty even while the box
 * was alive. Live proof of the gap: /subnets/1/events reported event_count 0
 * while /subnets/1/stake-flow counted 1,142 stake events over the same subnet
 * and window, both derived from this one stream.
 *
 * The shape is therefore taken from the account feed above rather than from a
 * prior query: same table, same SELECT list, same newest-first ordering, and
 * the SAME 3-part (observed_at, block_number, event_index) cursor token — so a
 * client paging this feed uses tokens interchangeable with the account feed's,
 * and both hand rows to formatters that share formatAccountEvent.
 *
 * Verified against the live engine before shipping (2026-08-03): netuid = 1
 * returns real rows newest-first, `event_kind` + block-range filters compose
 * (861 rows for StakeAdded over blocks 8,700,000-8,759,336), and the tuple
 * seek continues correctly past its cursor.
 */
export async function loadSubnetEventsColdTier(
  env: Env | null | undefined,
  netuid: number,
  query: SubnetEventsQuery,
): Promise<ReturnType<typeof buildSubnetEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offset > OFFSET_EMULATION_CAP) return null;

  // An unusable netuid is a decline, not an unfiltered scan of every subnet.
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const where = [`netuid = ${subnet}`];

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
    where.push(`event_kind = '${kind}'`);
  }
  for (const [value, clause] of [
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    where.push(
      `(observed_at, block_number, event_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }

  // Cursor pages never carry an offset, mirroring the account feed.
  const paged = cursor ? 0 : offset;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where.join(" AND ")}` +
      ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
      ` LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ])
    : null;
  return buildSubnetEvents(page, subnet, { limit, offset, nextCursor });
}

/**
 * Every event in one block, in natural read order (event_index ASC — the one
 * feed in this family that is not newest-first, because a block is read
 * top-to-bottom). `ref` is a height or a block hash.
 */
export async function loadBlockEventsColdTier(
  env: Env | null | undefined,
  ref: string,
  page: { limit: number; offset?: number | null },
): Promise<ReturnType<typeof buildBlockEvents> | null> {
  const limit = safeBlockNumber(page.limit);
  const offset = safeBlockNumber(page.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offset > OFFSET_EMULATION_CAP) return null;

  const height = await resolveBlockHeight(env, ref);
  if (height === null) return null;

  const rows = await r2SqlQuery(
    env,
    `SELECT ${EVENT_COLUMNS} FROM chain.account_events ` +
      `WHERE block_number = ${height} ` +
      `ORDER BY event_index ASC LIMIT ${limit + offset}`,
  );
  if (rows === null) return null;
  const window = offset > 0 ? rows.slice(offset) : rows;
  return buildBlockEvents(window, ref, height, { limit, offset });
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

/** The payload `/api/v1/blocks/{n}/chain-events` has always published, built
 * here from lakehouse rows and by src/chain-detail-hot-tier.ts from D1 rows. */
export interface BlockChainEventsColdResult {
  block_number: number;
  count: number;
  events: ChainEventApi[];
}

/**
 * Every RAW chain event in one block, in natural read order (#9260).
 *
 * THE ROUTE THIS CLOSES WAS EMPTY FOR ALL OF HISTORY. #9240 gave
 * `/blocks/{n}/chain-events` a hot tier above the decode seam and deliberately
 * left the cold leg null, so the ~8.76M blocks at or below the seam answered
 * `ok: true` with `events: []` -- indistinguishable from a block that emitted
 * nothing, and contradicted by the block header's own `event_count` (block
 * 1,000 advertised 21 while this route served 0). The rows were there the whole
 * time: `chain.chain_events`, verified row-for-row during the migration.
 *
 * NO LIMIT, deliberately, and matching the hot tier exactly. A block is a
 * bounded unit -- the largest observed carries 667 chain events
 * (src/chain-detail-prune.ts's measured per-block maxima) -- so there is no
 * page to serve, and a cap chosen "for safety" would silently truncate the one
 * block that exceeded it into a shorter feed that still looked complete.
 *
 * `args` is an opaque JSON string in Iceberg exactly as it is TEXT in D1, and
 * it is decoded ONCE, by formatChainEvent, through the serve-time normalizers
 * both tiers already share -- never a second decoder for the same bytes.
 *
 * Returns null when the lakehouse cannot answer (unconfigured, failed query,
 * or a ref that resolves to no height), so the caller keeps its own decline or
 * schema-stable empty rather than inventing one here.
 */
export async function loadBlockChainEventsColdTier(
  env: Env | null | undefined,
  ref: string,
): Promise<BlockChainEventsColdResult | null> {
  const height = await resolveBlockHeight(env, ref);
  if (height === null) return null;

  const rows = await r2SqlQuery(
    env,
    `SELECT ${CHAIN_EVENT_COLUMNS} FROM chain.chain_events ` +
      `WHERE block_number = ${height} ORDER BY event_index ASC`,
  );
  if (rows === null) return null;
  const events = rows
    .map(formatChainEvent)
    .filter((event): event is ChainEventApi => Boolean(event));
  return { block_number: height, count: events.length, events };
}
