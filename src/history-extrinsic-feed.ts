import { z } from "zod";
import {
  HistoryExtrinsicFeedSchema,
  type HistoryExtrinsicFeed,
} from "../schemas-src/artifacts/history-extrinsic-feed.ts";
import {
  checkFeedNode,
  feedOrder,
  iteratePackedFeed,
  type FeedRange,
} from "./history-feed-tree.ts";
import type {
  ParquetRangeSource,
  ParquetReadBudget,
} from "./indexed-parquet.ts";

export interface ExtrinsicFeedSelector extends FeedRange {
  signer?: string;
  module?: string;
  callFunction?: string;
  success?: boolean;
}
const integer = z.number().int().nonnegative();
const record = z.tuple([
  integer.max(0xffffffff),
  integer.max(0xffffffff),
  integer.max(Number.MAX_SAFE_INTEGER),
  z.string().nullable(),
  z.string().nullable(),
  z.string().nullable(),
  z.boolean().nullable(),
  integer.max(0xffffffff),
]);
export interface ExtrinsicFeedPointer {
  token: string;
  generation: string;
  fileId: number;
  sourceIdentity: string;
  row: number;
  filter: {
    block_number: number;
    extrinsic_index: number;
    observed_at: number;
    signer: string | null;
    call_module: string | null;
    call_function: string | null;
    success: boolean | null;
  };
}
const baseKey = (feed: HistoryExtrinsicFeed) =>
  `metagraph/indexed-history/v1/${feed.network}/extrinsics/generations/${feed.generation}/feeds/v1/`;

export function validateExtrinsicFeed(
  input: unknown,
  selected: HistoryExtrinsicFeed["selection"],
): HistoryExtrinsicFeed {
  const feed = HistoryExtrinsicFeedSchema.parse(input);
  const base = baseKey(feed),
    selection = feed.selection;
  if (
    feed.network !== selected.network ||
    feed.generation !== selected.generation ||
    selection.network !== feed.network ||
    selection.generation !== feed.generation ||
    selection.firstBlock !== selected.firstBlock ||
    selection.lastBlock !== selected.lastBlock ||
    selection.firstBlock > selection.lastBlock ||
    selected.table !== "extrinsics" ||
    selection.blockManifest.key !== selected.blockManifest.key ||
    selection.blockManifest.etag !== selected.blockManifest.etag ||
    selection.blockManifest.bytes !== selected.blockManifest.bytes ||
    selection.blockManifest.key !==
      base.replace(/feeds\/v1\/$/, "block-manifest.json") ||
    selection.hashManifest?.key !== selected.hashManifest?.key ||
    selection.hashManifest?.etag !== selected.hashManifest?.etag ||
    selection.hashManifest?.bytes !== selected.hashManifest?.bytes ||
    feed.plan.key !== `${base}plan.json` ||
    feed.plan.bytes > 32 * 1024 * 1024 ||
    feed.entries < feed.rows ||
    feed.entries > feed.rows * 6 ||
    feed.entries !== (feed.root?.rows ?? 0)
  )
    throw new Error("Extrinsic feed generation identity or census mismatch");
  if (feed.root) checkFeedNode(feed.root, { ...feed, base });
  return feed;
}

async function selectorKey(selector: ExtrinsicFeedSelector): Promise<string> {
  for (const value of [selector.signer, selector.module, selector.callFunction])
    if (value !== undefined && !/^[\x20-\x7e]+$/.test(value))
      throw new Error("Invalid extrinsic feed selector");
  const query =
    selector.signer !== undefined
      ? ["signer", selector.signer, null]
      : selector.module !== undefined
        ? ["module", selector.module, selector.callFunction ?? null]
        : selector.callFunction !== undefined
          ? ["function", selector.callFunction, null]
          : selector.success !== undefined
            ? ["success", String(selector.success), null]
            : ["all", "*", null];
  const bytes = new TextEncoder().encode(JSON.stringify(query));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function* iterateExtrinsicFeed(
  source: ParquetRangeSource,
  feed: HistoryExtrinsicFeed,
  selector: ExtrinsicFeedSelector,
  budget: ParquetReadBudget,
): AsyncGenerator<ExtrinsicFeedPointer> {
  const key = await selectorKey(selector);
  const decode = (values: unknown, token: string) => {
    const [
      block_number,
      extrinsic_index,
      observed_at,
      signer,
      call_module,
      call_function,
      success,
      fileId,
    ] = record.parse(values);
    if (
      feedOrder(observed_at, block_number, extrinsic_index) !==
      token.slice(64, 94)
    )
      throw new Error("Extrinsic feed ordering differs from its row");
    return {
      block_number,
      extrinsic_index,
      observed_at,
      signer,
      call_module,
      call_function,
      success,
      fileId,
    };
  };
  for await (const { token, row } of iteratePackedFeed(
    source,
    { ...feed, base: baseKey(feed) },
    selector,
    budget,
    key,
    decode,
  )) {
    // Verify the indexed predicate before applying any remaining intersection.
    const indexed =
      selector.signer !== undefined
        ? row.signer === selector.signer
        : selector.module !== undefined
          ? row.call_module === selector.module &&
            (selector.callFunction === undefined ||
              row.call_function === selector.callFunction)
          : selector.callFunction !== undefined
            ? row.call_function === selector.callFunction
            : selector.success !== undefined
              ? row.success === selector.success
              : true;
    if (!indexed)
      throw new Error("Extrinsic feed row differs from its selector");
    if (
      (selector.signer !== undefined && row.signer !== selector.signer) ||
      (selector.module !== undefined && row.call_module !== selector.module) ||
      (selector.callFunction !== undefined &&
        row.call_function !== selector.callFunction) ||
      (selector.success !== undefined && row.success !== selector.success)
    )
      continue;
    const { fileId, ...filter } = row;
    yield {
      token,
      generation: feed.generation,
      fileId,
      sourceIdentity: token.slice(94, 158),
      row: Number.parseInt(token.slice(158), 16),
      filter,
    };
  }
}

/** Merge retained generations, removing only repeated physical captures. */
export async function extrinsicFeedPage(
  streams: AsyncGenerator<ExtrinsicFeedPointer>[],
  limit: number,
  offset: number,
): Promise<ExtrinsicFeedPointer[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5001 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 5000 ||
    streams.length > 4
  )
    throw new Error("Extrinsic feed page exceeds its budget");
  const rows: ExtrinsicFeedPointer[] = [];
  let previous: string | undefined,
    skipped = 0;
  try {
    const heads = await Promise.all(streams.map((stream) => stream.next()));
    while (true) {
      let index = -1;
      heads.forEach((head, i) => {
        if (
          !head.done &&
          (index < 0 ||
            head.value.token.slice(64) < heads[index].value!.token.slice(64))
        )
          index = i;
      });
      if (index < 0) return rows;
      const item = heads[index].value!,
        identity = item.token.slice(64);
      if (identity !== previous) {
        previous = identity;
        if (skipped++ >= offset) rows.push(item);
        if (rows.length === limit) return rows;
      }
      heads[index] = await streams[index].next();
    }
  } finally {
    await Promise.all(streams.map((stream) => stream.return(undefined)));
  }
}
