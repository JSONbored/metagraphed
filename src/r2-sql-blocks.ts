// Chain-blocks reads served from the lakehouse (R2 SQL) instead of the
// decommissioned box's Postgres.
//
// PAYLOAD PARITY IS THE WHOLE POINT. These loaders return rows into the SAME
// pure formatters the Postgres tier feeds -- src/blocks.ts's buildBlock and
// buildBlockFeed -- so a caller cannot tell which tier answered. Anything that
// re-implemented the shaping here would drift from the published contract the
// moment either side changed.
//
// R2 SQL LIMITS, established by probing the live warehouse rather than by
// reading docs (2026-08-02):
//   - SELECT / WHERE / multi-column ORDER BY / LIMIT: supported.
//   - OFFSET: NOT SUPPORTED ("unsupported feature: OFFSET clause is not
//     supported"). Handled by over-fetching limit+offset rows and slicing,
//     which is exact for the shallow offsets a UI actually issues and is
//     refused outright past OFFSET_EMULATION_CAP rather than silently
//     returning the wrong page.
//   - Tuple comparison for the Postgres tier's 2-part cursor is not relied on
//     here; the cursor degrades to its block_number component, which orders
//     identically for this table (observed_at and block_number are both
//     monotonic in practice, and block_number is authoritative).
//   - ~1-2s per query, so every caller must sit behind the existing edge
//     cache. See src/r2-sql.ts's header for the measurements.

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
import { type ChainNetworkId, chainTable } from "./chain-network.ts";
import {
  ACCOUNT_EVENTS_COLUMNS,
  BLOCKS_COLUMNS,
  EXTRINSICS_COLUMNS,
} from "../generated/lakehouse/types.ts";
import type {
  AccountEventsRow,
  BlocksRow,
  ExtrinsicsRow,
} from "../generated/lakehouse/types.ts";
import {
  r2SqlQuery,
  safeBlockNumber,
  safeHexLiteral,
  safeSs58Literal,
} from "./r2-sql.ts";
import type { R2SqlEnv } from "./r2-sql.ts";
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

/** Columns the formatters need — kept identical to the Postgres tier's SELECT
 * list so both tiers hand the formatter the same shape. */
// FROM THE GENERATED TUPLE, not retyped. generated/lakehouse/types.ts is
// snapshotted from the live Iceberg catalog (#10315/#10350), so a column
// renamed upstream lands here as a compile error instead of a query selecting a
// column the table no longer has. Byte-identical to the literal it replaces --
// this is a no-op today and a tripwire tomorrow, which is the whole point of
// generating the tuple at all.
const BLOCK_COLUMNS = BLOCKS_COLUMNS.join(", ");
const ECONOMICS_EXTRINSIC_COLUMNS = EXTRINSICS_COLUMNS.join(", ");
const ECONOMICS_EVENT_COLUMNS = ACCOUNT_EVENTS_COLUMNS.join(", ");

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

