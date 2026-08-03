// The all-events feed served from the lakehouse (#9146).
//
// `chain.chain_events` is the COMPLETE event stream -- every pallet and method,
// 895,485,314 rows spanning blocks 1 -> 8,759,336 -- as opposed to
// `chain.account_events`, which decode.rs curates down to three pallets and
// only the variants with an `extract()` arm. Some kinds exist ONLY here:
// `PrometheusServed` has 18,041 rows in this table and none in the curated one.
//
// A BOUNDED BLOCK WINDOW, AND THAT IS THE WHOLE DESIGN.
//
// The deleted Postgres handler ordered `observed_at` first because
// `chain_events` was a TimescaleDB hypertable partitioned on `observed_at` --
// its own comment says so, and on that engine the ordering let ChunkAppend
// prune to the live head chunk. The lakehouse prunes on `block_number`
// instead, so that ordering is exactly inverted here. Measured 2026-08-03:
//
//   default page, ORDER BY observed_at DESC   1.93 GB
//   ORDER BY block_number DESC, no floor      1.20 GB
//   WHERE block_number >= head-1000             15.8 MB
//   WHERE block_number >= head-5000             18.6 MB
//   WHERE block_number = N (block detail)        1.55 MB
//
// A straight port would therefore ship a ~2 GB scan on every request, against
// shipped cold-tier readers that live at 47-392 MB. The floor is what makes
// this route affordable at all.
//
// COMPLETENESS IS PRESERVED BY THE CURSOR, not by scanning everything. Each
// page reads one window below its ceiling; the next page's ceiling is the
// previous page's floor. A page that does not fill still emits `next_before`
// so a caller can keep walking backwards -- otherwise a sparse
// pallet/method filter would look exhausted after one window when matches
// exist deeper. Paging stops only at block 0.
//
// `block=` needs no window at all: it is a single-block lookup and already
// cheap, so it is passed straight through and stays exact.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber, safeNameLiteral } from "./r2-sql.ts";
import { blocksSeamFloor } from "./blocks-cold-tier.ts";
import {
  SUBNET_LEASE_CREATED_KIND,
  SUBNET_LEASE_TERMINATED_KIND,
} from "./subnet-lease-history.ts";

/** Kept identical to the deleted handler's SELECT list so both tiers hand the
 * caller the same event shape. */
const EVENT_COLUMNS =
  "block_number, event_index, pallet, method, args, phase, extrinsic_index, " +
  "observed_at";

/**
 * How many blocks one page may scan. ~16.7 hours of chain at 12s/block, and
 * 18.6 MB measured unfiltered -- the same order as the extrinsics feed (240 MB)
 * and blocks feed (47 MB) already in production. Widening this is a linear
 * cost: 20,000 blocks measured 72.2 MB.
 */
export const CHAIN_EVENTS_BLOCK_WINDOW = 5_000;

/** data-api's 3-part key for this feed. */
const CURSOR_ARITY = 3;

export interface ChainEventsQuery {
  limit: number;
  pallet?: unknown;
  method?: unknown;
  block?: unknown;
  extrinsic?: unknown;
  cursor?: unknown;
  before?: unknown;
}

export interface ChainEventsPage {
  count: number;
  next_before: number | null;
  next_cursor: string | null;
  events: Record<string, unknown>[];
}

/**
 * One page of the all-events feed, or null when the lakehouse cannot answer
 * faithfully so the caller keeps its schema-stable empty.
 */
export async function loadChainEventsColdTier(
  env: Env | null | undefined,
  query: ChainEventsQuery,
): Promise<ChainEventsPage | null> {
  const limit = safeBlockNumber(query.limit);
  if (limit === null || limit <= 0) return null;

  const where: string[] = [];

  // A filter that cannot be expressed safely DECLINES rather than being
  // dropped -- silently widening a filtered feed to everything would be a
  // wrong answer that looks like a working one.
  for (const [value, column] of [
    [query.pallet, "pallet"],
    [query.method, "method"],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const literal = safeNameLiteral(value);
    if (literal === null) return null;
    where.push(`${column} = '${literal}'`);
  }

  const block = query.block == null ? null : safeBlockNumber(query.block);
  if (query.block != null && block === null) return null;
  const extrinsic =
    query.extrinsic == null ? null : safeBlockNumber(query.extrinsic);
  if (query.extrinsic != null && extrinsic === null) return null;

  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  const before = cursor
    ? null
    : query.before == null
      ? null
      : safeBlockNumber(query.before);
  if (query.before != null && !cursor && before === null) return null;

  let floor = 0;
  if (block !== null) {
    // Single-block lookup: exact, already cheap, no window needed.
    where.push(`block_number = ${block}`);
    if (extrinsic !== null) where.push(`extrinsic_index = ${extrinsic}`);
  } else {
    // The ceiling this page reads down from. A cursor seeks strictly below its
    // own row; `before` is the legacy block-exclusive form.
    const ceiling = cursor
      ? (cursor[1] as number)
      : before !== null
        ? before - 1
        : blocksSeamFloor(env);
    if (!Number.isFinite(ceiling) || ceiling < 0) {
      return { count: 0, next_before: null, next_cursor: null, events: [] };
    }
    floor = Math.max(0, ceiling - CHAIN_EVENTS_BLOCK_WINDOW);
    where.push(`block_number >= ${floor}`);
    where.push(`block_number <= ${ceiling}`);
    if (cursor) {
      // Within the ceiling block, resume strictly after the cursor's event.
      where.push(`(block_number < ${cursor[1]} OR event_index < ${cursor[2]})`);
    }
  }

  const rows = await r2SqlQuery(
    env,
    `SELECT ${EVENT_COLUMNS} FROM chain.chain_events WHERE ${where.join(" AND ")}` +
      ` ORDER BY block_number DESC, event_index DESC LIMIT ${limit}`,
  );
  if (rows === null) return null;

  const last = rows.length === limit ? rows[rows.length - 1] : null;
  if (last) {
    return {
      count: rows.length,
      next_before: safeBlockNumber(last.block_number),
      next_cursor: encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ]),
      events: rows,
    };
  }

  // A SHORT PAGE IS NOT THE END OF THE FEED. The window may simply hold no
  // more matches; older ones can exist below it. Hand back a `before` anchored
  // at the floor so the caller walks to the next window instead of concluding
  // the feed is exhausted -- the difference between a slow filtered scan and a
  // silently truncated one. Only block 0 genuinely ends it, and a single-block
  // lookup has nothing below it to walk to.
  const exhausted = block !== null || floor <= 0;
  return {
    count: rows.length,
    next_before: exhausted ? null : floor,
    next_cursor: null,
    events: rows,
  };
}

