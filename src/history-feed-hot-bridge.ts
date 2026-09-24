import { selectedD1Store } from "./d1-store.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import type { FeedRange } from "./history-feed-tree.ts";
import type { AccountFeedSelector } from "./history-account-feed.ts";
import type { ExtrinsicFeedSelector } from "./history-extrinsic-feed.ts";

export interface HotHistoryPredicate {
  text: string;
  values: unknown[];
}

/** Bind every caller value; only the internal column vocabulary enters SQL. */
export function hotHistoryPredicate(
  range: FeedRange,
  index: "event_index" | "extrinsic_index",
  matches: Record<string, unknown>,
): HotHistoryPredicate {
  const clauses = [
    "block_number >= ?",
    "block_number <= ?",
    "observed_at >= ?",
    "observed_at <= ?",
  ];
  const values: unknown[] = [
    range.blockStart ?? 0,
    range.blockEnd ?? 0xffffffff,
    range.observedStart ?? 0,
    range.observedEnd ?? Number.MAX_SAFE_INTEGER,
  ];
  for (const [column, value] of Object.entries(matches)) {
    if (value == null) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  if (range.cursor) {
    clauses.push(`(observed_at, block_number, ${index}) < (?, ?, ?)`);
    values.push(...range.cursor);
  }
  return { text: clauses.join(" AND "), values };
}

export function hotAccountPredicate(
  selectors: readonly AccountFeedSelector[],
): HotHistoryPredicate {
  const predicates = selectors.map((selector) =>
    hotHistoryPredicate(selector, "event_index", {
      ...(selector.side === "all" ? {} : { [selector.side]: selector.account }),
      ...(selector.counterparty === undefined
        ? {}
        : {
            [selector.side === "hotkey" ? "coldkey" : "hotkey"]:
              selector.counterparty,
          }),
      event_kind: selector.kind,
      netuid: selector.netuid,
    }),
  );
  return {
    text: predicates.map((predicate) => `(${predicate.text})`).join(" OR "),
    values: predicates.flatMap((predicate) => predicate.values),
  };
}

export function hotExtrinsicPredicate(selector: ExtrinsicFeedSelector) {
  return hotHistoryPredicate(selector, "extrinsic_index", {
    signer: selector.signer,
    call_module: selector.module,
    call_function: selector.callFunction,
    success: selector.success,
  });
}

/** Read the unindexed tail and its complete block census in ONE SQLite
 * snapshot. The caller brackets this with the uncached source-ceiling reads.
 * A normal decode can advance that ceiling before publishing its index;
 * contiguous hot coverage keeps the existing complete answer available.
 * Testnet cannot borrow mainnet's D1 rows. */
export async function readHotHistoryTail(
  env: unknown,
  table: "account_events" | "extrinsics" | "chain_events",
  through: number,
  last: number,
  network: ChainNetworkId,
  columns: readonly string[],
  predicate: HotHistoryPredicate,
  pageSize?: number,
  groupBy?: readonly string[],
): Promise<Record<string, unknown>[] | undefined> {
  if (last <= through) return [];
  if (network !== "mainnet" || last - through > 32768) return undefined;
  const hotTable = `chain_detail_${table}`;
  const store = selectedD1Store(env, ["chain_detail_blocks", hotTable]);
  if (!store) return undefined;
  const index = table === "extrinsics" ? "extrinsic_index" : "event_index";
  const order =
    table === "chain_events"
      ? `block_number DESC, ${index} DESC`
      : `observed_at DESC, block_number DESC, ${index} DESC`;
  const outerOrder =
    table === "chain_events"
      ? "height DESC, item DESC"
      : "stamp DESC, height DESC, item DESC";
  // Aggregates must consume the whole bounded selection; a page may stop once
  // it has enough candidates. One sentinel row distinguishes those outcomes.
  const maximum = pageSize ?? 50_000;
  const result = await store.query<{
    first: number | null;
    last: number | null;
    rows: number | null;
    record: string | null;
  }>(
    `WITH coverage AS (
       SELECT MIN(block_number) AS first, MAX(block_number) AS last, COUNT(*) AS rows
       FROM chain_detail_blocks WHERE block_number > ? AND block_number <= ?
     ), matching AS (
       SELECT ${groupBy ? `${groupBy.join(",")}, COUNT(*) AS count` : columns.join(",")} FROM ${hotTable}
       WHERE block_number > ? AND block_number <= ? AND (${predicate.text})
       ${groupBy ? `GROUP BY ${groupBy.join(",")} ORDER BY count DESC` : `ORDER BY ${order}`} LIMIT ?
     )
     SELECT 0 AS sequence, first, last, rows, NULL AS record,
       NULL AS stamp, NULL AS height, NULL AS item FROM coverage
     UNION ALL
     SELECT 1, NULL, NULL, NULL, json_object(${columns.map((column) => `'${column}',${column}`).join(",")}),
       ${groupBy ? "NULL, NULL, NULL" : `observed_at, block_number, ${index}`} FROM matching
     ORDER BY sequence, ${outerOrder}`,
    [through, last, through, last, ...predicate.values, maximum + 1],
  );
  const coverage = result.shift();
  if (
    !coverage ||
    coverage.first !== through + 1 ||
    coverage.last !== last ||
    coverage.rows !== last - through ||
    (pageSize === undefined && result.length > maximum)
  )
    return undefined;
  if (
    result.reduce((bytes, item) => bytes + item.record!.length, 0) >
    32 * 1024 * 1024
  )
    throw new Error("Hot history tail exceeds byte budget");
  return result.slice(0, maximum).map((item) => JSON.parse(item.record!));
}

/** D1 stores exact decimal text; the retained catalog exposes numeric cells. */
export function hotHistoryNumbers(
  row: Record<string, unknown>,
  columns: readonly string[],
) {
  const output = { ...row };
  for (const column of columns) {
    const value = row[column];
    if (value !== null) {
      if (
        typeof value !== "number" &&
        (typeof value !== "string" || !value.trim())
      )
        throw new Error("Invalid hot history numeric cell");
      output[column] = Number(value);
    }
  }
  return output;
}
