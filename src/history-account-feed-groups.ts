import type { HistoryFeedNode } from "../schemas-src/artifacts/history-account-feed.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";
import {
  mergeAccountFeedEntries,
  type IndexedAccountFeedEntry,
} from "./history-account-feed.ts";

/** Sixteen streams retain at most sixteen 256 KiB windows. Charge all fetched
 * bytes to the shared operation budget, including unused read-ahead bytes. */
export function accountFeedReadAhead(
  source: ParquetRangeSource,
  budget: ParquetReadBudget,
) {
  const windows = new Map<
    string,
    { start: number; end: number; bytes: Promise<ArrayBuffer> }
  >();
  return async (
    node: Extract<HistoryFeedNode, { height: 0 }>,
  ): Promise<ArrayBuffer> => {
    const { object, offset, length } = node;
    const key = `${object.key}:${object.etag}:${object.bytes}`;
    let window = windows.get(key);
    if (!window || offset < window.start || offset + length > window.end) {
      const end = Math.min(object.bytes, offset + Math.max(length, 256 * 1024));
      window = {
        start: offset,
        end,
        bytes: Promise.resolve(
          boundedParquetBuffer(source, object, budget).slice(offset, end),
        ),
      };
    }
    windows.delete(key);
    windows.set(key, window);
    if (windows.size > 16) windows.delete(windows.keys().next().value!);
    return (await window.bytes).slice(
      offset - window.start,
      offset - window.start + length,
    );
  };
}

export interface AccountFeedGroup extends Record<string, unknown> {
  event_kind: string | null;
  netuid: number | null;
  event_count: number;
  total_tao: number | null;
  total_alpha: number | null;
  first_block: number;
  last_block: number;
  first_observed: number;
  last_observed: number;
}

/** Consume complete windows without accumulating event rows or applying a
 * pagination cap. SUM keeps SQL's all-null result; count includes every row. */
export async function foldAccountFeedGroups(
  streams: AsyncGenerator<IndexedAccountFeedEntry>[],
): Promise<AccountFeedGroup[]> {
  const groups = new Map<string, AccountFeedGroup>();
  for await (const row of mergeAccountFeedEntries(streams)) {
    const key = JSON.stringify([row.event_kind, row.netuid]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 4096)
        throw new Error("Account feed aggregate group budget exceeded");
      group = {
        event_kind: row.event_kind,
        netuid: row.netuid,
        event_count: 0,
        total_tao: null,
        total_alpha: null,
        first_block: row.block_number!,
        last_block: row.block_number!,
        first_observed: row.observed_at!,
        last_observed: row.observed_at!,
      };
      groups.set(key, group);
    }
    group.event_count++;
    if (row.amount_tao !== null)
      group.total_tao = (group.total_tao ?? 0) + row.amount_tao;
    if (row.alpha_amount !== null)
      group.total_alpha = (group.total_alpha ?? 0) + row.alpha_amount;
    if (
      (group.total_tao !== null && !Number.isFinite(group.total_tao)) ||
      (group.total_alpha !== null && !Number.isFinite(group.total_alpha))
    )
      throw new Error("Account feed aggregate exceeds numeric range");
    group.first_block = Math.min(group.first_block, row.block_number!);
    group.last_block = Math.max(group.last_block, row.block_number!);
    group.first_observed = Math.min(group.first_observed, row.observed_at!);
    group.last_observed = Math.max(group.last_observed, row.observed_at!);
  }
  return [...groups.values()];
}
