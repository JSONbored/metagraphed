import { loadIndexedExtrinsicFeedPage } from "./indexed-extrinsic-feeds.ts";
// Hot D1 pages and complete retained R2 indexes share the canonical formatters.
// Missing ownership or incomplete coverage declines; only verified absence is empty.

import {
  buildAccountExtrinsics,
  buildBlockExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
} from "./extrinsics.ts";
import { formatAccountEvent } from "./account-events.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { loadExtrinsicsHeadHotTier } from "./chain-detail-hot-tier.ts";
import {
  safeBlockNumber,
  safeHexLiteral,
  safeNameLiteral,
  safeSs58Literal,
} from "./r2-sql.ts";
import {
  readSelectedHistoryBlock,
  readSelectedHistoryHash,
} from "./indexed-history-store.ts";
import {
  parquetReadBudget,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";
import { offsetBeyondEmulationCap } from "./cold-tier-offset.ts";
import type { ExtrinsicsRow } from "../generated/lakehouse/types.ts";
// The RUNTIME half of the same generated pair. types.ts is the compile-time
// claim; these check it at the boundary.
import {
  AccountEventsRowSchema,
  ExtrinsicsRowSchema,
} from "../schemas-src/lakehouse.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

/** Same embedded-event cap as the public detail contract. */
const MAX_EMBEDDED_EVENTS = 50;

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

/** Preserve public input validation before selecting either native owner. */
function validFeedQuery(query: ExtrinsicFeedQuery): boolean {
  if (query.signer != null && safeSs58Literal(query.signer) === null)
    return false;
  for (const value of [query.module, query.callFunction])
    if (value != null && safeNameLiteral(value) === null) return false;
  for (const value of [
    query.block,
    query.blockStart,
    query.blockEnd,
    query.from,
    query.to,
  ])
    if (value != null && safeBlockNumber(value) === null) return false;
  return query.success == null || typeof query.success === "boolean";
}

/** Rows for a feed-shaped query, offset emulated by over-fetch + slice. */
async function feedRows(
  env: R2SqlEnv | null | undefined,
  query: ExtrinsicFeedQuery,
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
  // Keep the published offset ceiling and its explicit decline marker.
  if (offsetBeyondEmulationCap(offset)) return null;

  if (!validFeedQuery(query)) return null;

  // Cursor pages never carry an offset -- the cursor already narrows past
  // prior pages -- mirroring data-api's `OFFSET only when no cursor`.
  const paged = decodeCursor(query.cursor, CURSOR_ARITY) ? 0 : offset;

  // A full hot-store page answers the complete filtered question. A short
  // page may cross the retained-history seam, so the indexed tier gets it.
  // Offset walks go directly to the historical reader. The hot store is
  // mainnet-only and must seek the same complete cursor tuple as that reader.
  if (
    paged === 0 &&
    (network === undefined || network === DEFAULT_CHAIN_NETWORK)
  ) {
    const cursorToken = decodeCursor(query.cursor, CURSOR_ARITY);
    const hot = await loadExtrinsicsHeadHotTier(env, {
      limit,
      ceilingObservedAt: query.to == null ? null : safeBlockNumber(query.to),
      floorObservedAt: query.from == null ? null : safeBlockNumber(query.from),
      block: query.block == null ? null : safeBlockNumber(query.block),
      cursor: cursorToken as [number, number, number] | null,
      signer: typeof query.signer === "string" ? query.signer : null,
      module: typeof query.module === "string" ? query.module : null,
      callFunction:
        typeof query.callFunction === "string" ? query.callFunction : null,
      success: typeof query.success === "boolean" ? query.success : null,
      blockStart:
        query.blockStart == null ? null : safeBlockNumber(query.blockStart),
      blockEnd: query.blockEnd == null ? null : safeBlockNumber(query.blockEnd),
    });
    if (hot !== null && hot.length === limit) {
      const page = hot as ExtrinsicsRow[];
      const tail = page[page.length - 1]!;
      return {
        rows: page,
        limit,
        offset,
        nextCursor: encodeCursor([
          safeBlockNumber(tail.observed_at),
          safeBlockNumber(tail.block_number),
          safeBlockNumber(tail.extrinsic_index),
        ]),
      };
    }
  }

  {
    const block =
      query.block == null ? undefined : safeBlockNumber(query.block)!;
    const lower =
      query.blockStart == null ? undefined : safeBlockNumber(query.blockStart)!;
    const upper =
      query.blockEnd == null ? undefined : safeBlockNumber(query.blockEnd)!;
    const indexed = await loadIndexedExtrinsicFeedPage(
      env,
      {
        signer: query.signer == null ? undefined : String(query.signer),
        module: query.module == null ? undefined : String(query.module),
        callFunction:
          query.callFunction == null ? undefined : String(query.callFunction),
        success: query.success == null ? undefined : (query.success as boolean),
        blockStart:
          block === undefined ? lower : Math.max(block, lower ?? block),
        blockEnd: block === undefined ? upper : Math.min(block, upper ?? block),
        observedStart:
          query.from == null ? undefined : safeBlockNumber(query.from)!,
        observedEnd: query.to == null ? undefined : safeBlockNumber(query.to)!,
        cursor: decodeCursor(query.cursor, CURSOR_ARITY) as
          [number, number, number] | null,
      },
      limit,
      paged,
      network,
    );
    if (indexed !== undefined) {
      if (indexed === null) return null;
      const tail = indexed.length === limit ? indexed.at(-1)! : null;
      return {
        rows: indexed,
        limit,
        offset,
        nextCursor: tail
          ? encodeCursor([
              safeBlockNumber(tail.observed_at),
              safeBlockNumber(tail.block_number),
              safeBlockNumber(tail.extrinsic_index),
            ])
          : null,
      };
    }
  }

  return null;
}

/** The recent-extrinsic feed, and the filtered variants built on it. */
export async function loadExtrinsicFeedColdTier(
  env: R2SqlEnv | null | undefined,
  query: ExtrinsicFeedQuery,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildExtrinsicFeed> | null> {
  const page = await feedRows(env, query, network);
  if (page === null) return null;
  return buildExtrinsicFeed(page.rows, {
    limit: page.limit,
    offset: page.offset,
    nextCursor: page.nextCursor,
  });
}

/** Every extrinsic in one block. `ref` is a height or a block hash. */
export async function loadBlockExtrinsicsColdTier(
  env: R2SqlEnv | null | undefined,
  ref: string,
  page: { limit: number; offset?: number | null },
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlockExtrinsics> | null> {
  const limit = safeBlockNumber(page.limit),
    offset = safeBlockNumber(page.offset ?? 0);
  if (
    limit === null ||
    offset === null ||
    limit <= 0 ||
    offsetBeyondEmulationCap(offset)
  )
    return null;
  const budget = parquetReadBudget();
  const height = await resolveBlockHeight(env, ref, network, budget);
  if (height === null) return null;
  const selected = await readSelectedHistoryBlock(
    env,
    "extrinsics",
    height,
    network,
    budget,
  );
  if (selected !== undefined) {
    if (selected === null) return null;
    const parsed = ExtrinsicsRowSchema.array().safeParse(selected);
    if (!parsed.success) return null;
    const rows = parsed.data.sort(
      (a, b) =>
        Number(b.observed_at) - Number(a.observed_at) ||
        Number(b.extrinsic_index) - Number(a.extrinsic_index),
    );
    return buildBlockExtrinsics(
      rows.slice(offset, offset + limit),
      ref,
      height,
      { limit, offset },
    );
  }
  return null;
}

/** Signer history uses its own index, never an account-event-derived floor. */
export async function loadAccountExtrinsicsColdTier(
  env: R2SqlEnv | null | undefined,
  ss58: string,
  page: {
    limit: number;
    offset?: number | null;
    cursor?: unknown;
    blockStart?: unknown;
    blockEnd?: unknown;
  },
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildAccountExtrinsics> | null> {
  // An unusable address is a decline, not an unfiltered scan of every signer.
  if (safeSs58Literal(ss58) === null) return null;
  const rows = await feedRows(
    env,
    {
      limit: page.limit,
      offset: page.offset ?? 0,
      cursor: page.cursor,
      signer: ss58,
      blockStart: page.blockStart,
      blockEnd: page.blockEnd,
    },
    network,
  );
  if (rows === null) return null;
  return buildAccountExtrinsics(rows.rows, ss58, {
    limit: rows.limit,
    offset: rows.offset,
    nextCursor: rows.nextCursor,
  });
}

/** A block hash resolved to its height, or the height itself. */
async function resolveBlockHeight(
  env: R2SqlEnv | null | undefined,
  ref: string,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
  budget: ParquetReadBudget = parquetReadBudget(),
): Promise<number | null> {
  const asNumber = safeBlockNumber(ref);
  if (asNumber !== null) return asNumber;
  const asHash = safeHexLiteral(ref);
  if (asHash === null) return null;
  const selected = await readSelectedHistoryHash(
    env,
    "blocks",
    asHash,
    network,
    budget,
  );
  if (selected !== undefined)
    return selected === null || Array.isArray(selected)
      ? null
      : safeBlockNumber(selected.block_number);
  return null;
}

/**
 * One extrinsic by hash or by the composite `<block>-<index>` id, with the
 * account_events it emitted embedded exactly as the Postgres tier embeds them.
 */
export async function loadExtrinsicColdTier(
  env: R2SqlEnv | null | undefined,
  ref: string,
  /** Network identity of the retained history. */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildExtrinsic> | null> {
  let hashRef: string | null = null;
  const budget = parquetReadBudget();
  // Hoisted out of the branch because the events read below uses them when the
  // ref is composite -- they are the key it would otherwise wait to learn.
  let compositeBlock: number | null = null;
  let compositeIndex: number | null = null;

  const composite = /^(\d+)-(\d+)$/.exec(String(ref).trim());
  if (composite) {
    compositeBlock = safeBlockNumber(composite[1]);
    compositeIndex = safeBlockNumber(composite[2]);
    if (compositeBlock === null || compositeIndex === null) return null;
  } else {
    const hash = safeHexLiteral(ref);
    if (hash === null) return null;
    hashRef = hash;
  }

  const selected =
    compositeBlock !== null
      ? await readSelectedHistoryBlock(
          env,
          "extrinsics",
          compositeBlock,
          network,
          budget,
        )
      : await readSelectedHistoryHash(
          env,
          "extrinsics",
          hashRef!,
          network,
          budget,
        );
  if (selected == null) return null;
  const parsed = ExtrinsicsRowSchema.array().safeParse(
    Array.isArray(selected) ? selected : [selected],
  );
  if (!parsed.success) return null;
  const row = parsed.data.find(
    (row) =>
      compositeIndex === null ||
      safeBlockNumber(row.extrinsic_index) === compositeIndex,
  );
  // A confirmed absence is an ANSWER, and the same schema-stable payload the
  // Postgres tier produces -- not null, which would mean "tier unavailable".
  if (!row) return buildExtrinsic(undefined, ref);

  const block = safeBlockNumber(row.block_number);
  const index = safeBlockNumber(row.extrinsic_index);
  const events =
    block !== null && index !== null
      ? await embeddedEvents(env, block, index, network, budget)
      : [];
  return buildExtrinsic(row, ref, events);
}

/**
 * The account_events this extrinsic emitted, embedded exactly as the Postgres
 * tier embeds them.
 *
 * Events failing is NOT a reason to withhold the extrinsic: the Postgres tier
 * serves an empty event list for pre-migration rows too, so an empty list here
 * is a shape the caller already handles.
 */
async function embeddedEvents(
  env: R2SqlEnv | null | undefined,
  block: number,
  index: number,
  network: ChainNetworkId | undefined,
  budget: ParquetReadBudget,
): Promise<unknown[]> {
  const selected = await readSelectedHistoryBlock(
    env,
    "account_events",
    block,
    network,
    budget,
  );
  if (selected !== undefined) {
    const parsed = AccountEventsRowSchema.array().safeParse(selected);
    if (!parsed.success) return [];
    return parsed.data
      .filter((row) => safeBlockNumber(row.extrinsic_index) === index)
      .sort((a, b) => Number(a.event_index) - Number(b.event_index))
      .slice(0, MAX_EMBEDDED_EVENTS)
      .map(formatAccountEvent)
      .filter(Boolean);
  }
  return [];
}