/** The `?blocks=` window: default 1000, clamped to the 1-5000 bound the
 * deleted handler enforced, so a stray value cannot widen the scan. */
export const CHAIN_EVENTS_STATS_BLOCKS_DEFAULT = 1_000;
export const CHAIN_EVENTS_STATS_BLOCKS_MAX = 5_000;
/** The deleted handler's own output cap. */
const STATS_GROUP_LIMIT = 100;

export interface ChainEventsStats {
  window_blocks: number;
  groups: number;
  activity: Record<string, unknown>[];
}

/**
 * The pallet.method distribution over the most recent N blocks.
 *
 * MUCH cheaper than the feed because it reads only two columns: measured
 * 1.28 MB at the 1,000-block default and 4.23 MB at the 5,000 cap, against a
 * feed page's 18.6 MB. R2 SQL is columnar, so a narrow projection is what
 * makes an aggregate affordable.
 *
 * The deleted Postgres version needed a whole second `observed_at` bound and a
 * separate head lookup purely so TimescaleDB could exclude chunks -- its own
 * comment records the aggregate scanning ~723M rows and taking 181s without
 * it. None of that applies here: `block_number` IS the lakehouse's pruning
 * key, so the block bound alone does the work it was always meant to.
 */
export async function loadChainEventsStatsColdTier(
  env: Env | null | undefined,
  blocks?: unknown,
): Promise<ChainEventsStats | null> {
  const requested = blocks == null ? null : safeBlockNumber(blocks);
  if (blocks != null && requested === null) return null;
  const window =
    requested === null || requested < 1
      ? CHAIN_EVENTS_STATS_BLOCKS_DEFAULT
      : Math.min(requested, CHAIN_EVENTS_STATS_BLOCKS_MAX);

  const head = blocksSeamFloor(env);
  const rows = await r2SqlQuery(
    env,
    `SELECT pallet, method, COUNT(*) AS count FROM chain.chain_events ` +
      `WHERE block_number > ${head - window} ` +
      // Tie-break on the GROUP BY keys: `count` alone is non-unique, so equal
      // counts could reshuffle between requests and flip which groups survive
      // the LIMIT at the boundary.
      `GROUP BY pallet, method ORDER BY count DESC, pallet ASC, method ASC ` +
      `LIMIT ${STATS_GROUP_LIMIT}`,
  );
  if (rows === null) return null;
  return { window_blocks: window, groups: rows.length, activity: rows };
}

/**
 * Whether the chain has emitted ANY subnet-lease event, chain-wide.
 *
 * `/subnets/{netuid}/lease/history` currently answers with
 * `x-metagraph-degraded: tier_unavailable`, which tells a caller the data is
 * missing. It is not -- no subnet has ever been leased. Verified against
 * `chain.chain_events`, the complete 895M-row stream: `SubnetLeaseCreated` and
 * `SubnetLeaseTerminated` have ZERO rows across all of chain history.
 *
 * A `tier_unavailable` marker on a genuinely empty answer is worse than
 * useless -- it bars the response from the edge cache and tells the caller to
 * retry something that will never change.
 *
 * DELIBERATELY BINARY. `netuid` lives inside the positional `args` JSON for
 * these kinds, and R2 SQL has no JSON extraction (`json_extract`,
 * `get_json_object` and `::json` all return 40004), so a per-subnet filter is
 * not expressible in SQL. Rather than half-decode, this asks only whether ANY
 * lease event exists:
 *
 *   none  -> every subnet's history is legitimately empty, so answer with the
 *            schema-stable empty as a real ANSWER, unmarked and cacheable.
 *   some  -> DECLINE (null). The caller keeps today's marked empty rather than
 *            us guessing which subnet those events belong to. The day leasing
 *            starts, this route needs a real decoder, and declining makes that
 *            visible instead of silently attributing events to netuid 0.
 */
export async function loadSubnetLeaseHistoryColdTier(
  env: Env | null | undefined,
  netuid: number,
): Promise<{ rows: Record<string, unknown>[] } | null> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const rows = await r2SqlQuery(
    env,
    `SELECT block_number FROM chain.chain_events ` +
      `WHERE method IN ('${SUBNET_LEASE_CREATED_KIND}', ` +
      `'${SUBNET_LEASE_TERMINATED_KIND}') LIMIT 1`,
  );
  if (rows === null) return null;
  if (rows.length > 0) return null;
  return { rows: [] };
}