async function loadBlockEconomicsFromR2Sql(
  env: R2SqlEnv | null | undefined,
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
  const [extrinsics, accountEvents] = await Promise.all([
    selectedExtrinsics === undefined
      ? r2SqlQuery<ExtrinsicsRow>(
          env,
          `SELECT ${ECONOMICS_EXTRINSIC_COLUMNS} FROM ${chainTable("extrinsics", network)} ` +
            `WHERE block_number = ${height} ORDER BY extrinsic_index ASC`,
        )
      : selectedExtrinsics,
    selectedEvents === undefined
      ? r2SqlQuery<AccountEventsRow>(
          env,
          `SELECT ${ECONOMICS_EVENT_COLUMNS} FROM ${chainTable("account_events", network)} ` +
            `WHERE block_number = ${height} ORDER BY event_index ASC`,
        )
      : selectedEvents,
  ]);
  if (extrinsics === null || accountEvents === null) return null;
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

/** An author is an SS58 address; accept only the character set that can be,
 * since R2 SQL has no bound parameters and this value reaches a string-built
 * query. Anything else is refused rather than escaped. */
export function safeAuthorLiteral(value: unknown): string | null {
  // Delegates to the shared SS58 guard so block authors and extrinsic signers
  // cannot drift apart into two subtly different notions of a valid address.
  return safeSs58Literal(value);
}

/**
 * The recent-block feed. Returns the formatted payload, or null when the
 * lakehouse cannot answer (unconfigured, failed, or a request this tier
 * cannot serve faithfully) so the caller keeps its existing fallback.
 */
export async function loadBlockFeedFromR2Sql(
  env: R2SqlEnv | null | undefined,
  query: BlockFeedQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
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
  env: R2SqlEnv | null | undefined,
  query: BlockFeedQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
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
  const sql =
    `SELECT ${BLOCK_COLUMNS} FROM ${chainTable("blocks", network)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // observed_at-leading, EXACTLY data-api's order: the cursor token encodes
    // this composite key, so a different order would mis-seek its tokens.
    ` ORDER BY observed_at DESC, block_number DESC LIMIT ${limit + paged}`;

  const selected = await readRetainedBlockRows(
    env,
    where,
    limit + paged,
    network,
    Date.now(),
    { minEvents: query.minEvents, minExtrinsics: query.minExtrinsics },
  );
  const rows = selected === undefined ? await r2SqlQuery(env, sql) : selected;
  if (rows === null) return null;

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
  env: R2SqlEnv | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
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
  const table = chainTable("blocks", network);

  // CHAIN-WALK NAV, AT NO EXTRA QUERY (#11462). This tier served
  // `prev_block_number`/`next_block_number` as permanently null, so #1853's
  // navigation was structurally present and dead on the tier that answers this
  // route -- a client walking the chain got null and stopped, with nothing in
  // the payload saying the tier simply did not populate them.
  //
  // The Postgres tier gets them from a SECOND query for its nearest stored
  // neighbours, and copying that here was the option this was parked on: one
  // more warehouse query per read, on a route measured at a 3,647ms median
  // against an account that has been rate-limited before (#9465).
  //
  // It does not need one. The ref IS the height, so the block and both
  // neighbours are three adjacent values of the column this table is ordered
  // by -- widening `= N` to `N-1 .. N+1` returns all three in the SAME query.
  // R2 SQL prunes columns well and files poorly (src/r2-sql.ts), and a
  // three-height range opens exactly the parts the point lookup already did.
  //
  // PRESENCE, NOT ARITHMETIC. A neighbour is reported only when this tier
  // actually holds it, so nav never links to a block the API cannot then
  // serve. That is the Postgres tier's own rule -- nearest STORED neighbour --
  // narrowed to +/-1, which is the same answer on a contiguous chain and an
  // honest null at a coverage edge instead of a link into a gap.
  if (asNumber !== null) {
    const rows = await r2SqlQuery<BlocksRow>(
      env,
      `SELECT ${BLOCK_COLUMNS} FROM ${table} ` +
        `WHERE block_number >= ${Math.max(asNumber - 1, 0)} ` +
        `AND block_number <= ${asNumber + 1} ` +
        `ORDER BY block_number ASC LIMIT 3`,
    );
    // A CONFIGURED lakehouse that could not answer is a decline, not "no such
    // block" (#11424). This route was measured at 15,085ms -- AT the 15s
    // `QUERY_TIMEOUT_MS` -- on 2026-08-16, and the bare null reached the caller
    // as the same payload a confirmed absence produces, which is the one
    // distinction the comment below already insists on. With NO lakehouse bound
    // the null stands: there is nothing to read and the caller's own floor is
    // correct.
    if (rows === null) {
      return hasRetainedHistoryStore(env) ? declineBlock(ref) : null;
    }
    // A confirmed absence is an ANSWER: buildBlock(undefined, ref) is the same
    // "no such block" payload the Postgres tier produces, and returning it here
    // (rather than null) stops the caller re-deriving it.
    return buildBlock(
      recordOrNull(rows.find((row) => blockHeight(row) === asNumber)),
      ref,
      neighboursOf(rows, asNumber),
    );
  }

  const rows = await r2SqlQuery<BlocksRow>(
    env,
    `SELECT ${BLOCK_COLUMNS} FROM ${table} WHERE block_hash = '${asHash}' LIMIT 1`,
  );
  if (rows === null) {
    return hasRetainedHistoryStore(env) ? declineBlock(ref) : null;
  }
  const row = recordOrNull(rows[0]);
  // From the ROW, not from `recordOrNull`'s widened copy: `blockHeight` reads a
  // typed column, and going through `Record<string, unknown>` would put this
  // back on the untyped-read ratchet the generated catalog types exist to keep
  // at zero.
  const height = blockHeight(rows[0]);
  if (row === null || height === null) return buildBlock(row, ref);

  // A HASH REF CANNOT FOLD ITS NEIGHBOURS IN, because the height is not known
  // until the row comes back -- so this is the one path that pays a second
  // query, and it pays it for parity rather than leaving nav null on half the
  // ref forms. Intermittent nav is worse than none: it reads as data rather
  // than as a tier limit.
  //
  // ONE COLUMN over three heights, which is the cheapest shape this engine
  // has, and it lands on a route the edge already holds for 600s (#11016), so
  // it is paid on a cache miss by a minority ref form.
  //
  // A FAILED NEIGHBOUR READ STILL SERVES THE BLOCK. Nav is a hint; the block
  // is the answer. Declining the whole payload because a navigation aid could
  // not be read would trade the thing the caller asked for against the thing
  // it did not.
  const neighbours = await r2SqlQuery<BlocksRow>(
    env,
    `SELECT block_number FROM ${table} ` +
      `WHERE block_number >= ${Math.max(height - 1, 0)} ` +
      `AND block_number <= ${height + 1} ` +
      `ORDER BY block_number ASC LIMIT 3`,
  );
  return buildBlock(
    row,
    ref,
    neighbours === null ? undefined : neighboursOf(neighbours, height),
  );
}

/**
 * One lakehouse block with its canonical economic summary.
 *
 * The Iceberg block row intentionally stores only header/count columns. Its
 * companion extrinsic and account-event tables are committed atomically to the
 * same decoded ceiling, so a present block makes an empty companion result a
 * real zero and a failed companion query an honest unavailable summary.
 * Numeric refs run all three reads concurrently; hash refs resolve their height
 * first, because the companion tables carry no block hash.
 */
export async function loadBlockWithEconomicsFromR2Sql(
  env: R2SqlEnv | null | undefined,
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
      loadBlockEconomicsFromR2Sql(env, height, network, budget),
    ]);
    if (!detail?.block || economics === null) return detail;
    return { ...detail, block: withBlockEconomics(detail.block, economics) };
  }

  const detail = await loadBlockFromR2Sql(env, ref, network, budget);
  const resolved = safeBlockNumber(detail?.block?.block_number);
  if (!detail?.block || resolved === null) return detail;
  const economics = await loadBlockEconomicsFromR2Sql(
    env,
    resolved,
    network,
    budget,
  );
  return economics === null
    ? detail
    : { ...detail, block: withBlockEconomics(detail.block, economics) };
}

/**
 * One row's height, coerced -- the engine can hand back a numeric string.
 *
 * Takes a ROW, not `unknown`, and carries no shape guard: `r2SqlQuery`
 * validates every row against the catalog schema and throws on one that does
 * not match, so a non-object can never arrive here. A `typeof row === "object"`
 * check would be an unreachable branch, which is not safety -- the same reading
 * src/account-feeds-cold-tier.ts applies to its own `?? 0`.
 *
 * The null it DOES return is reachable and load-bearing: every catalog column is
 * nullable, so `block_number` can legitimately arrive null.
 */
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
