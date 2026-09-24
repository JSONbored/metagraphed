// Retained block feeds use D1; details and economics use verified R2 indexes.
// All rows pass through the canonical public formatters.

import { hasRetainedHistoryStore } from "./retained-history-store.ts";
import {
  buildBlock,
  buildBlockFeed,
  declineBlock,
  withBlockEconomics,
} from "./blocks.ts";
import { summarizeBlockEconomics } from "./block-economics.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { offsetBeyondEmulationCap } from "./cold-tier-offset.ts";
import { type ChainNetworkId } from "./chain-network.ts";
import type { BlocksRow } from "../generated/lakehouse/types.ts";
import {
  safeBlockNumber,
  safeHexLiteral,
  safeSs58Literal,
} from "./history-readers.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import {
  BlocksRowSchema,
  ExtrinsicsRowSchema,
  AccountEventsRowSchema,
} from "../schemas-src/lakehouse.ts";
import {
  readSelectedHistoryBlock,
  readSelectedHistoryHash,
} from "./indexed-history-store.ts";
import {
  parquetReadBudget,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";
import { recordOrNull } from "./read-store.ts";
import { readRetainedBlockRows } from "./retained-blocks-d1.ts";

/**
 * Convert a lakehouse DOUBLE back into the decimal wire shape consumed by the
 * canonical economics reducer. The table itself is already the precision
 * boundary; fixed-point text prevents a small value rendered in exponent form
 * from being mistaken for an undecodable amount.
 */
function lakehouseDecimal(value: unknown): unknown {
  return typeof value === "number"
    ? value.toFixed(18).replace(/\.?0+$/, "")
    : value;
}

async function loadBlockEconomicsFromIndexes(
  env: HistoryReadEnv | null | undefined,
  height: number,
  network?: ChainNetworkId,
  budget = parquetReadBudget(),
) {
  const selectedExtrinsics = await readSelectedHistoryBlock(
    env,
    "extrinsics",
    height,
    network,
    budget,
  );
  const selectedEvents = await readSelectedHistoryBlock(
    env,
    "account_events",
    height,
    network,
    budget,
  );
  const extrinsics = selectedExtrinsics,
    accountEvents = selectedEvents;
  if (extrinsics == null || accountEvents == null) return null;
  const parsedExtrinsics = ExtrinsicsRowSchema.array().safeParse(extrinsics);
  const parsedEvents = AccountEventsRowSchema.array().safeParse(accountEvents);
  if (!parsedExtrinsics.success || !parsedEvents.success) return null;
  return summarizeBlockEconomics(
    parsedExtrinsics.data.map((row) => ({
      ...row,
      fee_tao: lakehouseDecimal(row.fee_tao),
      tip_tao: lakehouseDecimal(row.tip_tao),
    })),
    parsedEvents.data.map((row) => ({
      ...row,
      amount_tao: lakehouseDecimal(row.amount_tao),
    })),
  );
}

export {
  OFFSET_EMULATION_CAP,
  currentOffsetCapDeclineGeneration,
  offsetBeyondEmulationCap,
} from "./cold-tier-offset.ts";

export interface BlockFeedQuery {
  limit: number;
  offset: number;
  /** The raw ?cursor token: data-api's dot-joined (observed_at, block_number)
   * pair, decoded with the shared codec so tokens round-trip across tiers. */
  cursor?: unknown;
  author?: string | null;
  specVersion?: number | null;
  blockStart?: number | null;
  blockEnd?: number | null;
  from?: unknown;
  to?: unknown;
  minExtrinsics?: number | null;
  minEvents?: number | null;
  /** INTERNAL continuation for the seam stitch (src/blocks-cold-tier.ts):
   * strictly-below-this-block, applied on top of whatever public cursor the
   * caller sent. Distinct from `cursor` because the stitch needs an exclusive
   * block ceiling, not a public token. */
  ceilingBlock?: number | null;
}

/** The cursor pair the blocks feed pages on, mirroring data-api. */
const BLOCKS_CURSOR_ARITY = 2;

/** Preserve the public SS58 author guard before building D1 predicates. */
export function safeAuthorLiteral(value: unknown): string | null {
  // Delegates to the shared SS58 guard so block authors and extrinsic signers
  // cannot drift apart into two subtly different notions of a valid address.
  return safeSs58Literal(value);
}

/**
 * The recent-block feed. Returns the formatted payload, or null when the
 * native history cannot answer (unconfigured, failed, or a request this tier
 * cannot serve faithfully) so the caller keeps its existing fallback.
 */
export async function loadBlockFeedFromR2Sql(
  env: HistoryReadEnv | null | undefined,
  query: BlockFeedQuery,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlockFeed> | null> {
  const page = await fetchBlockRowsFromR2Sql(env, query, network);
  if (page === null) return null;
  return buildBlockFeed(page.rows as never[], {
    limit: page.limit,
    offset: page.offset,
    nextCursor: page.nextCursor,
  });
}

/**
 * The same query as {@link loadBlockFeedFromR2Sql}, stopping at the RAW rows.
 *
 * Callers that stitch this tier together with another source need the rows
 * before formatting: feeding an already-formatted payload back through the
 * formatter would run it twice, and a formatter is only guaranteed to be
 * correct on the shape it was designed for. One formatting pass, at the end,
 * over rows from every source.
 */
export async function fetchBlockRowsFromR2Sql(
  env: HistoryReadEnv | null | undefined,
  query: BlockFeedQuery,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<{
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  nextCursor: string | null;
} | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  // Refuse rather than mis-serve: see OFFSET_EMULATION_CAP.
  if (offsetBeyondEmulationCap(offset)) return null;

  const where: string[] = [];
  const author = safeAuthorLiteral(query.author);
  if (query.author != null) {
    // An author filter we cannot express safely must not silently widen the
    // result to every author.
    if (author === null) return null;
    where.push(`author = '${author}'`);
  }
  for (const [value, clause] of [
    [query.specVersion, "spec_version ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
    [query.from, "observed_at >="],
    [query.to, "observed_at <="],
    [query.minExtrinsics, "extrinsic_count >="],
    [query.minEvents, "event_count >="],
    [query.ceilingBlock, "block_number <"],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, BLOCKS_CURSOR_ARITY);
  if (cursor) {
    // The same 2-part tuple seek data-api issues for this token (tuple
    // comparison verified supported on the live engine, 2026-08-02). An
    // invalid token decodes to null and means page 1 -- data-api's exact
    // behavior -- so both tiers serve the identical page for the identical
    // request, malformed tokens included.
    where.push(`(observed_at, block_number) < (${cursor[0]}, ${cursor[1]})`);
  }

  // Cursor pages never carry an offset (the cursor already narrows past
  // prior pages), mirroring data-api's `OFFSET only when no cursor`.
  const paged = cursor ? 0 : offset;
  const selected = await readRetainedBlockRows(
    env,
    where,
    limit + paged,
    network,
    Date.now(),
    { minEvents: query.minEvents, minExtrinsics: query.minExtrinsics },
  );
  const rows = selected;
  if (rows == null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so a client can page
  // seamlessly across a tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
      ])
    : null;
  return { rows: page, limit, offset, nextCursor };
}

/**
 * One block by height or hash. `ref` is whatever the route matched; it is
 * validated here rather than trusted, because it reaches a string-built query.
 */
export async function loadBlockFromR2Sql(
  env: HistoryReadEnv | null | undefined,
  ref: string,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
  budget: ParquetReadBudget = parquetReadBudget(),
): Promise<ReturnType<typeof buildBlock> | null> {
  const asNumber = safeBlockNumber(ref);
  const asHash = asNumber === null ? safeHexLiteral(ref) : null;
  if (asNumber === null && asHash === null) return null;
  const selected =
    asNumber !== null
      ? await readSelectedHistoryBlock(env, "blocks", asNumber, network, budget)
      : await readSelectedHistoryHash(env, "blocks", asHash!, network, budget);
  if (selected !== undefined) {
    if (selected === null) return declineBlock(ref);
    const parsed = BlocksRowSchema.array().safeParse(
      Array.isArray(selected) ? selected : [selected],
    );
    if (!parsed.success) return declineBlock(ref);
    const row = parsed.data[0],
      height = blockHeight(row);
    if (!row || height === null) return buildBlock(recordOrNull(row), ref);
    const neighbours: Partial<BlocksRow>[] = [];
    for (const candidate of [height - 1, height + 1]) {
      if (candidate < 0) continue;
      const found = await readSelectedHistoryBlock(
        env,
        "blocks",
        candidate,
        network,
        budget,
      );
      const neighbour = BlocksRowSchema.array().safeParse(found);
      if (neighbour.success) neighbours.push(...neighbour.data);
    }
    return buildBlock(recordOrNull(row), ref, neighboursOf(neighbours, height));
  }
  return hasRetainedHistoryStore(env) ? declineBlock(ref) : null;
}

/**
 * One retained block with its canonical economic summary.
 *
 * The retained block row intentionally stores only header/count columns. Its
 * companion extrinsic and account-event tables are committed atomically to the
 * same decoded ceiling, so a present block makes an empty companion result a
 * real zero and a failed companion query an honest unavailable summary.
 * Numeric refs run all three reads concurrently; hash refs resolve their height
 * first, because the companion tables carry no block hash.
 */
export async function loadBlockWithEconomicsFromR2Sql(
  env: HistoryReadEnv | null | undefined,
  ref: string,
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlock> | null> {
  // Navigation plus two companion tables can exceed a single-table request
  // allowance when a block has repeated captures. Keep byte/decoding caps shared.
  const budget = parquetReadBudget(24 * 1024 * 1024, 96);
  const height = safeBlockNumber(ref);
  if (height !== null) {
    const [detail, economics] = await Promise.all([
      loadBlockFromR2Sql(env, ref, network, budget),
      loadBlockEconomicsFromIndexes(env, height, network, budget),
    ]);
    if (!detail?.block || economics === null) return detail;
    return { ...detail, block: withBlockEconomics(detail.block, economics) };
  }

  const detail = await loadBlockFromR2Sql(env, ref, network, budget);
  const resolved = safeBlockNumber(detail?.block?.block_number);
  if (!detail?.block || resolved === null) return detail;
  const economics = await loadBlockEconomicsFromIndexes(
    env,
    resolved,
    network,
    budget,
  );
  return economics === null
    ? detail
    : { ...detail, block: withBlockEconomics(detail.block, economics) };
}

/** Validated block rows may still contain a nullable height. */
function blockHeight(row: Partial<BlocksRow> | undefined): number | null {
  return safeBlockNumber(row?.block_number);
}

/**
 * `prev`/`next` from the heights actually returned, never from `height +/- 1`.
 *
 * The distinction is the whole point of reading the range: arithmetic would
 * advertise a neighbour at a coverage edge that this tier cannot serve, and a
 * chain-walk link into a gap is worse than a null that says "the walk stops
 * here". Genesis has no prev and the head has no next, and both fall out of
 * presence without being special-cased.
 */
function neighboursOf(
  rows: readonly Partial<BlocksRow>[],
  height: number,
): { prev: number | null; next: number | null } {
  const heights = new Set(
    rows.map(blockHeight).filter((n): n is number => n !== null),
  );
  return {
    prev: heights.has(height - 1) ? height - 1 : null,
    next: heights.has(height + 1) ? height + 1 : null,
  };
}
