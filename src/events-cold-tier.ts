// Native account and raw-event readers preserve the shared formatters, filters
// and cursor contracts. Missing or invalid coverage declines the whole read.
import {
  buildAccountEvents,
  buildBlockEvents,
  buildSubnetEvents,
} from "./account-events.ts";
import {
  formatChainEvent,
  type ChainEventApi,
} from "./chain-detail-hot-tier.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { type ChainNetworkId } from "./chain-network.ts";
interface FeedKeyed {
  observed_at?: unknown;
  block_number?: unknown;
  event_index?: unknown;
}
import {
  safeBlockNumber,
  safeHexLiteral,
  safeNameLiteral,
  safeSs58Literal,
} from "./history-readers.ts";
import { offsetBeyondEmulationCap } from "./cold-tier-offset.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadIndexedAccountFeedPage } from "./indexed-account-feeds.ts";
import type { AccountFeedSelector } from "./history-account-feed.ts";
import {
  readSelectedHistoryBlock,
  readSelectedHistoryHash,
} from "./indexed-history-store.ts";
import {
  AccountEventsRowSchema,
  ChainEventsRowSchema,
} from "../schemas-src/lakehouse.ts";
import {
  parquetReadBudget,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

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

/** Called after the route's existing literal validation and cursor decoder. */
function indexedEventFilters(
  query: AccountEventsQuery,
  cursor: number[] | null,
): Pick<
  AccountFeedSelector,
  "kind" | "netuid" | "blockStart" | "blockEnd" | "cursor"
> {
  return {
    kind: query.kind == null ? null : String(query.kind),
    netuid: query.netuid == null ? null : Number(query.netuid),
    blockStart: query.blockStart == null ? undefined : Number(query.blockStart),
    blockEnd: query.blockEnd == null ? undefined : Number(query.blockEnd),
    cursor: cursor ? [cursor[0], cursor[1], cursor[2]] : null,
  };
}

export async function loadAccountEventsColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: AccountEventsQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildAccountEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  // An unusable address is a decline, not an unfiltered scan of every account.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
  }
  for (const [value] of [
    [query.netuid, "netuid ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);

  const paged = cursor ? 0 : offset;
  const filters = indexedEventFilters(query, cursor);
  const indexed = await loadIndexedAccountFeedPage(
    env,
    [
      { ...filters, side: "hotkey", account: ss58 },
      { ...filters, side: "coldkey", account: ss58 },
    ],
    limit,
    paged,
    network,
  );
  return indexed == null ? null : pageOf(indexed, ss58, limit, offset);
}

/** The native reader has already applied offset and cursor selection. */
function pageOf<Row extends FeedKeyed & Record<string, unknown>>(
  rows: Row[],
  ss58: string,
  limit: number,
  offset: number,
): ReturnType<typeof buildAccountEvents> {
  const page = rows;
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
 * tryDataApiTier call has always missed and the handler has always fallen
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
  env: HistoryReadEnv | null | undefined,
  netuid: number,
  query: SubnetEventsQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildSubnetEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  // An unusable netuid is a decline, not an unfiltered scan of every subnet.
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
  }
  for (const [value] of [
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);

  // Cursor pages never carry an offset, mirroring the account feed.
  const paged = cursor ? 0 : offset;
  const indexed = await loadIndexedAccountFeedPage(
    env,
    [
      {
        ...indexedEventFilters(query, cursor),
        netuid: subnet,
        side: "all",
        account: "*",
      },
    ],
    limit,
    paged,
    network,
  );
  if (indexed == null) return null;
  const page = indexed;
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
  env: HistoryReadEnv | null | undefined,
  ref: string,
  page: { limit: number; offset?: number | null },
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlockEvents> | null> {
  const limit = safeBlockNumber(page.limit);
  const offset = safeBlockNumber(page.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  const budget = parquetReadBudget();
  const height = await resolveBlockHeight(env, ref, network, budget);
  if (height === null) return null;
  const selected = await readSelectedHistoryBlock(
    env,
    "account_events",
    height,
    network,
    budget,
  );
  if (selected == null) return null;
  const parsed = AccountEventsRowSchema.array().safeParse(selected);
  if (!parsed.success) return null;
  const rows = parsed.data
    .sort((a, b) => Number(a.event_index) - Number(b.event_index))
    .slice(0, limit + offset);
  const window = offset > 0 ? rows.slice(offset) : rows;
  // A short read PROVES the end of the block was reached, so `rows.length` is
  // the block's true total -- free, no second query. A full read means there may
  // be more beyond the window, so the total stays unknown and `event_count`
  // falls back to the page length rather than inventing a ceiling.
  const totalCount = rows.length < limit + offset ? rows.length : null;
  return buildBlockEvents(window, ref, height, { limit, offset, totalCount });
}

/** A block hash resolved to its height, or the height itself. */
async function resolveBlockHeight(
  env: HistoryReadEnv | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
  budget: ParquetReadBudget = parquetReadBudget(),
): Promise<number | null> {
  const asNumber = safeBlockNumber(ref);
  if (asNumber !== null) return asNumber;
  const asHash = safeHexLiteral(ref);
  if (asHash === null) return null;
  const indexed = await readSelectedHistoryHash(
    env,
    "blocks",
    asHash,
    network,
    budget,
  );
  return indexed == null || Array.isArray(indexed)
    ? null
    : safeBlockNumber(indexed.block_number);
}

/** The payload `/api/v1/blocks/{n}/chain-events` has always published, built
 * here from lakehouse rows and by src/chain-detail-hot-tier.ts from store rows. */
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
  env: HistoryReadEnv | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<BlockChainEventsColdResult | null> {
  const budget = parquetReadBudget();
  const height = await resolveBlockHeight(env, ref, network, budget);
  if (height === null) return null;

  const indexed = await readSelectedHistoryBlock(
    env,
    "chain_events",
    height,
    network,
    budget,
  );
  if (indexed == null) return null;
  const rows = indexed;
  const parsed = ChainEventsRowSchema.array().safeParse(rows);
  if (!parsed.success) return null;
  const events = parsed.data
    .sort((a, b) => Number(a.event_index) - Number(b.event_index))
    .map(formatChainEvent)
    .filter((event): event is ChainEventApi => Boolean(event));
  return { block_number: height, count: events.length, events };
}
